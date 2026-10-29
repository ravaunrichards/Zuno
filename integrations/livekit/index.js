'use strict';
/**
 * LiveKit provider adapter. Token minting happens SERVER-SIDE only; the API
 * secret is never sent to clients. When credentials are absent the adapter
 * returns an explicit 503 (LIVE_NOT_CONFIGURED) rather than faking a token.
 *
 * Real token signing uses the LiveKit JWT (HS256 over the API secret). We
 * implement the signing with Node's built-in crypto so the code is real and
 * runnable without the SDK; swap in `livekit-server-sdk` in production if
 * preferred.
 */
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function notConfigured() {
  return { ok: false, status: 503, code: 'LIVE_NOT_CONFIGURED',
    message: 'LiveKit credentials are not set. Provide LIVEKIT_URL/API_KEY/API_SECRET.' };
}

/**
 * Mint an expiring access token for a participant in a room.
 * @param {object} cfg config.livekit
 * @param {object} grant { identity, room, canPublish, canSubscribe, ttlSeconds }
 */
function mintToken(cfg, grant) {
  if (!cfg || !cfg.apiKey || !cfg.apiSecret) return notConfigured();
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(grant.ttlSeconds || 3600, 6 * 3600);
  const payload = {
    iss: cfg.apiKey,
    sub: grant.identity,
    nbf: now,
    exp: now + ttl,
    jti: crypto.randomUUID(),
    video: {
      room: grant.room,
      roomJoin: true,
      canPublish: Boolean(grant.canPublish),
      canSubscribe: grant.canSubscribe !== false,
      canPublishData: true,
    },
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', cfg.apiSecret).update(signingInput).digest();
  return { ok: true, token: `${signingInput}.${b64url(sig)}`, expiresAt: payload.exp, url: cfg.url };
}

/** Verify a LiveKit webhook signature. Returns false when key is absent (never trusts unsigned). */
function verifyWebhook(cfg, rawBody, authHeader) {
  if (!cfg || !cfg.webhookKey) return false;
  if (!authHeader) return false;
  const expected = crypto.createHmac('sha256', cfg.webhookKey).update(rawBody).digest('hex');
  // constant-time compare
  const a = Buffer.from(expected);
  const b = Buffer.from(String(authHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { mintToken, verifyWebhook, notConfigured };
