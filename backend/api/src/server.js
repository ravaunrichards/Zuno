'use strict';
/**
 * ZUNO API service (dependency-free Node http so it runs anywhere).
 * Wires config + provider adapters + the economy core. Where a provider is not
 * configured, the matching route returns an explicit 503 rather than faking.
 *
 * Authoritative gift/coin logic uses the double-entry Ledger. In a fully wired
 * deployment the same logic runs inside Postgres (database/functions) behind
 * RLS; this in-process ledger is the development/sandbox fallback and is the
 * SAME invariant set covered by the test suite.
 */
const http = require('http');
const { load, validateRequired } = require('../../../config');
const livekit = require('../../../integrations/livekit');
const { authenticateProfile, selectAdminRows } = require('./auth');
const { loadGifts } = require('../../../packages/gift-engine/src/catalog');

const config = load();
const envCheck = validateRequired(config);
if (!envCheck.ok) console.warn('[config] problems:', envCheck.problems.join('; '));


function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.apiPort}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/catalog/gifts') {
      const gifts = loadGifts();
      const category = url.searchParams.get('category');
      const filtered = category ? gifts.filter((gift) => String(gift.category || '').toLowerCase().includes(category.toLowerCase())) : gifts;
      return json(res, 200, { ok: true, count: filtered.length, gifts: filtered });
    }

    if (req.method === 'GET' && url.pathname === '/api/meta/readiness') {
      return json(res, 200, {
        ok: true,
        integrations: {
          supabase: config.configured.supabase ? 'configured' : 'not_configured',
          livekit: config.configured.livekit ? 'configured' : 'not_configured',
          paypal: config.configured.paypal ? 'configured' : 'not_configured'
        },
        featureFlags: {
          productionPayments: config.features.productionPayments,
          payouts: config.features.payouts,
          liveRecording: config.features.liveRecording
        },
        note: 'Configured means required environment values exist; it does not prove provider authentication or production readiness.'
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', configured: config.configured, ts: new Date().toISOString() });
    }

    // Sensitive routes derive identity from a provider-verified Supabase session.
    if (req.method === 'POST' && url.pathname === '/api/livekit/token') {
      const session = await authenticateProfile(req, config);
      if (!session.ok) return json(res, session.status, { ok: false, code: session.code, message: session.message });
      const body = await readBody(req);
      const roomId = String(body.roomId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
        return json(res, 400, { ok: false, code: 'INVALID_ROOM_ID' });
      }
      const roomParams = new URLSearchParams({ id: 'eq.' + roomId, select: 'id,host_id,state,is_private' });
      const rooms = await selectAdminRows(config, 'live_rooms', roomParams);
      if (!rooms.ok) return json(res, 503, { ok: false, code: rooms.code, message: 'Room authorization data is unavailable.' });
      if (!rooms.rows.length) return json(res, 404, { ok: false, code: 'ROOM_NOT_FOUND' });
      const room = rooms.rows[0];
      const profileId = session.profile.id;
      const host = room.host_id === profileId;
      const participantParams = new URLSearchParams({
        room_id: 'eq.' + roomId,
        profile_id: 'eq.' + profileId,
        left_at: 'is.null',
        select: 'role'
      });
      const participantRows = await selectAdminRows(config, 'live_participants', participantParams);
      if (!participantRows.ok) return json(res, 503, { ok: false, code: participantRows.code });
      const membership = participantRows.rows[0] || null;
      if (room.state === 'ended') return json(res, 409, { ok: false, code: 'ROOM_ENDED' });
      if (room.is_private && !host && !membership) return json(res, 403, { ok: false, code: 'ROOM_ACCESS_DENIED' });
      if (room.state !== 'live' && !host) return json(res, 409, { ok: false, code: 'ROOM_NOT_LIVE' });

      const canPublish = host || Boolean(membership && membership.role === 'guest');
      if (canPublish && !host && membership && membership.role === 'guest') {
        const activeParams = new URLSearchParams({ room_id: 'eq.' + roomId, left_at: 'is.null', select: 'profile_id,role' });
        const active = await selectAdminRows(config, 'live_participants', activeParams);
        if (!active.ok) return json(res, 503, { ok: false, code: active.code });
        const publisherIds = new Set(active.rows.filter((row) => row.role === 'host' || row.role === 'guest').map((row) => row.profile_id));
        publisherIds.add(room.host_id);
        if (publisherIds.size > 8) return json(res, 409, { ok: false, code: 'PUBLISHER_CAPACITY_EXCEEDED' });
      }
      const ttlSeconds = Number.isInteger(body.ttlSeconds) ? Math.max(60, Math.min(3600, body.ttlSeconds)) : 900;
      const out = livekit.mintToken(config.livekit, { identity: profileId, room: room.id, canPublish, ttlSeconds });
      return json(res, out.ok ? 200 : out.status || 500, out);
    }

    // These operations stay disabled rather than use an in-process demo ledger or
    // create an untracked payment order that could be mistaken for a settled transaction.
    if (req.method === 'POST' && url.pathname === '/api/gifts/send') {
      const session = await authenticateProfile(req, config);
      if (!session.ok) return json(res, session.status, { ok: false, code: session.code, message: session.message });
      return json(res, 503, { ok: false, code: 'PERSISTENT_GIFT_DELIVERY_NOT_READY',
        message: 'Gift delivery is disabled until the persistent database transaction and delivery record are connected. No wallet balance was changed.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/payments/order') {
      const session = await authenticateProfile(req, config);
      if (!session.ok) return json(res, session.status, { ok: false, code: session.code, message: session.message });
      return json(res, 503, { ok: false, code: 'PAYMENT_WORKFLOW_NOT_READY',
        message: 'Checkout is disabled until persistent order storage, capture verification, signed webhooks, idempotent coin credit, refunds and reconciliation are connected. No payment was created.' });
    }

    return json(res, 404, { ok: false, code: 'NOT_FOUND' });
  } catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return json(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: e.message });
  }
});

if (require.main === module) {
  server.listen(config.apiPort, '0.0.0.0', () => console.log(`ZUNO API listening on port ${config.apiPort}`));
}
module.exports = { server, config };
