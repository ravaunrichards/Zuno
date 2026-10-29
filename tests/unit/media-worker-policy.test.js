'use strict';
const { test, ok, eq } = require('../../tools/test-harness');
const { safeStorageSource, buildTranscodeArgs } = require('../../backend/media-processing/src/worker');
test('media worker accepts only owner-scoped original asset paths', () => {
  const owner='10000000-0000-4000-8000-000000000001';
  ok(safeStorageSource(owner,'profiles/'+owner+'/asset.mp4'));
  ok(!safeStorageSource(owner,'profiles/other/asset.mp4'));
  ok(!safeStorageSource(owner,'profiles/'+owner+'/../asset.mp4'));
  ok(!safeStorageSource(owner,'https://evil.invalid/payload.mp4'));
});
test('transcode arguments disable remote protocols and strip metadata', () => {
  for (const kind of ['image','video','audio']) {
    const args=buildTranscodeArgs('/tmp/input.bin','/tmp/output.'+(kind==='image'?'webp':kind==='video'?'mp4':'m4a'),kind);
    ok(args.includes('-protocol_whitelist'));
    ok(args.includes('-map_metadata'));
    ok(args.includes('-y'));
  }
  eq(buildTranscodeArgs('/tmp/a','/tmp/b','video').includes('libx264'),true);
});
