'use strict';
const { test, ok, eq } = require('../../tools/test-harness');
const livekit = require('../../integrations/livekit');

test('LiveKit webhook verification refuses missing provider credentials', async () => {
  const result = await livekit.verifyWebhook({}, '{"event":"room_started"}', 'Bearer fake');
  ok(!result.ok);
  ok(!result.verified);
  eq(result.code, 'WEBHOOK_NOT_CONFIGURED');
});

test('LiveKit webhook verification rejects unsigned or forged body signatures', async () => {
  const cfg = { apiKey: 'test-key', apiSecret: 'test-secret' };
  const invalid = await livekit.verifyWebhook(cfg, '{"event":"room_started"}', 'Bearer not-a-signed-webhook');
  ok(!invalid.ok);
  ok(!invalid.verified);
  eq(invalid.code, 'LIVEKIT_WEBHOOK_SIGNATURE_INVALID');
});
