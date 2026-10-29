'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { load } = require('../../../config');
const { adminRest, adminRpc } = require('../../api/src/auth');
const storage = require('../../../integrations/supabase/storage');
const { DEFAULT_LIMITS, checkFileSignature } = require('./file-validation');

const execFileAsync = promisify(execFile);
const config = load();
const workerId = String(process.env.WORKER_ID || 'zuno-media-' + process.pid).slice(0, 100);
const pollDelayMs = Math.max(500, Math.min(10000, Number(process.env.WORKER_POLL_MS || 1500)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let stopping = false;

function query(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) params.set(key, String(value));
  return params;
}
function safeCode(value) {
  return String(value || 'MEDIA_PROCESSING_FAILED').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 100);
}
function safeStorageSource(profileId, storagePath) {
  if (!UUID.test(profileId) || typeof storagePath !== 'string') return false;
  if (storagePath.startsWith('/') || storagePath.includes('\\')) return false;
  const segments = storagePath.split('/');
  return segments.length === 3 &&
    segments[0] === 'profiles' && segments[1].toLowerCase() === profileId.toLowerCase() &&
    segments.every((part) => part && part !== '.' && part !== '..' && !/[\x00-\x1f]/.test(part));
}
function buildTranscodeArgs(inputPath, outputPath, mediaType) {
  const base = ['-hide_banner','-nostdin','-v','error','-protocol_whitelist','file,pipe,crypto,data','-i',inputPath,'-map_metadata','-1'];
  if (mediaType === 'image') {
    return [...base,'-frames:v','1','-an','-vf','scale=3840:3840:force_original_aspect_ratio=decrease','-c:v','libwebp','-quality','88','-y',outputPath];
  }
  if (mediaType === 'video') {
    return [...base,'-map','0:v:0','-map','0:a?','-vf','scale=1920:1920:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-preset','veryfast','-crf','24','-c:a','aac','-b:a','128k','-movflags','+faststart','-y',outputPath];
  }
  if (mediaType === 'audio') {
    return [...base,'-vn','-c:a','aac','-b:a','192k','-movflags','+faststart','-y',outputPath];
  }
  throw new Error('MEDIA_TYPE_UNSUPPORTED');
}
async function probe(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v','error','-protocol_whitelist','file,pipe,crypto,data',
    '-show_entries','stream=codec_type,width,height,duration',
    '-show_entries','format=duration',
    '-of','json',filePath
  ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  let data;
  try { data = JSON.parse(stdout); } catch (_) { throw new Error('MEDIA_PROBE_INVALID'); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const formatDuration = Number(data.format && data.format.duration);
  const videoStream = streams.find((stream) => stream.codec_type === 'video') || null;
  const audioStream = streams.find((stream) => stream.codec_type === 'audio') || null;
  const duration = Number.isFinite(formatDuration) && formatDuration >= 0
    ? formatDuration
    : Number(videoStream && videoStream.duration) || Number(audioStream && audioStream.duration) || null;
  return {
    streams,
    width: videoStream && Number.isFinite(Number(videoStream.width)) ? Number(videoStream.width) : null,
    height: videoStream && Number.isFinite(Number(videoStream.height)) ? Number(videoStream.height) : null,
    durationSeconds: duration
  };
}
async function checksum(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}
async function updateAsset(asset, patch) {
  const response = await adminRest(config, 'media_assets', query({ id: 'eq.' + asset.id, uploader_id: 'eq.' + asset.uploader_id }), 'PATCH', patch);
  if (!response.ok || !Array.isArray(response.data) || !response.data.length) throw new Error('MEDIA_ASSET_UPDATE_FAILED');
  return response.data[0];
}
async function markQuarantined(asset, reasonCode) {
  await updateAsset(asset, {
    state: 'quarantined',
    updated_at: new Date().toISOString(),
    metadata: { ...(asset.metadata || {}), quarantineReason: safeCode(reasonCode), quarantinedAt: new Date().toISOString() }
  });
}
async function markFailed(asset, reasonCode) {
  await updateAsset(asset, {
    state: 'failed',
    updated_at: new Date().toISOString(),
    metadata: { ...(asset.metadata || {}), lastProcessingError: safeCode(reasonCode), lastProcessingFailureAt: new Date().toISOString() }
  }).catch(() => {});
}
async function finishJob(job) {
  const result = await adminRpc(config, 'finish_background_job', { p_job_id: job.id, p_worker: workerId });
  if (!result.ok || result.data !== true) throw new Error('JOB_FINISH_FAILED');
}
async function failJob(job, errorCode, asset) {
  const result = await adminRpc(config, 'fail_background_job', {
    p_job_id: job.id, p_worker: workerId, p_error_code: safeCode(errorCode)
  });
  if (!result.ok) throw new Error('JOB_FAILURE_RECORD_FAILED');
  const state = typeof result.data === 'string' ? result.data : Array.isArray(result.data) ? result.data[0] : result.data && (result.data.fail_background_job || result.data.state);
  if (state === 'dead_letter' && asset) await markFailed(asset, errorCode);
  return state;
}

async function processMedia(job) {
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const assetId = String(payload.mediaAssetId || '');
  const profileId = String(payload.profileId || '');
  if (!UUID.test(assetId) || !UUID.test(profileId)) throw new Error('MEDIA_JOB_PAYLOAD_INVALID');
  if (payload.bucket !== config.storageBucket) throw new Error('MEDIA_BUCKET_MISMATCH');

  const selected = await adminRest(config, 'media_assets', query({
    select: 'id,uploader_id,post_id,storage_path,media_type,mime_type,byte_size,checksum_sha256,state,width,height,duration_ms,metadata',
    id: 'eq.' + assetId, uploader_id: 'eq.' + profileId, limit: '1'
  }));
  if (!selected.ok || !Array.isArray(selected.data) || !selected.data.length) throw new Error('MEDIA_ASSET_NOT_FOUND');
  const asset = selected.data[0];
  if (asset.state === 'ready') return { asset, finalState: 'ready' };
  if (asset.state !== 'processing') throw new Error('MEDIA_ASSET_NOT_PROCESSING');
  if (!safeStorageSource(profileId, asset.storage_path) || asset.storage_path !== payload.storagePath) {
    await markQuarantined(asset, 'MEDIA_STORAGE_PATH_MISMATCH');
    return { asset, finalState: 'quarantined' };
  }
  const maxBytes = DEFAULT_LIMITS[asset.media_type];
  if (!maxBytes || Number(asset.byte_size) <= 0 || Number(asset.byte_size) > maxBytes) {
    await markQuarantined(asset, 'MEDIA_SIZE_LIMIT');
    return { asset, finalState: 'quarantined' };
  }

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'zuno-media-'));
  const inputPath = path.join(workspace, 'source.bin');
  const outputExtension = asset.media_type === 'image' ? 'webp' : asset.media_type === 'video' ? 'mp4' : 'm4a';
  const outputPath = path.join(workspace, 'processed.' + outputExtension);
  try {
    const download = await storage.downloadObjectToFile(config, payload.bucket, asset.storage_path, inputPath, maxBytes);
    if (!download.ok) throw new Error(download.code || 'MEDIA_DOWNLOAD_FAILED');
    if (download.byteSize !== Number(asset.byte_size)) {
      await markQuarantined(asset, 'MEDIA_SIZE_MISMATCH');
      return { asset, finalState: 'quarantined' };
    }
    const signature = await checkFileSignature(inputPath, asset.mime_type);
    if (!signature.ok) {
      await markQuarantined(asset, 'MEDIA_SIGNATURE_MISMATCH');
      return { asset, finalState: 'quarantined' };
    }
    if (asset.checksum_sha256) {
      const sourceChecksum = await checksum(inputPath);
      if (sourceChecksum.toLowerCase() !== String(asset.checksum_sha256).toLowerCase()) {
        await markQuarantined(asset, 'MEDIA_CHECKSUM_MISMATCH');
        return { asset, finalState: 'quarantined' };
      }
    }

    let sourceMeta;
    try { sourceMeta = await probe(inputPath); }
    catch (_) {
      await markQuarantined(asset, 'MEDIA_PROBE_FAILED');
      return { asset, finalState: 'quarantined' };
    }
    const expectedStream = asset.media_type === 'image' || asset.media_type === 'video' ? 'video' : 'audio';
    if (!sourceMeta.streams.some((stream) => stream.codec_type === expectedStream)) {
      await markQuarantined(asset, 'MEDIA_STREAM_TYPE_MISMATCH');
      return { asset, finalState: 'quarantined' };
    }
    if (asset.media_type !== 'image' && (!Number.isFinite(sourceMeta.durationSeconds) || sourceMeta.durationSeconds <= 0 || sourceMeta.durationSeconds > 4 * 60 * 60)) {
      await markQuarantined(asset, 'MEDIA_DURATION_INVALID');
      return { asset, finalState: 'quarantined' };
    }
    if (sourceMeta.width && sourceMeta.width > 30000 || sourceMeta.height && sourceMeta.height > 30000) {
      await markQuarantined(asset, 'MEDIA_DIMENSIONS_INVALID');
      return { asset, finalState: 'quarantined' };
    }

    const args = buildTranscodeArgs(inputPath, outputPath, asset.media_type);
    try { await execFileAsync('ffmpeg', args, { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (_) { throw new Error('MEDIA_TRANSCODE_FAILED'); }
    const outputStat = await fsp.stat(outputPath);
    if (!outputStat.isFile() || outputStat.size <= 0 || outputStat.size > maxBytes) throw new Error('MEDIA_OUTPUT_SIZE_INVALID');
    let outputMeta;
    try { outputMeta = await probe(outputPath); }
    catch (_) { throw new Error('MEDIA_OUTPUT_PROBE_FAILED'); }
    const outputMime = asset.media_type === 'image' ? 'image/webp' : asset.media_type === 'video' ? 'video/mp4' : 'audio/mp4';
    const outputPathInStorage = 'profiles/' + profileId + '/processed/' + assetId + '.' + outputExtension;
    const upload = await storage.uploadObjectFromFile(config, payload.bucket, outputPathInStorage, outputPath, outputMime);
    if (!upload.ok) throw new Error(upload.code || 'MEDIA_DERIVATIVE_UPLOAD_FAILED');
    const outputChecksum = await checksum(outputPath);
    const metadata = {
      ...(asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {}),
      sourceObjectPath: asset.storage_path,
      sourceObjectRetained: true,
      pipelineVersion: 'zuno-media-v1',
      processedAt: new Date().toISOString(),
      outputChecksumSha256: outputChecksum,
      originalMimeType: asset.mime_type,
      originalByteSize: Number(asset.byte_size),
      width: outputMeta.width,
      height: outputMeta.height,
      durationSeconds: outputMeta.durationSeconds
    };
    await updateAsset(asset, {
      storage_path: outputPathInStorage,
      mime_type: outputMime,
      byte_size: outputStat.size,
      checksum_sha256: outputChecksum,
      width: outputMeta.width,
      height: outputMeta.height,
      duration_ms: outputMeta.durationSeconds === null ? null : Math.max(0, Math.round(outputMeta.durationSeconds * 1000)),
      metadata,
      state: 'ready',
      updated_at: new Date().toISOString()
    });
    return { asset, finalState: 'ready' };
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function claimJob() {
  const result = await adminRpc(config, 'claim_background_job', {
    p_worker: workerId,
    p_queues: ['media']
  });
  if (!result.ok) throw new Error('JOB_CLAIM_UNAVAILABLE');
  if (!Array.isArray(result.data)) return null;
  return result.data[0] || null;
}

async function pollOnce() {
  const job = await claimJob();
  if (!job) return false;
  let asset = null;
  if (job.payload && job.payload.mediaAssetId && UUID.test(String(job.payload.mediaAssetId))) {
    const found = await adminRest(config, 'media_assets', query({
      select: 'id,uploader_id,storage_path,media_type,mime_type,byte_size,checksum_sha256,state,metadata',
      id: 'eq.' + job.payload.mediaAssetId, limit: '1'
    }));
    asset = found.ok && Array.isArray(found.data) ? found.data[0] || null : null;
  }
  try {
    const result = await processMedia(job);
    await finishJob(job);
    console.log(JSON.stringify({ event:'media_job_completed', jobId:job.id, assetId:result.asset.id, state:result.finalState }));
  } catch (error) {
    const code = safeCode(error && error.message || 'MEDIA_PROCESSING_FAILED');
    try {
      const state = await failJob(job, code, asset);
      console.error(JSON.stringify({ event:'media_job_failed', jobId:job.id, assetId:asset && asset.id || null, errorCode:code, nextState:state }));
    } catch (_) {
      console.error(JSON.stringify({ event:'media_job_failure_record_failed', jobId:job.id, errorCode:code }));
    }
  }
  return true;
}

async function main() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.error('Media worker is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ event:'media_worker_started', workerId, pollDelayMs }));
  while (!stopping) {
    let didWork = false;
    try { didWork = await pollOnce(); }
    catch (_) { console.error(JSON.stringify({ event:'media_worker_poll_failed', errorCode:'MEDIA_WORKER_PROVIDER_UNAVAILABLE' })); }
    if (!didWork && !stopping) await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
  }
  console.log(JSON.stringify({ event:'media_worker_stopped', workerId }));
}
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

if (require.main === module) {
  main().catch((error) => { console.error(JSON.stringify({ event:'media_worker_fatal', errorCode:safeCode(error && error.message) })); process.exitCode = 1; });
}
module.exports = { safeStorageSource, buildTranscodeArgs, probe, checksum, processMedia, pollOnce };
