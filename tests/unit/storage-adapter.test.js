'use strict';
const { test, ok, eq } = require('../../tools/test-harness');
const storage = require('../../integrations/supabase/storage');
const cfg = { supabase: { url: 'https://test-project.supabase.co', serviceRoleKey: 'test-service-secret' } };
test('storage path encoding rejects traversal and encodes individual path segments', () => {
  eq(storage.encodeObjectPath('profiles/a-1/file name.png'), 'profiles/a-1/file%20name.png');
  let threw = false;
  try { storage.encodeObjectPath('../escape.txt'); } catch (_) { threw = true; }
  ok(threw);
});
test('signed upload requests return a normalized URL without exposing provider credentials', async () => {
  let request;
  const result = await storage.createSignedUploadUrl(cfg, 'zuno-media', 'profiles/u/a.png', async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ url: '/object/upload/sign/zuno-media/profiles/u/a.png?token=one-time-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  ok(result.ok);
  eq(result.uploadUrl, 'https://test-project.supabase.co/storage/v1/object/upload/sign/zuno-media/profiles/u/a.png?token=one-time-token');
  eq(request.options.method, 'POST');
  eq(request.options.headers.Authorization, 'Bearer test-service-secret');
});
test('signed download requests create per-path expiring URLs', async () => {
  const result = await storage.createSignedDownloadUrls(cfg, 'zuno-media', ['profiles/u/file.webp'], 120, async () =>
    new Response(JSON.stringify([{ path: 'profiles/u/file.webp', signedURL: '/object/sign/zuno-media/profiles/u/file.webp?token=read' }]), { status: 200 })
  );
  ok(result.ok);
  eq(result.signedUrls[0].signedUrl, 'https://test-project.supabase.co/storage/v1/object/sign/zuno-media/profiles/u/file.webp?token=read');
});
test('storage readiness refuses calls without a service-role key', async () => {
  const result = await storage.createSignedUploadUrl({ supabase: { url: 'https://test.supabase.co' } }, 'zuno-media', 'profiles/u/a.png');
  eq(result.code, 'STORAGE_NOT_CONFIGURED');
});
