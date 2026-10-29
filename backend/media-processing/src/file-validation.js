'use strict';

const fs = require('node:fs/promises');

const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/avif',
  'video/mp4','video/webm',
  'audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/opus'
]);
const DEFAULT_LIMITS = {
  image: 20 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  audio: 100 * 1024 * 1024
};
const MIME_TO_MEDIA_TYPE = Object.freeze({
  'image/jpeg':'image','image/png':'image','image/webp':'image','image/avif':'image',
  'video/mp4':'video','video/webm':'video',
  'audio/mpeg':'audio','audio/mp4':'audio','audio/wav':'audio','audio/ogg':'audio','audio/opus':'audio'
});
const MIME_TO_EXTENSION = Object.freeze({
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif',
  'video/mp4':'mp4','video/webm':'webm',
  'audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/ogg':'ogg','audio/opus':'opus'
});

function validateUploadMetadata(input, limits = DEFAULT_LIMITS) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['INVALID_METADATA'] };
  const mediaType = String(input.mediaType || '');
  const mimeType = String(input.mimeType || '').trim().toLowerCase();
  const byteSize = Number(input.byteSize);
  const filename = String(input.filename || '').normalize('NFKC');

  if (!Object.prototype.hasOwnProperty.call(limits, mediaType)) errors.push('UNSUPPORTED_MEDIA_TYPE');
  if (!ALLOWED_MIME.has(mimeType)) errors.push('UNSUPPORTED_MIME_TYPE');
  if (MIME_TO_MEDIA_TYPE[mimeType] && MIME_TO_MEDIA_TYPE[mimeType] !== mediaType) errors.push('MEDIA_TYPE_MIME_MISMATCH');
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) errors.push('INVALID_FILE_SIZE');
  else if (limits[mediaType] && byteSize > limits[mediaType]) errors.push('FILE_TOO_LARGE');
  if (!filename || filename.length > 180 || /[\x00-\x1f\\/]/.test(filename) || filename === '.' || filename === '..') errors.push('INVALID_FILENAME');
  if (input.checksumSha256 !== undefined && input.checksumSha256 !== null &&
      !/^[a-f0-9]{64}$/i.test(String(input.checksumSha256))) errors.push('INVALID_CHECKSUM');
  return {
    ok: errors.length === 0,
    errors,
    metadata: errors.length ? null : {
      mediaType, mimeType, byteSize, filename,
      checksumSha256: input.checksumSha256 ? String(input.checksumSha256).toLowerCase() : null
    }
  };
}

function signatureCompatible(mimeType, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return false;
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === 'image/webp') return bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (mime === 'image/avif') return bytes.toString('ascii',4,8) === 'ftyp' && ['avif','avis'].includes(bytes.toString('ascii',8,12));
  if (mime === 'video/mp4') return bytes.toString('ascii',4,8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if (mime === 'audio/mpeg') return bytes.toString('ascii',0,3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mime === 'audio/mp4') return bytes.toString('ascii',4,8) === 'ftyp';
  if (mime === 'audio/wav') return bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WAVE';
  if (mime === 'audio/ogg') return bytes.toString('ascii',0,4) === 'OggS';
  if (mime === 'audio/opus') return bytes.toString('ascii',0,4) === 'OggS' || bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  return false;
}

async function checkFileSignature(filePath, mimeType) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(32);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    return { ok: signatureCompatible(mimeType, buffer.subarray(0, read.bytesRead)), actualBytesRead: read.bytesRead };
  } catch (_) {
    return { ok: false, actualBytesRead: 0, code: 'FILE_READ_FAILED' };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = {
  ALLOWED_MIME, DEFAULT_LIMITS, MIME_TO_MEDIA_TYPE, MIME_TO_EXTENSION,
  validateUploadMetadata, signatureCompatible, checkFileSignature
};
