import { requestJson } from '../../services/api-client.js';

const MAX_PROCESSING_WAIT_MS = 180000;
const PROCESSING_POLL_MS = 2500;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function mediaTypeFor(file) {
  if (!file || typeof file.type !== 'string') return null;
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

export async function uploadAndProcess(file, status) {
  const mediaType = mediaTypeFor(file);
  if (!mediaType) throw new Error('Choose a supported photo, video or audio file.');
  if (status) status.textContent = 'Requesting a secure upload URL…';
  const urlData = await requestJson('/api/media/upload-url', {
    method: 'POST',
    body: { mediaType, mimeType: file.type, byteSize: file.size, filename: file.name }
  });
  if (!urlData.upload || !urlData.upload.url || !urlData.asset || !urlData.asset.id) {
    throw new Error('The media upload URL response was incomplete.');
  }
  if (status) status.textContent = 'Uploading ' + file.name + '…';
  const response = await fetch(urlData.upload.url, {
    method: urlData.upload.method || 'PUT',
    headers: urlData.upload.headers || { 'Content-Type': file.type },
    body: file,
    credentials: 'omit'
  });
  if (!response.ok) throw new Error('Private media upload failed (HTTP ' + response.status + ').');
  if (status) status.textContent = 'Verifying upload and queueing safe media processing…';
  await requestJson('/api/media/' + encodeURIComponent(urlData.asset.id) + '/complete', { method: 'POST', body: {} });
  const deadline = Date.now() + MAX_PROCESSING_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await requestJson('/api/media/' + encodeURIComponent(urlData.asset.id));
    const state = result.asset && result.asset.state || 'unknown';
    if (state === 'ready') return { assetId: urlData.asset.id, mediaType };
    if (state === 'failed' || state === 'quarantined' || state === 'deleted') {
      throw new Error('Media processing ended with state "' + state + '". The file was not published.');
    }
    if (status) status.textContent = 'Server processing media (' + state + ')…';
    await sleep(PROCESSING_POLL_MS);
  }
  throw new Error('Media is still processing on the server. It was uploaded but not published. Check Media status before retrying.');
}
