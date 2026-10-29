'use strict';
/**
 * ZUNO HTTP API.
 * User data reads/writes use a provider-verified Supabase JWT and the PostgREST
 * anon key so database RLS remains active. Privileged reads are narrowly
 * allowlisted and used only where the route applies its own authorization.
 * Financial mutations remain disabled until the persistent, reconciled
 * provider transaction is complete.
 */
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { load, validateRequired } = require('../../../config');
const livekit = require('../../../integrations/livekit');
const paypal = require('../../../integrations/paypal');
const { rankCandidates } = require('../../recommendations/src/scoring');
const { monthlyPeriodStart, weeklyPeriodStart } = require('../../../packages/gift-engine/src/rankings');
const { authenticateProfile, userRest, adminRest, adminRpc, selectAdminRows, profileProjection } = require('./auth');
const storage = require('../../../integrations/supabase/storage');
const { validateUploadMetadata, MIME_TO_EXTENSION } = require('../../media-processing/src/file-validation');

const config = load();
const envCheck = validateRequired(config);
if (!envCheck.ok) console.warn('[config] problems:', envCheck.problems.join('; '));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POST_KINDS = new Set(['short_video','long_video','photo','gallery','text','audio','story']);
const AUDIENCES = new Set(['public','followers','private']);
const PROFILE_FIELDS = new Set(['display_name','bio','avatar_url','cover_url','visibility']);

const DIRECT_TABLE_LIMIT = 100;
const MAX_REQUEST_BYTES = 1_000_000;

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders
  });
  res.end(data);
}
function error(res, status, code, message) {
  return json(res, status, { ok: false, code, ...(message ? { message } : {}) });
}
function badDatabase(res, result, fallback = 'DATA_UNAVAILABLE') {
  const status = [400,401,403,404,409,413,422].includes(result.status) ? result.status : 503;
  return error(res, status, result.code || fallback, status === 503 ? 'The data service is not available for this operation.' : 'The request could not be completed.');
}
function query(params) {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) output.set(key, String(value));
  }
  return output;
}
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function asSafeInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const u = new URL(value); return u.protocol === 'https:'; } catch (_) { return false; }
}
function readBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}
function profileIdIn(ids) {
  const clean = [...new Set(ids.filter(uuid))];
  return clean.length ? 'in.(' + clean.join(',') + ')' : 'in.(00000000-0000-4000-8000-000000000000)';
}
function safeRoom(room, host) {
  return {
    id: room.id, title: room.title || 'LIVE room', category: room.category || 'General',
    state: room.state, startedAt: room.started_at || null,
    host: host ? { id: host.id, username: host.username, displayName: host.display_name || host.username, avatarUrl: host.avatar_url || null, isVerified: Boolean(host.is_verified) } : null
  };
}
async function requireSession(req, res) {
  const session = await authenticateProfile(req, config);
  if (!session.ok) error(res, session.status, session.code, session.message);
  return session;
}
async function rowsForUser(session, table, values, options = {}) {
  return userRest(config, session, table, query(values), options.method || 'GET', options.body ?? null);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return { allowed: true, hasOrigin: false };
  const localDevelopment = config.nodeEnv !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allowed = localDevelopment || config.corsAllowedOrigins.includes(origin);
  if (!allowed) return { allowed: false, hasOrigin: true };
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,apikey,x-client-info');
  res.setHeader('Access-Control-Max-Age', '600');
  return { allowed: true, hasOrigin: true };
}

