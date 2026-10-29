'use strict';
const { test, ok, eq } = require('../../tools/test-harness');
const { validateUploadMetadata, signatureCompatible, MIME_TO_EXTENSION } = require('../../backend/media-processing/src/file-validation');
test('metadata validation enforces type, MIME, byte limits and safe filenames', () => {
  ok(validateUploadMetadata({ mediaType:'image', mimeType:'image/png', byteSize:30, filename:'photo.png' }).ok);
  ok(!validateUploadMetadata({ mediaType:'video', mimeType:'image/png', byteSize:30, filename:'photo.png' }).ok);
  ok(!validateUploadMetadata({ mediaType:'image', mimeType:'image/png', byteSize:99999999, filename:'photo.png' }).ok);
  ok(!validateUploadMetadata({ mediaType:'image', mimeType:'image/png', byteSize:30, filename:'../secret.png' }).ok);
  ok(!validateUploadMetadata({ mediaType:'image', mimeType:'image/png', byteSize:30, filename:'photo.png', checksumSha256:'bad' }).ok);
});
test('file signatures reject HTML disguised as media and accept known container headers', () => {
  ok(signatureCompatible('image/png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])));
  ok(signatureCompatible('video/mp4', Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d])));
  ok(signatureCompatible('audio/wav', Buffer.from('RIFF0000WAVEfmt ')));
  ok(!signatureCompatible('image/png', Buffer.from('<html>')));
  eq(MIME_TO_EXTENSION['image/webp'], 'webp');
});
