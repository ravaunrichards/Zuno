'use strict';
/** Media helpers: server-side validation of uploads (never trust the file
 *  extension) and a transcode-plan builder consumed by backend/media-processing. */
const MAGIC = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'audio/wav': [0x52, 0x49, 0x46, 0x46],
  'video/mp4': null, // mp4 ftyp box checked separately
};
function sniffType(buf) {
  for (const [type, sig] of Object.entries(MAGIC)) {
    if (!sig) continue;
    if (sig.every((b, i) => buf[i] === b)) return type;
  }
  if (buf.length > 11 && buf.slice(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return 'application/octet-stream';
}
function validateUpload(buf, declaredType, maxBytes) {
  if (buf.length > maxBytes) return { ok: false, code: 'TOO_LARGE' };
  const actual = sniffType(buf);
  if (declaredType && actual !== declaredType) return { ok: false, code: 'TYPE_MISMATCH', actual };
  return { ok: true, type: actual };
}
function transcodePlan(type) {
  if (type.startsWith('video/')) return [{ step: 'transcode', to: 'h264/aac', variants: ['720p', '480p'] }, { step: 'thumbnail' }];
  if (type.startsWith('audio/')) return [{ step: 'normalize', lufs: -14 }, { step: 'transcode', to: 'aac' }];
  if (type.startsWith('image/')) return [{ step: 'resize', sizes: [1080, 480] }];
  return [];
}
module.exports = { sniffType, validateUpload, transcodePlan };