const server = http.createServer(async (req, res) => {
  const cors = applyCors(req, res);
  if (!cors.allowed) return error(res, 403, 'CORS_ORIGIN_NOT_ALLOWED');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': req.headers.origin || '', 'Vary': 'Origin' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost:' + config.apiPort);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', configured: config.configured, ts: new Date().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/api/meta/readiness') {
      return json(res, 200, {
        ok: true,
        integrations: {
          supabase: config.configured.supabase ? 'configured' : 'not_configured',
          livekit: config.configured.livekit ? 'configured' : 'not_configured',
          paypal: config.configured.paypal ? 'configured' : 'not_configured'
        },
        featureFlags: { productionPayments: config.features.productionPayments, payouts: config.features.payouts, liveRecording: config.features.liveRecording },
        note: 'Configured means required environment values exist; it does not prove authentication, provider transactions or production readiness.'
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/meta/public-config') {
      return json(res, 200, {
        ok: true,
        supabaseUrl: config.supabase.url || null,
        supabaseAnonKey: config.supabase.anonKey || null,
        apiBaseUrl: config.apiPublicBaseUrl || ''
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/payments/packages') {
      const result = await selectAdminRows(config, 'coin_packages', query({
        select: 'id,coins,amount_usd,sort_order', enabled: 'eq.true', order: 'sort_order.asc'
      }));
      if (!result.ok) return error(res, 503, 'COIN_PACKAGES_UNAVAILABLE', 'Recharge packages are not available from the database.');
      return json(res, 200, {
        ok: true,
        currency: 'USD',
        packages: result.rows.map((item) => ({
          id: item.id, coins: Number(item.coins), amountUSD: Number(item.amount_usd), sortOrder: Number(item.sort_order)
        })),
        custom: { minimumUSD: 0.99, maximumUSD: 999.99, coinsPerUSD: 60 },
        note: 'Coin credit is granted only after a provider-confirmed capture is verified and reconciled.'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/payments/paypal/webhook') {
      const body = await readBody(req, MAX_REQUEST_BYTES);
      if (!body || typeof body !== 'object' || typeof body.id !== 'string' || typeof body.event_type !== 'string') {
        return error(res, 400, 'INVALID_WEBHOOK_PAYLOAD');
      }
      const verified = await paypal.verifyWebhook(config.paypal, req.headers, body).catch(() => ({ ok: false, verified: false, code: 'WEBHOOK_VERIFICATION_UNAVAILABLE' }));
      if (!(verified.ok && verified.verified)) {
        const priorAttempts = await selectAdminRows(config, 'provider_webhook_attempts', query({
          select: 'attempt_number', provider: 'eq.paypal', provider_event_id: 'eq.' + body.id,
          order: 'attempt_number.desc', limit: '1'
        }));
        const attemptNumber = priorAttempts.ok && priorAttempts.rows[0] ? Number(priorAttempts.rows[0].attempt_number) + 1 : 1;
        await adminRest(config, 'provider_webhook_attempts', new URLSearchParams(), 'POST', {
          provider: 'paypal', provider_event_id: body.id, attempt_number: attemptNumber,
          state: 'signature_failed', error_code: verified.code || 'WEBHOOK_SIGNATURE_INVALID'
        });
        return error(res, 400, 'WEBHOOK_SIGNATURE_INVALID');
      }
      const eventRow = {
        provider: 'paypal',
        provider_event_id: body.id,
        event_type: body.event_type,
        signature_verified: Boolean(verified.ok && verified.verified),
        processing_state: verified.ok && verified.verified ? 'received' : 'failed',
        attempt_count: 0,
        payload: body,
        last_error_code: verified.ok && verified.verified ? null : (verified.code || 'WEBHOOK_SIGNATURE_INVALID')
      };
      const inserted = await adminRest(config, 'payment_webhook_events', new URLSearchParams(), 'POST', eventRow);
      if (!inserted.ok) {
        const prior = await selectAdminRows(config, 'payment_webhook_events', query({
          select: 'id,signature_verified,processing_state,last_error_code',
          provider: 'eq.paypal', provider_event_id: 'eq.' + body.id, limit: '1'
        }));
        if (prior.ok && prior.rows[0] && prior.rows[0].processing_state === 'processed') {
          return json(res, 200, { ok: true, duplicate: true, processed: true });
        }
        if (!prior.ok || !prior.rows[0]) return error(res, 503, 'WEBHOOK_EVENT_STORE_FAILED');
        if (!prior.rows[0].signature_verified) {
          const repaired = await adminRest(config, 'payment_webhook_events', query({ id: 'eq.' + prior.rows[0].id }), 'PATCH', {
            event_type: body.event_type, signature_verified: true, processing_state: 'received',
            payload: body, last_error_code: null, attempt_count: 0
          });
          if (!repaired.ok) return error(res, 503, 'WEBHOOK_EVENT_REPAIR_FAILED');
        }
      }
      const eventLookup = await selectAdminRows(config, 'payment_webhook_events', query({
        select: 'id,processing_state,signature_verified',
        provider: 'eq.paypal', provider_event_id: 'eq.' + body.id, limit: '1'
      }));
      const storedEvent = eventLookup.ok ? eventLookup.rows[0] : null;
      if (!(verified.ok && verified.verified) || !storedEvent || !storedEvent.signature_verified) {
        return error(res, 400, 'WEBHOOK_SIGNATURE_INVALID');
      }

      let processing = 'processed';
      let errorCode = null;
      try {
        const resource = body.resource && typeof body.resource === 'object' ? body.resource : {};
        if (body.event_type === 'CHECKOUT.ORDER.APPROVED') {
          const providerOrderId = String(resource.id || '');
          if (providerOrderId) {
            await adminRest(config, 'payment_orders', query({
              provider_order_id: 'eq.' + providerOrderId, state: 'eq.created'
            }), 'PATCH', { state: 'approved', updated_at: new Date().toISOString() });
          }
        } else if (body.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
          const relatedIds = resource.supplementary_data && resource.supplementary_data.related_ids || {};
          const providerOrderId = String(relatedIds.order_id || '');
          const captureId = String(resource.id || '');
          const amount = resource.amount && Number(resource.amount.value);
          const currency = String(resource.amount && resource.amount.currency_code || '');
          if (!providerOrderId || !captureId || !Number.isFinite(amount)) {
            processing = 'failed'; errorCode = 'CAPTURE_WEBHOOK_FIELDS_MISSING';
          } else {
            const credit = await adminRpc(config, 'credit_captured_coin_order', {
              p_provider_order_id: providerOrderId, p_capture_id: captureId,
              p_capture_amount: amount, p_currency: currency
            });
            if (!credit.ok) { processing = 'failed'; errorCode = 'CAPTURE_CREDIT_RECONCILIATION_FAILED'; }
          }
        } else if (body.event_type === 'PAYMENT.CAPTURE.DENIED') {
          const relatedIds = resource.supplementary_data && resource.supplementary_data.related_ids || {};
          if (relatedIds.order_id) {
            await adminRest(config, 'payment_orders', query({
              provider_order_id: 'eq.' + String(relatedIds.order_id),
              state: 'in.(created,approved)'
            }), 'PATCH', { state: 'failed', updated_at: new Date().toISOString() });
          }
        } else if (body.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
          const related = resource.supplementary_data && resource.supplementary_data.related_ids || {};
          const providerRefundId = String(resource.id || '');
          const captureId = String(related.capture_id || '');
          let refundRows = providerRefundId ? await selectAdminRows(config, 'refund_records', query({
            select: 'id,payment_order_id,requested_by,state,provider_refund_id',
            provider_refund_id: 'eq.' + providerRefundId, state: 'eq.processing', limit: '1'
          })) : { ok: true, rows: [] };
          if ((!refundRows.ok || !refundRows.rows.length) && captureId) {
            const paymentRows = await selectAdminRows(config, 'payment_orders', query({
              select: 'id,profile_id,state,provider_capture_id',
              provider_capture_id: 'eq.' + captureId, limit: '1'
            }));
            if (paymentRows.ok && paymentRows.rows[0]) {
              if (paymentRows.rows[0].state === 'refunded') {
                processing = 'processed';
              } else {
                const pending = await selectAdminRows(config, 'refund_records', query({
                  select: 'id,payment_order_id,requested_by,state,provider_refund_id',
                  payment_order_id: 'eq.' + paymentRows.rows[0].id, state: 'eq.processing', limit: '1'
                }));
                if (pending.ok && pending.rows.length) refundRows = pending;
                else {
                  const restrictionPatch = await adminRest(config, 'wallet_restrictions', query({ profile_id: 'eq.' + paymentRows.rows[0].profile_id }), 'PATCH', {
                    state: 'active', reason_code: 'EXTERNAL_REFUND_REQUIRES_RECONCILIATION',
                    source_order_id: paymentRows.rows[0].id, updated_at: new Date().toISOString(), cleared_at: null
                  });
                  if (restrictionPatch.ok && Array.isArray(restrictionPatch.data) && restrictionPatch.data.length === 0) {
                    await adminRest(config, 'wallet_restrictions', new URLSearchParams(), 'POST', {
                      profile_id: paymentRows.rows[0].profile_id, state: 'active',
                      reason_code: 'EXTERNAL_REFUND_REQUIRES_RECONCILIATION', source_order_id: paymentRows.rows[0].id
                    });
                  }
                  await adminRest(config, 'payment_orders', query({ id: 'eq.' + paymentRows.rows[0].id, state: 'eq.credited' }), 'PATCH', {
                    state: 'reversed', updated_at: new Date().toISOString()
                  });
                  processing = 'failed'; errorCode = 'EXTERNAL_REFUND_REQUIRES_RECONCILIATION';
                }
              }
            } else {
              processing = 'failed'; errorCode = 'REFUND_ORDER_LOOKUP_FAILED';
            }
          }
          if (refundRows.ok && refundRows.rows.length) {
            const final = await adminRpc(config, 'finalize_coin_refund', {
              p_refund_id: refundRows.rows[0].id,
              p_provider_refund_id: providerRefundId || refundRows.rows[0].provider_refund_id,
              p_succeeded: true,
              p_error_code: null
            });
            if (!final.ok) { processing = 'failed'; errorCode = 'REFUND_FINALIZATION_FAILED'; }
          }
        } else if (body.event_type === 'PAYMENT.CAPTURE.REVERSED') {
          const captureId = String(resource.id || '');
          const paymentRows = await selectAdminRows(config, 'payment_orders', query({
            select: 'id,profile_id,state,provider_capture_id', provider_capture_id: 'eq.' + captureId, limit: '1'
          }));
          if (paymentRows.ok && paymentRows.rows[0] && paymentRows.rows[0].state !== 'refunded') {
            const restrictionPatch = await adminRest(config, 'wallet_restrictions', query({ profile_id: 'eq.' + paymentRows.rows[0].profile_id }), 'PATCH', {
              state: 'active', reason_code: 'PAYPAL_CAPTURE_REVERSED',
              source_order_id: paymentRows.rows[0].id, updated_at: new Date().toISOString(), cleared_at: null
            });
            if (restrictionPatch.ok && Array.isArray(restrictionPatch.data) && restrictionPatch.data.length === 0) {
              await adminRest(config, 'wallet_restrictions', new URLSearchParams(), 'POST', {
                profile_id: paymentRows.rows[0].profile_id, state: 'active',
                reason_code: 'PAYPAL_CAPTURE_REVERSED', source_order_id: paymentRows.rows[0].id
              });
            }
            await adminRest(config, 'payment_orders', query({ id: 'eq.' + paymentRows.rows[0].id, state: 'eq.credited' }), 'PATCH', {
              state: 'reversed', updated_at: new Date().toISOString()
            });
            processing = 'failed'; errorCode = 'PAYPAL_CAPTURE_REVERSED';
          }
        } else {
          processing = 'ignored';
        }
      } catch (_) {
        processing = 'failed';
        errorCode = 'WEBHOOK_PROCESSING_FAILED';
      }
      await adminRest(config, 'payment_webhook_events', query({
        provider: 'eq.paypal', provider_event_id: 'eq.' + body.id
      }), 'PATCH', {
        processing_state: processing, processed_at: new Date().toISOString(),
        last_error_code: errorCode, attempt_count: 1
      });
      return json(res, 200, { ok: true, eventId: body.id, processingState: processing, ...(errorCode ? { code: errorCode } : {}) });
    }

    if (req.method === 'GET' && url.pathname === '/api/catalog/gifts') {
      const giftsResult = await adminRest(config, 'gift_definitions', query({ select: 'id,name,category,tier,price_coins,unlock_rule,model_path,audio_path,audio_status,asset_version,license', order: 'tier.asc,name.asc', limit: '200' }));
      if (giftsResult.ok && Array.isArray(giftsResult.data) && giftsResult.data.length) {
        const category = url.searchParams.get('category');
        const items = category ? giftsResult.data.filter((gift) => String(gift.category || '').toLowerCase().includes(category.toLowerCase())) : giftsResult.data;
        return json(res, 200, { ok: true, count: items.length, gifts: items.map((gift) => ({ id: gift.id, name: gift.name, category: gift.category, tier: gift.tier, priceCoins: gift.price_coins, unlockRule: gift.unlock_rule, modelPath: gift.model_path, audioPath: gift.audio_path, audioStatus: gift.audio_status, assetVersion: gift.asset_version, license: gift.license })) });
      }
      const { loadGifts } = require('../../../packages/gift-engine/src/catalog');
      const category = url.searchParams.get('category');
      const gifts = loadGifts().filter((gift) => !category || String(gift.category || '').toLowerCase().includes(category.toLowerCase()));
      return json(res, 200, { ok: true, count: gifts.length, gifts });
    }

    if (req.method === 'GET' && url.pathname === '/api/live/rooms') {
      const roomQuery = query({ select: 'id,host_id,title,category,state,is_private,started_at', state: 'eq.live', is_private: 'eq.false', order: 'started_at.desc.nullslast', limit: '24' });
      const rooms = await selectAdminRows(config, 'live_rooms', roomQuery);
      if (!rooms.ok) return json(res, 200, { ok: true, rooms: [], source: 'service-unavailable', unavailable: true });
      if (!rooms.rows.length) return json(res, 200, { ok: true, rooms: [], source: 'database' });
      const hosts = await selectAdminRows(config, 'profiles', query({ select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(rooms.rows.map((room) => room.host_id)) }));
      const hostById = new Map((hosts.rows || []).map((host) => [host.id, host]));
      return json(res, 200, { ok: true, source: 'database', rooms: rooms.rows.map((room) => safeRoom(room, hostById.get(room.host_id))) });
    }

    if (req.method === 'POST' && url.pathname === '/api/livekit/token') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const roomId = String(body.roomId || '');
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const rooms = await selectAdminRows(config, 'live_rooms', query({ id: 'eq.' + roomId, select: 'id,host_id,state,is_private' }));
      if (!rooms.ok) return badDatabase(res, rooms);
      if (!rooms.rows.length) return error(res, 404, 'ROOM_NOT_FOUND');
      const room = rooms.rows[0];
      const currentId = session.profile.id;
      const host = room.host_id === currentId;
      const participantRows = await selectAdminRows(config, 'live_participants', query({
        room_id: 'eq.' + roomId, profile_id: 'eq.' + currentId, left_at: 'is.null', select: 'role'
      }));
      if (!participantRows.ok) return badDatabase(res, participantRows);
      const membership = participantRows.rows[0] || null;
      if (room.state === 'ended') return error(res, 409, 'ROOM_ENDED');
      if (room.is_private && !host && !membership) return error(res, 403, 'ROOM_ACCESS_DENIED');
      if (room.state !== 'live' && !host) return error(res, 409, 'ROOM_NOT_LIVE');
      const canPublish = host || Boolean(membership && membership.role === 'guest');
      if (canPublish && !host) {
        const active = await selectAdminRows(config, 'live_participants', query({ room_id: 'eq.' + roomId, left_at: 'is.null', select: 'profile_id,role' }));
        if (!active.ok) return badDatabase(res, active);
        const publishers = new Set(active.rows.filter((row) => row.role === 'host' || row.role === 'guest').map((row) => row.profile_id));
        publishers.add(room.host_id);
        if (publishers.size > 8) return error(res, 409, 'PUBLISHER_CAPACITY_EXCEEDED');
      }
      const ttlSeconds = Number.isInteger(body.ttlSeconds) ? Math.max(60, Math.min(3600, body.ttlSeconds)) : 900;
      const token = livekit.mintToken(config.livekit, { identity: currentId, room: room.id, canPublish, canSubscribe: true, ttlSeconds });
      return json(res, token.ok ? 200 : token.status || 500, token);
    }

    if (req.method === 'GET' && url.pathname === '/api/profile/me') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      return json(res, 200, { ok: true, profile: profileProjection(session.profile) });
    }

    if (req.method === 'PATCH' && url.pathname === '/api/profile/me') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const patch = {};
      for (const key of Object.keys(body)) {
        if (!PROFILE_FIELDS.has(key)) return error(res, 400, 'PROFILE_FIELD_NOT_ALLOWED');
        const value = body[key];
        if (key === 'visibility') {
          if (!['public','private','restricted'].includes(value)) return error(res, 400, 'INVALID_VISIBILITY');
        } else if (key === 'display_name') {
          if (typeof value !== 'string' || value.trim().length > 80) return error(res, 400, 'INVALID_DISPLAY_NAME');
          patch[key] = value.trim();
          continue;
        } else if (key === 'bio') {
          if (typeof value !== 'string' || value.length > 1000) return error(res, 400, 'INVALID_BIO');
          patch[key] = value;
          continue;
        } else if (key === 'avatar_url' || key === 'cover_url') {
          if (value !== null && !isValidHttpUrl(value)) return error(res, 400, 'INVALID_PROFILE_URL');
        }
        patch[key] = value;
      }
      if (!Object.keys(patch).length) return error(res, 400, 'EMPTY_PROFILE_UPDATE');
      patch.updated_at = new Date().toISOString();
      const result = await rowsForUser(session, 'profiles', { id: 'eq.' + session.profile.id, select: 'id,username,display_name,bio,avatar_url,cover_url,visibility,is_creator,is_verified,created_at,updated_at' }, { method: 'PATCH', body: patch });
      if (!result.ok) return badDatabase(res, result, 'PROFILE_UPDATE_FAILED');
      const saved = Array.isArray(result.data) ? result.data[0] : null;
      return json(res, 200, { ok: true, profile: profileProjection(saved || { ...session.profile, ...patch }) });
    }

    if (req.method === 'GET' && url.pathname === '/api/feed') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const mode = url.searchParams.get('mode') === 'following' ? 'following' : 'for-you';
      const limit = asSafeInt(url.searchParams.get('limit'), 20, 1, 40);
      const offset = asSafeInt(url.searchParams.get('offset'), 0, 0, 10000);
      let followedIds = [];
      const follows = await rowsForUser(session, 'follows', { select: 'followee_id', follower_id: 'eq.' + session.profile.id, limit: '300' });
      if (follows.ok && Array.isArray(follows.data)) followedIds = follows.data.map((row) => row.followee_id).filter(uuid);
      if (mode === 'following' && followedIds.length === 0) return json(res, 200, { ok: true, mode, posts: [] });
      const postParams = {
        select: 'id,author_id,kind,caption,media,audience,created_at,expires_at',
        deleted_at: 'is.null',
        order: 'created_at.desc',
        limit: String(mode === 'for-you' ? 300 : limit)
      };
      if (mode === 'following') {
        postParams.author_id = profileIdIn(followedIds);
        postParams.offset = String(offset);
      }
      const postResult = await rowsForUser(session, 'posts', postParams);
      if (!postResult.ok || !Array.isArray(postResult.data)) return badDatabase(res, postResult, 'FEED_UNAVAILABLE');
      let rows = postResult.data;
      if (mode === 'for-you') {
        const followed = new Set(followedIds);
        rows = rankCandidates(rows.map((post) => ({ ...post, authorId: post.author_id, visibility: post.audience, createdAt: post.created_at })), { viewerId: session.profile.id, followedProfileIds: followed })
          .slice(offset, offset + limit).map((entry) => ({ ...entry.candidate, rankingScore: entry.score }));
      } else rows = rows.slice(0, limit);
      const authors = [...new Set(rows.map((post) => post.author_id).filter(uuid))];
      let profileById = new Map();
      if (authors.length) {
        const profileRows = await rowsForUser(session, 'profiles', { select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(authors) });
        if (profileRows.ok && Array.isArray(profileRows.data)) profileById = new Map(profileRows.data.map((profile) => [profile.id, profile]));
      }
      const mediaAssetIds = [...new Set(rows.flatMap((post) => Array.isArray(post.media) ? post.media.map((item) => item && item.assetId).filter(uuid) : []))];
      const mediaAssetsResult = mediaAssetIds.length
        ? await selectAdminRows(config, 'media_assets', query({
            select: 'id,storage_path,media_type,mime_type,state,width,height,duration_ms',
            id: profileIdIn(mediaAssetIds), limit: String(Math.min(mediaAssetIds.length, 300))
          }))
        : { ok: true, rows: [] };
      const mediaAssets = new Map((mediaAssetsResult.rows || []).map((asset) => [asset.id, asset]));
      const readyAssets = [...mediaAssets.values()].filter((asset) => asset.state === 'ready' && typeof asset.storage_path === 'string');
      let signedByPath = new Map();
      if (readyAssets.length) {
        const signed = await storage.createSignedDownloadUrls(config, config.storageBucket, readyAssets.map((asset) => asset.storage_path), config.mediaSignedUrlTtlSeconds);
        if (signed.ok) signedByPath = new Map(signed.signedUrls.map((item) => [item.path, item.signedUrl]));
      }
      function publicMedia(mediaItems) {
        if (!Array.isArray(mediaItems)) return [];
        return mediaItems.map((item) => {
          if (!item || typeof item !== 'object') return null;
          const asset = uuid(item.assetId) ? mediaAssets.get(item.assetId) : null;
          if (!asset) return { assetId: item.assetId || null, mediaType: item.mediaType || null, mimeType: item.mimeType || null, url: null, state: 'unavailable' };
          return {
            assetId: asset.id,
            mediaType: asset.media_type,
            mimeType: asset.mime_type,
            url: asset.state === 'ready' ? signedByPath.get(asset.storage_path) || null : null,
            state: asset.state,
            width: asset.width || null,
            height: asset.height || null,
            durationMs: asset.duration_ms || null
          };
        }).filter(Boolean);
      }
      const events = rows.map((post, index) => ({ profile_id: session.profile.id, content_type: 'post', content_id: post.id, event_type: 'impression', position: index }));
      if (events.length) await adminRest(config, 'recommendation_events', new URLSearchParams(), 'POST', events);
      return json(res, 200, { ok: true, mode, offset, limit, hasMore: rows.length === limit && (mode !== 'for-you' || offset + rows.length < 300), posts: rows.map((post) => ({
        id: post.id, kind: post.kind, caption: post.caption || '', media: publicMedia(post.media),
        audience: post.audience, createdAt: post.created_at, expiresAt: post.expires_at || null,
        rankingScore: post.rankingScore ?? null,
        author: profileProjection(profileById.get(post.author_id))
      })) });
    }

    if (req.method === 'POST' && url.pathname === '/api/media/upload-url') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const validation = validateUploadMetadata(body);
      if (!validation.ok) return error(res, 400, validation.errors[0] || 'INVALID_MEDIA_METADATA');
      const media = validation.metadata;
      const assetId = randomUUID();
      const extension = MIME_TO_EXTENSION[media.mimeType];
      if (!extension) return error(res, 400, 'UNSUPPORTED_MEDIA_TYPE');
      const storagePath = 'profiles/' + session.profile.id + '/' + assetId + '.' + extension;
      const insert = await rowsForUser(session, 'media_assets', {
        select: 'id,uploader_id,storage_path,media_type,mime_type,byte_size,checksum_sha256,state,created_at'
      }, {
        method: 'POST',
        body: {
          id: assetId,
          uploader_id: session.profile.id,
          storage_path: storagePath,
          media_type: media.mediaType,
          mime_type: media.mimeType,
          byte_size: media.byteSize,
          checksum_sha256: media.checksumSha256,
          state: 'uploaded',
          metadata: { originalFilename: media.filename, pipelineVersion: 'zuno-media-v1' }
        }
      });
      if (!insert.ok || !Array.isArray(insert.data) || !insert.data[0]) return badDatabase(res, insert, 'MEDIA_ASSET_CREATE_FAILED');
      const signed = await storage.createSignedUploadUrl(config, config.storageBucket, storagePath);
      if (!signed.ok) {
        await adminRest(config, 'media_assets', query({ id: 'eq.' + assetId, uploader_id: 'eq.' + session.profile.id }), 'PATCH', {
          state: 'failed', updated_at: new Date().toISOString(),
          metadata: { originalFilename: media.filename, uploadErrorCode: signed.code }
        });
        return error(res, signed.status || 503, signed.code || 'MEDIA_UPLOAD_URL_FAILED', 'A secure upload URL could not be created. No media was uploaded.');
      }
      return json(res, 201, {
        ok: true,
        asset: { id: assetId, mediaType: media.mediaType, mimeType: media.mimeType, byteSize: media.byteSize, state: 'uploaded' },
        upload: { url: signed.uploadUrl, method: 'PUT', headers: { 'Content-Type': media.mimeType }, expiresInSeconds: signed.expiresInSeconds },
        next: 'PUT the file to the signed URL, then POST /api/media/' + assetId + '/complete.'
      });
    }

    const mediaCompleteMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/complete$/i);
    if (req.method === 'POST' && mediaCompleteMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const assetId = mediaCompleteMatch[1];
      if (!uuid(assetId)) return error(res, 400, 'INVALID_MEDIA_ASSET_ID');
      const selected = await rowsForUser(session, 'media_assets', {
        select: 'id,uploader_id,storage_path,media_type,mime_type,byte_size,checksum_sha256,state,metadata',
        id: 'eq.' + assetId, uploader_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!selected.ok || !Array.isArray(selected.data) || !selected.data[0]) return error(res, selected.status === 503 ? 503 : 404, 'MEDIA_ASSET_NOT_FOUND');
      const asset = selected.data[0];
      if (asset.state === 'processing') return json(res, 202, { ok: true, asset: { id: asset.id, state: asset.state }, idempotent: true });
      if (asset.state === 'ready') return json(res, 200, { ok: true, asset: { id: asset.id, state: asset.state }, idempotent: true });
      if (asset.state !== 'uploaded' && asset.state !== 'failed') return error(res, 409, 'MEDIA_ASSET_STATE_NOT_COMPLETABLE');
      const object = await storage.inspectObject(config, config.storageBucket, asset.storage_path);
      if (!object.ok) return error(res, object.status === 404 ? 409 : 503, object.code || 'MEDIA_OBJECT_NOT_FOUND', 'The uploaded file is not yet available in private storage.');
      if (object.byteSize !== null && object.byteSize !== Number(asset.byte_size)) {
        await adminRest(config, 'media_assets', query({ id: 'eq.' + asset.id, uploader_id: 'eq.' + session.profile.id }), 'PATCH', {
          state: 'quarantined', updated_at: new Date().toISOString(),
          metadata: { ...(asset.metadata || {}), quarantineReason: 'MEDIA_SIZE_MISMATCH' }
        });
        return error(res, 409, 'MEDIA_SIZE_MISMATCH', 'Uploaded bytes do not match the declared file size. The asset was quarantined.');
      }
      const queued = await adminRpc(config, 'queue_media_processing_job', {
        p_asset_id: asset.id, p_profile_id: session.profile.id, p_bucket: config.storageBucket
      });
      if (!queued.ok) return badDatabase(res, queued, 'MEDIA_QUEUE_UNAVAILABLE');
      const jobId = typeof queued.data === 'string' ? queued.data : Array.isArray(queued.data) ? queued.data[0] : queued.data && queued.data.queue_media_processing_job;
      return json(res, 202, { ok: true, asset: { id: asset.id, state: 'processing' }, jobId: jobId || null });
    }

    const mediaStatusMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && mediaStatusMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const assetId = mediaStatusMatch[1];
      if (!uuid(assetId)) return error(res, 400, 'INVALID_MEDIA_ASSET_ID');
      const selected = await rowsForUser(session, 'media_assets', {
        select: 'id,media_type,mime_type,byte_size,state,width,height,duration_ms,metadata,created_at,updated_at',
        id: 'eq.' + assetId, uploader_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!selected.ok) return badDatabase(res, selected, 'MEDIA_STATUS_UNAVAILABLE');
      if (!Array.isArray(selected.data) || !selected.data[0]) return error(res, 404, 'MEDIA_ASSET_NOT_FOUND');
      const asset = selected.data[0];
      const safeMetadata = asset.metadata && typeof asset.metadata === 'object' ? {
        pipelineVersion: asset.metadata.pipelineVersion || null,
        processedAt: asset.metadata.processedAt || null,
        lastProcessingError: asset.metadata.lastProcessingError || null,
        quarantineReason: asset.metadata.quarantineReason || null,
        width: asset.metadata.width || asset.width || null,
        height: asset.metadata.height || asset.height || null,
        durationSeconds: asset.metadata.durationSeconds || (asset.duration_ms ? Number(asset.duration_ms) / 1000 : null)
      } : {};
      return json(res, 200, { ok: true, asset: {
        id: asset.id, mediaType: asset.media_type, mimeType: asset.mime_type, byteSize: asset.byte_size,
        state: asset.state, width: asset.width, height: asset.height, durationMs: asset.duration_ms,
        metadata: safeMetadata, createdAt: asset.created_at, updatedAt: asset.updated_at
      } });
    }

    if (req.method === 'POST' && url.pathname === '/api/posts') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const kind = String(body.kind || '');
      const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
      const audience = body.audience || 'public';
      const assetIds = Array.isArray(body.mediaAssetIds) ? [...new Set(body.mediaAssetIds)] : [];
      if (!POST_KINDS.has(kind)) return error(res, 400, 'INVALID_POST_KIND');
      if (!AUDIENCES.has(audience)) return error(res, 400, 'INVALID_AUDIENCE');
      if (caption.length > 4000) return error(res, 400, 'CAPTION_TOO_LONG');
      if (kind === 'text' && !caption) return error(res, 400, 'TEXT_REQUIRED');
      if (assetIds.length > 10 || assetIds.some((id) => !uuid(id))) return error(res, 400, 'INVALID_MEDIA_ASSET_IDS');
      if (kind !== 'text' && assetIds.length === 0) return error(res, 400, 'MEDIA_ASSET_REQUIRED');
      let media = [];
      if (assetIds.length) {
        const assets = await rowsForUser(session, 'media_assets', {
          select: 'id,media_type,mime_type,storage_path,width,height,duration_ms,state',
          id: profileIdIn(assetIds), uploader_id: 'eq.' + session.profile.id, state: 'eq.ready', limit: '10'
        });
        if (!assets.ok || !Array.isArray(assets.data)) return badDatabase(res, assets, 'MEDIA_LOOKUP_FAILED');
        if (assets.data.length !== assetIds.length) return error(res, 409, 'MEDIA_NOT_READY');
        media = assets.data.map((asset) => ({ assetId: asset.id, mediaType: asset.media_type, mimeType: asset.mime_type, storagePath: asset.storage_path, width: asset.width, height: asset.height, durationMs: asset.duration_ms }));
      }
      const insert = await rowsForUser(session, 'posts', { select: 'id,author_id,kind,caption,media,audience,created_at,expires_at' }, {
        method: 'POST', body: { author_id: session.profile.id, kind, caption: caption || null, media, audience }
      });
      if (!insert.ok || !Array.isArray(insert.data) || !insert.data[0]) return badDatabase(res, insert, 'POST_PUBLISH_FAILED');
      const post = insert.data[0];
      if (assetIds.length) {
        await adminRest(config, 'media_assets', query({ id: profileIdIn(assetIds) }), 'PATCH', { post_id: post.id });
      }
      return json(res, 201, { ok: true, post: { id: post.id, kind: post.kind, caption: post.caption || '', media: post.media, audience: post.audience, createdAt: post.created_at } });
    }

    const reactionMatch = url.pathname.match(/^\/api\/posts\/([0-9a-f-]+)\/reactions$/i);
    if (reactionMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const postId = reactionMatch[1];
      if (!uuid(postId)) return error(res, 400, 'INVALID_POST_ID');
      const body = await readBody(req);
      const kind = ['like','love','laugh','wow','sad','celebrate'].includes(body.kind) ? body.kind : 'like';
      const result = await rowsForUser(session, 'reactions', { select: 'id,post_id,profile_id,kind,created_at' }, {
        method: 'POST', body: { post_id: postId, profile_id: session.profile.id, kind }
      });
      if (!result.ok) return badDatabase(res, result, 'REACTION_FAILED');
      return json(res, 201, { ok: true, reaction: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/comments') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      if (!uuid(body.postId)) return error(res, 400, 'INVALID_POST_ID');
      if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.trim().length > 2000) return error(res, 400, 'INVALID_COMMENT');
      if (body.parentId && !uuid(body.parentId)) return error(res, 400, 'INVALID_PARENT_ID');
      const result = await rowsForUser(session, 'comments', { select: 'id,post_id,author_id,parent_id,body,created_at' }, {
        method: 'POST', body: { post_id: body.postId, author_id: session.profile.id, parent_id: body.parentId || null, body: body.body.trim() }
      });
      if (!result.ok) return badDatabase(res, result, 'COMMENT_FAILED');
      return json(res, 201, { ok: true, comment: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/follows') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      if (!uuid(body.profileId) || body.profileId === session.profile.id) return error(res, 400, 'INVALID_FOLLOW_TARGET');
      const result = await rowsForUser(session, 'follows', { select: 'follower_id,followee_id,created_at' }, {
        method: 'POST', body: { follower_id: session.profile.id, followee_id: body.profileId }
      });
      if (!result.ok) return badDatabase(res, result, 'FOLLOW_FAILED');
      return json(res, 201, { ok: true, follow: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/follows') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const targetId = url.searchParams.get('profileId');
      if (!uuid(targetId)) return error(res, 400, 'INVALID_FOLLOW_TARGET');
      const result = await rowsForUser(session, 'follows', { follower_id: 'eq.' + session.profile.id, followee_id: 'eq.' + targetId }, { method: 'DELETE' });
      if (!result.ok) return badDatabase(res, result, 'UNFOLLOW_FAILED');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/communities') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'communities', { select: 'id,owner_id,name,access,created_at', order: 'created_at.desc', limit: '50' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'COMMUNITIES_UNAVAILABLE');
      return json(res, 200, { ok: true, communities: result.data });
    }

    if (req.method === 'POST' && url.pathname === '/api/communities') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const access = ['public','private','invite'].includes(body.access) ? body.access : 'public';
      if (name.length < 2 || name.length > 120) return error(res, 400, 'INVALID_COMMUNITY_NAME');
      const result = await rowsForUser(session, 'communities', { select: 'id,owner_id,name,access,created_at' }, { method: 'POST', body: { owner_id: session.profile.id, name, access } });
      if (!result.ok || !Array.isArray(result.data) || !result.data[0]) return badDatabase(res, result, 'COMMUNITY_CREATE_FAILED');
      return json(res, 201, { ok: true, community: result.data[0] });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'events', { select: 'id,host_id,title,description,starts_at,ends_at,tz,created_at', order: 'starts_at.asc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'EVENTS_UNAVAILABLE');
      return json(res, 200, { ok: true, events: result.data });
    }

    if (req.method === 'POST' && url.pathname === '/api/events') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const start = new Date(body.startsAt);
      const end = body.endsAt ? new Date(body.endsAt) : null;
      if (title.length < 2 || title.length > 180 || description.length > 4000 || !Number.isFinite(start.getTime()) || (end && (!Number.isFinite(end.getTime()) || end <= start))) return error(res, 400, 'INVALID_EVENT');
      const result = await rowsForUser(session, 'events', { select: 'id,host_id,title,description,starts_at,ends_at,tz,created_at' }, {
        method: 'POST', body: { host_id: session.profile.id, title, description: description || null, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null, tz: 'America/Jamaica' }
      });
      if (!result.ok || !Array.isArray(result.data) || !result.data[0]) return badDatabase(res, result, 'EVENT_CREATE_FAILED');
      return json(res, 201, { ok: true, event: result.data[0] });
    }

    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const memberRows = await rowsForUser(session, 'conversation_members', { select: 'conversation_id,profile_id,role', profile_id: 'eq.' + session.profile.id, limit: '100' });
      if (!memberRows.ok || !Array.isArray(memberRows.data)) return badDatabase(res, memberRows, 'CONVERSATIONS_UNAVAILABLE');
      if (!memberRows.data.length) return json(res, 200, { ok: true, conversations: [] });
      const ids = [...new Set(memberRows.data.map((row) => row.conversation_id).filter(uuid))];
      const conversationRows = await rowsForUser(session, 'conversations', { select: 'id,is_group,created_at', id: profileIdIn(ids) });
      if (!conversationRows.ok || !Array.isArray(conversationRows.data)) return badDatabase(res, conversationRows, 'CONVERSATIONS_UNAVAILABLE');
      return json(res, 200, { ok: true, conversations: conversationRows.data });
    }

    const messagesMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
    if (messagesMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const conversationId = messagesMatch[1];
      if (!uuid(conversationId)) return error(res, 400, 'INVALID_CONVERSATION_ID');
      const result = await rowsForUser(session, 'messages', { select: 'id,conversation_id,sender_id,body,attachments,created_at,edited_at,deleted_at', conversation_id: 'eq.' + conversationId, deleted_at: 'is.null', order: 'created_at.desc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'MESSAGES_UNAVAILABLE');
      return json(res, 200, { ok: true, messages: result.data.reverse() });
    }

    if (messagesMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const conversationId = messagesMatch[1];
      if (!uuid(conversationId)) return error(res, 400, 'INVALID_CONVERSATION_ID');
      const body = await readBody(req);
      if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.trim().length > 4000) return error(res, 400, 'INVALID_MESSAGE');
      const result = await rowsForUser(session, 'messages', { select: 'id,conversation_id,sender_id,body,attachments,created_at' }, {
        method: 'POST', body: { conversation_id: conversationId, sender_id: session.profile.id, body: body.body.trim(), attachments: [] }
      });
      if (!result.ok) return badDatabase(res, result, 'MESSAGE_SEND_FAILED');
      return json(res, 201, { ok: true, message: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'notifications', { select: 'id,profile_id,kind,payload,read_at,created_at', profile_id: 'eq.' + session.profile.id, order: 'created_at.desc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'NOTIFICATIONS_UNAVAILABLE');
      return json(res, 200, { ok: true, notifications: result.data });
    }

    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([0-9a-f-]+)\/read$/i);
    if (notificationReadMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const notificationId = notificationReadMatch[1];
      if (!uuid(notificationId)) return error(res, 400, 'INVALID_NOTIFICATION_ID');
      const result = await rowsForUser(session, 'notifications', { id: 'eq.' + notificationId, profile_id: 'eq.' + session.profile.id, select: 'id,read_at' }, { method: 'PATCH', body: { read_at: new Date().toISOString() } });
      if (!result.ok) return badDatabase(res, result, 'NOTIFICATION_UPDATE_FAILED');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/wallet') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const restrictions = await selectAdminRows(config, 'wallet_restrictions', query({
        select: 'state,reason_code,created_at', profile_id: 'eq.' + session.profile.id, state: 'eq.active', limit: '1'
      }));
      if (!restrictions.ok) return badDatabase(res, restrictions, 'WALLET_RESTRICTION_LOOKUP_FAILED');
      const restriction = restrictions.rows[0] || null;
      const canUsePayPal = Boolean(config.configured.paypal && (
        config.paypal.env !== 'live' ||
        (config.features.productionPayments && Boolean(config.paypal.webhookId))
      ) && !restriction);
      const accounts = await selectAdminRows(config, 'wallet_accounts', query({ select: 'id,kind', profile_id: 'eq.' + session.profile.id, kind: 'eq.user' }));
      if (!accounts.ok) return badDatabase(res, accounts, 'WALLET_UNAVAILABLE');
      if (!accounts.rows.length) return json(res, 200, {
        ok: true,
        wallet: { initialized: false, coinBalance: null, restricted: Boolean(restriction), restrictionReason: restriction ? restriction.reason_code : null, note: 'Wallet has not been provisioned for this account yet.' },
        checkoutEnabled: canUsePayPal, payoutsEnabled: false
      });
      const postings = await selectAdminRows(config, 'ledger_postings', query({ select: 'delta,unit,entry_id', account_id: 'eq.' + accounts.rows[0].id, unit: 'eq.coins', limit: '5000' }));
      if (!postings.ok) return badDatabase(res, postings, 'WALLET_UNAVAILABLE');
      const balance = postings.rows.reduce((total, posting) => total + Number(posting.delta || 0), 0);
      return json(res, 200, {
        ok: true,
        wallet: {
          initialized: true, coinBalance: balance,
          restricted: Boolean(restriction), restrictionReason: restriction ? restriction.reason_code : null,
          note: restriction ? 'Wallet spending is restricted pending provider reconciliation.' : 'Balance is calculated from server ledger postings.'
        },
        checkoutEnabled: canUsePayPal, payoutsEnabled: false
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/rankings') {
      const periodRaw = url.searchParams.get('period') || 'monthly';
      const period = ['weekly','monthly','all_time'].includes(periodRaw) ? periodRaw : 'monthly';
      const scopeRaw = url.searchParams.get('scope') || 'global';
      const scope = ['global','country','creator','room','friends'].includes(scopeRaw) ? scopeRaw : 'global';
      const limit = asSafeInt(url.searchParams.get('limit'), 25, 1, 100);
      const start = period === 'monthly' ? monthlyPeriodStart(new Date()).toISOString() : period === 'weekly' ? weeklyPeriodStart(new Date()).toISOString() : null;
      const rankParams = query({ select: 'actor_id,coins,period_start,scope,period', scope: 'eq.' + scope, period: 'eq.' + (period === 'all_time' ? 'all_time' : period), ...(start ? { period_start: 'eq.' + start } : {}), order: 'coins.desc', limit: String(limit) });
      const ranked = await selectAdminRows(config, 'ranking_aggregates', rankParams);
      if (!ranked.ok) return badDatabase(res, ranked, 'RANKINGS_UNAVAILABLE');
      const actors = [...new Set(ranked.rows.map((row) => row.actor_id).filter(uuid))];
      const profiles = actors.length ? await selectAdminRows(config, 'profiles', query({ select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(actors) })) : { ok: true, rows: [] };
      const profileMap = new Map(profiles.rows.map((p) => [p.id, p]));
      return json(res, 200, { ok: true, period, scope, rankings: ranked.rows.map((row, index) => {
        const profile = profileMap.get(row.actor_id);
        return { rank: index + 1, profile: profile ? { id: profile.id, username: profile.username, displayName: profile.display_name || profile.username, avatarUrl: profile.avatar_url || null, isVerified: Boolean(profile.is_verified) } : null, coins: Number(row.coins), periodStart: row.period_start };
      }) });
    }

    if (req.method === 'POST' && url.pathname === '/api/gifts/send') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const recipientId = String(body.recipientProfileId || '');
      const giftId = String(body.giftId || '');
      const liveRoomId = body.liveRoomId == null || body.liveRoomId === '' ? null : String(body.liveRoomId);
      const message = body.message == null ? null : String(body.message);
      const rawKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!uuid(recipientId) || recipientId === session.profile.id) return error(res, 400, 'INVALID_GIFT_RECIPIENT');
      if (!/^[a-zA-Z0-9._:-]{3,120}$/.test(giftId)) return error(res, 400, 'INVALID_GIFT_ID');
      if (liveRoomId && !uuid(liveRoomId)) return error(res, 400, 'INVALID_LIVE_ROOM_ID');
      if (message !== null && message.length > 240) return error(res, 400, 'GIFT_MESSAGE_TOO_LONG');
      if (!/^[a-zA-Z0-9._:-]{16,180}$/.test(rawKey)) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const restriction = await selectAdminRows(config, 'wallet_restrictions', query({
        select: 'state,reason_code', profile_id: 'eq.' + session.profile.id, state: 'eq.active', limit: '1'
      }));
      if (!restriction.ok) return error(res, 503, 'WALLET_RESTRICTION_LOOKUP_FAILED');
      if (restriction.rows.length) return error(res, 403, 'WALLET_RESTRICTED', 'This wallet is temporarily restricted while a verified payment reversal is reconciled.');
      const idempotencyKey = 'gift:' + session.profile.id + ':' + rawKey;
      const replayLookup = await selectAdminRows(config, 'gift_deliveries', query({
        select: 'id', idempotency_key: 'eq.' + idempotencyKey, limit: '1'
      }));
      if (!replayLookup.ok) return error(res, 503, 'GIFT_IDEMPOTENCY_LOOKUP_FAILED');
      const wasReplay = replayLookup.rows.length > 0;
      const delivered = await adminRpc(config, 'deliver_gift', {
        p_sender_profile_id: session.profile.id,
        p_recipient_profile_id: recipientId,
        p_gift_id: giftId,
        p_live_room_id: liveRoomId,
        p_message: message,
        p_idempotency_key: idempotencyKey
      });
      if (!delivered.ok) {
        const code = delivered.code || 'GIFT_DELIVERY_FAILED';
        if (code === 'INSUFFICIENT_FUNDS') return error(res, 409, code, 'Your Z Coins balance is too low for this gift.');
        if (code === 'GIFT_LOCKED') return error(res, 403, code, 'Your gifter level has not unlocked this gift yet.');
        if (code === 'SELF_GIFT_FORBIDDEN') return error(res, 400, code);
        if (code === 'UNKNOWN_GIFT') return error(res, 404, code);
        return error(res, delivered.status === 503 ? 503 : 409, code, 'The gift transaction was not completed. No success is being reported.');
      }
      const deliveryId = typeof delivered.data === 'string' ? delivered.data : Array.isArray(delivered.data) ? delivered.data[0] : delivered.data && delivered.data.deliver_gift;
      if (!uuid(String(deliveryId || ''))) return error(res, 503, 'GIFT_DELIVERY_RESULT_INVALID');
      const detail = await selectAdminRows(config, 'gift_deliveries', query({
        select: 'id,gift_id,sender_profile_id,recipient_profile_id,live_room_id,ledger_entry_id,price_coins,idempotency_key,message,delivered_at,state',
        id: 'eq.' + deliveryId, limit: '1'
      }));
      if (!detail.ok || !detail.rows[0]) return error(res, 503, 'GIFT_DELIVERY_READBACK_FAILED');
      const delivery = detail.rows[0];
      const gift = await selectAdminRows(config, 'gift_definitions', query({
        select: 'id,name,category,tier,price_coins,unlock_rule,model_path,audio_path,audio_status,asset_version,license',
        id: 'eq.' + delivery.gift_id, limit: '1'
      }));
      await adminRpc(config, 'refresh_gifter_progress', { p_profile_id: session.profile.id });
      return json(res, 201, {
        ok: true, idempotent: wasReplay,
        delivery: {
          id: delivery.id, senderProfileId: delivery.sender_profile_id, recipientProfileId: delivery.recipient_profile_id,
          liveRoomId: delivery.live_room_id, giftId: delivery.gift_id, priceCoins: Number(delivery.price_coins),
          ledgerEntryId: delivery.ledger_entry_id, message: delivery.message, deliveredAt: delivery.delivered_at,
          state: delivery.state,
          gift: gift.rows && gift.rows[0] ? {
            id: gift.rows[0].id, name: gift.rows[0].name, category: gift.rows[0].category,
            tier: gift.rows[0].tier, modelPath: gift.rows[0].model_path, audioPath: gift.rows[0].audio_path,
            audioStatus: gift.rows[0].audio_status, assetVersion: gift.rows[0].asset_version
          } : null
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/payments/order') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      if (!config.configured.paypal) return error(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'PayPal Developer credentials are required for checkout.');
      if (config.paypal.env === 'live' && (!config.features.productionPayments || !config.paypal.webhookId)) {
        return error(res, 503, 'PRODUCTION_CHECKOUT_DISABLED', 'Live checkout remains disabled until production payment safeguards and signed webhooks are configured.');
      }
      const body = await readBody(req);
      const restriction = await selectAdminRows(config, 'wallet_restrictions', query({
        select: 'state,reason_code', profile_id: 'eq.' + session.profile.id, state: 'eq.active', limit: '1'
      }));
      if (!restriction.ok) return error(res, 503, 'WALLET_RESTRICTION_LOOKUP_FAILED');
      if (restriction.rows.length) return error(res, 403, 'WALLET_RESTRICTED', 'This wallet is temporarily restricted while a verified payment reversal is reconciled.');
      const packageId = typeof body.packageId === 'string' ? body.packageId : null;
      const customInput = body.customAmountUSD;
      const hasPackage = Boolean(packageId);
      const hasCustom = customInput !== undefined && customInput !== null && customInput !== '';
      if (hasPackage === hasCustom) return error(res, 400, 'SELECT_ONE_RECHARGE_OPTION');
      let amountUSD, coins, customCoins = null, selectedPackage = null;
      if (hasPackage) {
        const packageResult = await selectAdminRows(config, 'coin_packages', query({
          select: 'id,coins,amount_usd,enabled', id: 'eq.' + packageId, enabled: 'eq.true', limit: '1'
        }));
        if (!packageResult.ok) return error(res, 503, 'COIN_PACKAGES_UNAVAILABLE');
        selectedPackage = packageResult.rows[0];
        if (!selectedPackage) return error(res, 400, 'COIN_PACKAGE_UNAVAILABLE');
        amountUSD = Number(selectedPackage.amount_usd);
        coins = Number(selectedPackage.coins);
      } else {
        const customAmount = Number(customInput);
        if (!Number.isFinite(customAmount) || Math.round(customAmount * 100) / 100 !== customAmount || customAmount < 0.99 || customAmount > 999.99) {
          return error(res, 400, 'CUSTOM_AMOUNT_OUT_OF_RANGE', 'Custom recharge must be between USD 0.99 and USD 999.99.');
        }
        amountUSD = customAmount;
        coins = Math.floor(customAmount * 60);
        customCoins = coins;
      }
      if (!Number.isSafeInteger(coins) || coins <= 0 || !Number.isFinite(amountUSD) || amountUSD <= 0) return error(res, 400, 'RECHARGE_QUOTE_INVALID');
      const requestKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(requestKey)) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header of at least 16 safe characters.');
      const idempotencyKey = session.profile.id + ':paypal:' + requestKey;
      const findExisting = async () => selectAdminRows(config, 'payment_orders', query({
        select: 'id,profile_id,package_id,custom_coins,amount_usd,idempotency_key,state,provider_order_id,provider_approval_url,provider_capture_id',
        idempotency_key: 'eq.' + idempotencyKey, limit: '1'
      }));
      let existing = await findExisting();
      if (!existing.ok) return error(res, 503, 'PAYMENT_ORDER_STORE_UNAVAILABLE');
      let order = existing.rows[0] || null;
      if (order) {
        const sameQuote = order.profile_id === session.profile.id && order.package_id === (selectedPackage ? selectedPackage.id : null)
          && Number(order.custom_coins || 0) === Number(customCoins || 0) && Number(order.amount_usd) === amountUSD;
        if (!sameQuote) return error(res, 409, 'IDEMPOTENCY_KEY_REUSED');
        if (order.state === 'credited') {
          return json(res, 200, { ok: true, idempotent: true, order: {
            id: order.id, state: 'credited', amountUSD: Number(order.amount_usd), coins,
            captureId: order.provider_capture_id || null, ledgerEntryId: order.credited_ledger_entry || null
          } });
        }
        if (!['created','approved'].includes(order.state)) return error(res, 409, 'PAYMENT_ORDER_NOT_OPEN', 'This idempotency key belongs to a payment order that is no longer open.');
        if (order.provider_order_id && order.provider_approval_url) {
          return json(res, 200, { ok: true, idempotent: true, order: {
            id: order.id, state: order.state, amountUSD: Number(order.amount_usd),
            coins, approvalUrl: order.provider_approval_url, providerOrderId: order.provider_order_id
          } });
        }
        return error(res, 409, 'PAYMENT_ORDER_INITIALIZATION_IN_PROGRESS');
      }
      const inserted = await adminRest(config, 'payment_orders', new URLSearchParams(), 'POST', {
        profile_id: session.profile.id,
        package_id: selectedPackage ? selectedPackage.id : null,
        custom_coins: customCoins,
        amount_usd: amountUSD,
        currency: 'USD',
        provider: 'paypal',
        idempotency_key: idempotencyKey,
        state: 'created'
      });
      if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) {
        existing = await findExisting();
        if (existing.ok && existing.rows[0]) return error(res, 409, 'PAYMENT_ORDER_INITIALIZATION_IN_PROGRESS');
        return error(res, 503, 'PAYMENT_ORDER_CREATE_FAILED', 'No checkout was created because the payment order could not be stored.');
      }
      order = inserted.data[0];
      const returnUrl = new URL('/', config.appBaseUrl);
      returnUrl.searchParams.set('payment', 'return');
      returnUrl.searchParams.set('order', order.id);
      const cancelUrl = new URL('/', config.appBaseUrl);
      cancelUrl.searchParams.set('payment', 'cancel');
      cancelUrl.searchParams.set('order', order.id);
      const providerOrder = await paypal.createOrder(config.paypal, {
        amountUSD, referenceId: order.id, requestId: order.id,
        returnUrl: returnUrl.toString(), cancelUrl: cancelUrl.toString()
      });
      if (!providerOrder.ok || !providerOrder.orderId || !providerOrder.approvalUrl) {
        await adminRest(config, 'payment_orders', query({ id: 'eq.' + order.id, state: 'eq.created' }), 'PATCH', {
          state: 'failed', updated_at: new Date().toISOString()
        });
        return error(res, 503, providerOrder.code || 'PAYPAL_ORDER_CREATE_FAILED', 'PayPal could not create an approval link. No coins have been credited.');
      }
      const saved = await adminRest(config, 'payment_orders', query({ id: 'eq.' + order.id, profile_id: 'eq.' + session.profile.id }), 'PATCH', {
        provider_order_id: providerOrder.orderId,
        provider_approval_url: providerOrder.approvalUrl,
        updated_at: new Date().toISOString()
      });
      if (!saved.ok) return error(res, 503, 'PAYPAL_ORDER_PERSIST_FAILED', 'PayPal order was created but not fully reconciled. Do not pay twice; retry with the same idempotency key.');
      return json(res, 201, { ok: true, order: {
        id: order.id, state: 'created', amountUSD, currency: 'USD', coins,
        provider: 'paypal', providerOrderId: providerOrder.orderId, approvalUrl: providerOrder.approvalUrl
      } });
    }

    const refundRoute = url.pathname.match(/^\/api\/payments\/orders\/([0-9a-f-]+)\/refund$/i);
    if (req.method === 'POST' && refundRoute) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      if (!config.configured.paypal) return error(res, 503, 'PAYMENTS_NOT_CONFIGURED');
      if (config.paypal.env === 'live' && (!config.features.productionPayments || !config.paypal.webhookId)) {
        return error(res, 503, 'PRODUCTION_REFUNDS_DISABLED');
      }
      const orderId = refundRoute[1];
      if (!uuid(orderId)) return error(res, 400, 'INVALID_PAYMENT_ORDER_ID');
      const body = await readBody(req);
      const rawKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey)) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const reason = typeof body.reasonCode === 'string' ? body.reasonCode : 'customer_request';
      if (!/^[A-Za-z0-9_.:-]{2,80}$/.test(reason)) return error(res, 400, 'INVALID_REFUND_REASON');
      const found = await selectAdminRows(config, 'payment_orders', query({
        select: 'id,profile_id,amount_usd,state,provider_capture_id,provider_order_id,credited_ledger_entry',
        id: 'eq.' + orderId, profile_id: 'eq.' + session.profile.id, limit: '1'
      }));
      if (!found.ok) return error(res, 503, 'PAYMENT_ORDER_UNAVAILABLE');
      const order = found.rows[0];
      if (!order) return error(res, 404, 'PAYMENT_ORDER_NOT_FOUND');
      const idempotencyKey = session.profile.id + ':refund:' + rawKey;
      const reservation = await adminRpc(config, 'reserve_coin_refund', {
        p_payment_order_id: order.id, p_profile_id: session.profile.id,
        p_idempotency_key: idempotencyKey, p_reason_code: reason
      });
      if (!reservation.ok) {
        const code = reservation.code || 'REFUND_RESERVATION_FAILED';
        if (code === 'REFUND_COIN_BALANCE_INSUFFICIENT') return error(res, 409, code, 'The unspent coin balance is insufficient for a full recharge refund.');
        if (code === 'REFUND_ALREADY_EXISTS' || code === 'PAYMENT_NOT_REFUNDABLE') return error(res, 409, code);
        return error(res, reservation.status === 503 ? 503 : 409, code, 'A refund reservation was not created.');
      }
      const refundId = typeof reservation.data === 'string' ? reservation.data : Array.isArray(reservation.data) ? reservation.data[0] : reservation.data && reservation.data.reserve_coin_refund;
      if (!uuid(String(refundId || ''))) return error(res, 503, 'REFUND_RESERVATION_RESULT_INVALID');
      const refundLookup = await selectAdminRows(config, 'refund_records', query({
        select: 'id,payment_order_id,requested_by,amount_usd,reason_code,state,provider_refund_id,idempotency_key,failure_code',
        id: 'eq.' + refundId, requested_by: 'eq.' + session.profile.id, limit: '1'
      }));
      if (!refundLookup.ok || !refundLookup.rows[0]) return error(res, 503, 'REFUND_STATUS_UNAVAILABLE');
      const refund = refundLookup.rows[0];
      if (refund.state === 'refunded') return json(res, 200, { ok: true, idempotent: true, refund: { id: refund.id, state: 'refunded', amountUSD: Number(refund.amount_usd) } });
      if (refund.state === 'failed') return error(res, 409, 'REFUND_ATTEMPT_FAILED', 'A prior definitive refund attempt failed and its reserved coins were released. Use a new idempotency key to retry.');
      if (refund.provider_refund_id) return json(res, 202, { ok: true, idempotent: true, refund: { id: refund.id, state: 'processing', providerRefundId: refund.provider_refund_id } });
      if (!order.provider_capture_id || order.state !== 'credited') return error(res, 409, 'PAYMENT_NOT_REFUNDABLE');

      const providerResult = await paypal.refundCapture(config.paypal, order.provider_capture_id, refund.id.replace(/-/g, '') + 'r');
      if (!providerResult.ok) {
        if (providerResult.status >= 500) {
          return json(res, 202, { ok: true, refund: { id: refund.id, state: 'processing' }, code: 'REFUND_RECONCILIATION_PENDING',
            message: 'PayPal outcome is uncertain. Coins remain reserved until a verified provider event reconciles the refund.' });
        }
        const released = await adminRpc(config, 'finalize_coin_refund', {
          p_refund_id: refund.id, p_provider_refund_id: null, p_succeeded: false, p_error_code: providerResult.code || 'PAYPAL_REFUND_REJECTED'
        });
        if (!released.ok) return error(res, 503, 'REFUND_RELEASE_RECONCILIATION_REQUIRED', 'Provider rejected the refund but the coin reservation release needs reconciliation.');
        return error(res, 409, 'PAYPAL_REFUND_REJECTED', 'PayPal rejected the refund. Reserved coins were released.');
      }
      if (providerResult.refundId) {
        await adminRest(config, 'refund_records', query({ id: 'eq.' + refund.id }), 'PATCH', {
          provider_refund_id: providerResult.refundId, updated_at: new Date().toISOString()
        });
      }
      if (providerResult.status === 'COMPLETED') {
        const finalized = await adminRpc(config, 'finalize_coin_refund', {
          p_refund_id: refund.id, p_provider_refund_id: providerResult.refundId, p_succeeded: true, p_error_code: null
        });
        if (!finalized.ok) return json(res, 202, { ok: true, refund: { id: refund.id, state: 'processing', providerRefundId: providerResult.refundId }, code: 'REFUND_FINALIZATION_PENDING' });
        return json(res, 200, { ok: true, refund: { id: refund.id, state: 'refunded', amountUSD: Number(refund.amount_usd), providerRefundId: providerResult.refundId } });
      }
      return json(res, 202, { ok: true, refund: { id: refund.id, state: 'processing', providerRefundId: providerResult.refundId || null }, code: 'REFUND_PENDING_PROVIDER_CONFIRMATION' });
    }

    const captureRoute = url.pathname.match(/^\/api\/payments\/orders\/([0-9a-f-]+)\/capture$/i);
    if (req.method === 'POST' && captureRoute) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const orderId = captureRoute[1];
      if (!uuid(orderId)) return error(res, 400, 'INVALID_PAYMENT_ORDER_ID');
      const found = await selectAdminRows(config, 'payment_orders', query({
        select: 'id,profile_id,package_id,custom_coins,amount_usd,currency,state,provider_order_id,provider_capture_id,credited_ledger_entry',
        id: 'eq.' + orderId, profile_id: 'eq.' + session.profile.id, limit: '1'
      }));
      if (!found.ok) return error(res, 503, 'PAYMENT_ORDER_UNAVAILABLE');
      const order = found.rows[0];
      if (!order) return error(res, 404, 'PAYMENT_ORDER_NOT_FOUND');
      if (order.state === 'credited') return json(res, 200, { ok: true, idempotent: true, order: { id: order.id, state: 'credited', ledgerEntryId: order.credited_ledger_entry } });
      if (!['created','approved','captured'].includes(order.state) || !order.provider_order_id) return error(res, 409, 'PAYMENT_ORDER_NOT_CAPTURABLE');
      const captured = await paypal.captureOrder(config.paypal, order.provider_order_id, order.id.replace(/-/g, '') + 'c');
      if (!captured.ok || captured.captureStatus !== 'COMPLETED' || !captured.captureId) {
        return error(res, captured.status === 503 ? 503 : 409, captured.code || 'PAYPAL_CAPTURE_NOT_CONFIRMED', 'PayPal has not confirmed a completed capture. No coins were credited.');
      }
      if (captured.currency !== order.currency || !Number.isFinite(captured.amountUSD) || Math.round(captured.amountUSD * 100) !== Math.round(Number(order.amount_usd) * 100)) {
        return error(res, 409, 'PAYPAL_CAPTURE_AMOUNT_MISMATCH', 'The capture amount did not match the stored payment order. Coins were not credited.');
      }
      const credited = await adminRpc(config, 'credit_captured_coin_order', {
        p_provider_order_id: order.provider_order_id,
        p_capture_id: captured.captureId,
        p_capture_amount: captured.amountUSD,
        p_currency: captured.currency
      });
      if (!credited.ok) return error(res, 503, 'PAYMENT_RECONCILIATION_REQUIRED', 'The capture could not yet be reconciled to the ZUNO ledger. Do not create another payment; a verified event may complete reconciliation.');
      const ledgerEntryId = typeof credited.data === 'string' ? credited.data : Array.isArray(credited.data) ? credited.data[0] : credited.data && credited.data.credit_captured_coin_order;
      let creditedCoins = Number(order.custom_coins || 0);
      if (!creditedCoins && order.package_id) {
        const packageResult = await selectAdminRows(config, 'coin_packages', query({
          select: 'coins', id: 'eq.' + order.package_id, limit: '1'
        }));
        if (!packageResult.ok || !packageResult.rows[0]) return error(res, 503, 'COIN_PACKAGE_RECONCILIATION_REQUIRED');
        creditedCoins = Number(packageResult.rows[0].coins);
      }
      return json(res, 200, { ok: true, order: { id: order.id, state: 'credited', captureId: captured.captureId, ledgerEntryId: ledgerEntryId || null, coins: creditedCoins } });
    }


    return error(res, 404, 'NOT_FOUND');
  } catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return error(res, 413, 'PAYLOAD_TOO_LARGE');
    if (e.message === 'INVALID_JSON') return error(res, 400, 'INVALID_JSON');
    return error(res, 400, 'BAD_REQUEST', e.message);
  }
});

if (require.main === module) server.listen(config.apiPort, '0.0.0.0', () => console.log('ZUNO API listening on port ' + config.apiPort));
module.exports = { server, config };
