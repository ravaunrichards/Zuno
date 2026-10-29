'use strict';
const { test, eq, ok } = require('../../tools/test-harness');
const { LiveRoom, MAX_PARTICIPANTS } = require('../../backend/realtime/src/guest-requests');
const livekit = require('../../integrations/livekit');

test('guest request -> accept issues token only after host approval', () => {
  const room = new LiveRoom('r1', 'host1');
  eq(room.requestGuest('v1').state, 'pending', 'pending after request');
  const bad = room.accept('someone', 'v1');
  eq(bad.code, 'NOT_HOST', 'only host accepts');
  const good = room.accept('host1', 'v1');
  ok(good.ok && good.issueToken, 'accepted, token issued');
  eq(room.participants.get('v1'), 'guest', 'now a guest');
});

test('reject and expiry are honored', () => {
  const room = new LiveRoom('r2', 'host1');
  room.requestGuest('v1');
  eq(room.reject('host1', 'v1').state, 'rejected', 'rejected');
  const room2 = new LiveRoom('r3', 'host1');
  const past = Date.now() - 10 * 60 * 1000;
  room2.requestGuest('v2', past);
  eq(room2.accept('host1', 'v2').code, 'EXPIRED', 'expired request cannot be accepted');
});

test('room enforces max 8 participants', () => {
  const room = new LiveRoom('r4', 'host1');
  for (let i = 0; i < MAX_PARTICIPANTS - 1; i++) { room.requestGuest('g' + i); room.accept('host1', 'g' + i); }
  room.requestGuest('overflow');
  eq(room.accept('host1', 'overflow').code, 'ROOM_FULL', 'blocked at capacity');
});

test('livekit adapter returns 503 when not configured, never a fake token', () => {
  const out = livekit.mintToken({ apiKey: '', apiSecret: '' }, { identity: 'u', room: 'r' });
  eq(out.ok, false, 'not ok'); eq(out.code, 'LIVE_NOT_CONFIGURED', 'explicit 503');
});

test('livekit adapter mints a real signed JWT when configured', () => {
  const out = livekit.mintToken({ apiKey: 'devkey', apiSecret: 'devsecret', url: 'wss://x' }, { identity: 'u', room: 'r', canPublish: true });
  ok(out.ok, 'ok'); ok(out.token.split('.').length === 3, 'three-part JWT'); ok(out.expiresAt > 0, 'expiry set');
});

test('livekit webhook verification rejects unsigned payloads', async () => {
  const noHeader = await livekit.verifyWebhook({ apiKey: 'devkey', apiSecret: 'devsecret' }, '{}', '');
  ok(!noHeader.ok && !noHeader.verified, 'no header rejected');
  const noKey = await livekit.verifyWebhook({}, '{}', 'sig');
  ok(!noKey.ok && !noKey.verified, 'no API credentials rejected');
});
