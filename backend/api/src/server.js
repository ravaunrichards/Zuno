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
const { randomUUID, createHash } = require('node:crypto');
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
function readRawBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
function profileIdIn(ids) {
  const clean = [...new Set(ids.filter(uuid))];
  return clean.length ? 'in.(' + clean.join(',') + ')' : 'in.(00000000-0000-4000-8000-000000000000)';
}
async function requireStaffSession(req, res, allowedRoles = ['admin','moderator']) {
  const session = await authenticateProfile(req, config);
  if (!session.ok) { error(res, session.status || 401, session.code || 'AUTH_REQUIRED'); return null; }
  const roles = await selectAdminRows(config,'roles',query({select:'role',profile_id:'eq.'+session.profile.id}));
  if (!roles.ok) { error(res,503,'STAFF_ROLE_LOOKUP_FAILED','Operator authorization could not be verified.'); return null; }
  const assigned = new Set(roles.rows.map(row => row.role));
  if (!allowedRoles.some(role => assigned.has(role))) { error(res,403,'STAFF_ROLE_REQUIRED','This account is not authorized for this administrative operation.'); return null; }
  return session;
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
        const creatorSubscriptionEvents = new Set([
          'BILLING.SUBSCRIPTION.ACTIVATED','BILLING.SUBSCRIPTION.UPDATED',
          'BILLING.SUBSCRIPTION.CANCELLED','BILLING.SUBSCRIPTION.EXPIRED',
          'BILLING.SUBSCRIPTION.SUSPENDED','BILLING.SUBSCRIPTION.PAYMENT.FAILED'
        ]);
        if (creatorSubscriptionEvents.has(body.event_type)) {
          const providerSubscriptionId = body.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
            ? String(resource.billing_agreement_id || resource.subscription_id || resource.id || '')
            : String(resource.id || resource.billing_agreement_id || resource.subscription_id || '');
          if (!providerSubscriptionId) {
            processing = 'failed'; errorCode = 'CREATOR_SUBSCRIPTION_WEBHOOK_ID_MISSING';
          } else {
            let subscriptionRow = await selectAdminRows(config, 'creator_subscriptions', query({
              select: 'id,provider_subscription_id,state',
              provider_subscription_id: 'eq.' + providerSubscriptionId, limit: '1'
            }));
            if ((!subscriptionRow.ok || !subscriptionRow.rows.length) && uuid(String(resource.custom_id || ''))) {
              const localId = String(resource.custom_id);
              const byLocalId = await selectAdminRows(config, 'creator_subscriptions', query({
                select: 'id,provider_subscription_id,state',
                id: 'eq.' + localId, limit: '1'
              }));
              if (byLocalId.ok && byLocalId.rows.length) {
                const savedProvider = await adminRest(config, 'creator_subscriptions', query({ id: 'eq.' + localId }), 'PATCH', {
                  provider_subscription_id: providerSubscriptionId, updated_at: new Date().toISOString()
                });
                if (!savedProvider.ok) {
                  processing = 'failed'; errorCode = 'CREATOR_SUBSCRIPTION_PROVIDER_ID_PERSIST_FAILED';
                } else subscriptionRow = byLocalId;
              } else subscriptionRow = byLocalId;
            }
            if (processing !== 'failed') {
              if (!subscriptionRow.ok || !subscriptionRow.rows.length) {
                processing = 'failed'; errorCode = 'CREATOR_SUBSCRIPTION_NOT_FOUND';
              } else {
                let providerStatus = String(resource.status || '');
                if (body.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') providerStatus = 'ACTIVE';
                else if (body.event_type === 'BILLING.SUBSCRIPTION.CANCELLED') providerStatus = 'CANCELLED';
                else if (body.event_type === 'BILLING.SUBSCRIPTION.EXPIRED') providerStatus = 'EXPIRED';
                else if (body.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED' || body.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') providerStatus = 'SUSPENDED';
                if (!['APPROVAL_PENDING','APPROVED','ACTIVE','SUSPENDED','CANCELLED','EXPIRED'].includes(providerStatus)) {
                  processing = 'failed'; errorCode = 'CREATOR_SUBSCRIPTION_STATUS_INVALID';
                } else {
                  const nextRaw = resource.billing_info && resource.billing_info.next_billing_time;
                  const nextDate = nextRaw ? new Date(nextRaw) : null;
                  const nextBillingTime = nextDate && Number.isFinite(nextDate.getTime()) ? nextDate.toISOString() : null;
                  const synced = await adminRpc(config, 'sync_creator_subscription', {
                    p_provider_subscription_id: providerSubscriptionId,
                    p_provider_status: providerStatus,
                    p_next_billing_time: nextBillingTime,
                    p_provider_event_id: String(body.id)
                  });
                  if (!synced.ok) { processing = 'failed'; errorCode = 'CREATOR_SUBSCRIPTION_STATE_SYNC_FAILED'; }
                }
              }
            }
          }
        } else if (body.event_type === 'CHECKOUT.ORDER.APPROVED') {
          const providerOrderId = String(resource.id || '');
          if (providerOrderId) {
            const approvedCoin=await adminRest(config, 'payment_orders', query({
              provider_order_id: 'eq.' + providerOrderId, state: 'eq.created'
            }), 'PATCH', { state: 'approved', updated_at: new Date().toISOString() });
            if(!approvedCoin.ok){
              const approvedCommerce=await selectAdminRows(config,'commerce_orders',query({select:'id',provider_order_id:'eq.'+providerOrderId,status:'eq.pending_payment',limit:'1'}));
              if(!approvedCommerce.ok||!approvedCommerce.rows.length){processing='failed';errorCode='APPROVED_ORDER_LOOKUP_FAILED';}
            }
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
            const coinOrder = await selectAdminRows(config, 'payment_orders', query({
              select: 'id', provider_order_id: 'eq.' + providerOrderId, limit: '1'
            }));
            if (coinOrder.ok && coinOrder.rows.length) {
              const credit = await adminRpc(config, 'credit_captured_coin_order', {
                p_provider_order_id: providerOrderId, p_capture_id: captureId,
                p_capture_amount: amount, p_currency: currency
              });
              if (!credit.ok) { processing = 'failed'; errorCode = 'CAPTURE_CREDIT_RECONCILIATION_FAILED'; }
            } else {
              const commerceOrder = await selectAdminRows(config, 'commerce_orders', query({
                select: 'id', provider_order_id: 'eq.' + providerOrderId, limit: '1'
              }));
              if (commerceOrder.ok && commerceOrder.rows.length) {
                const completed = await adminRpc(config, 'complete_commerce_order', {
                  p_order_id: commerceOrder.rows[0].id,p_provider_capture_id: captureId,
                  p_capture_amount: amount,p_currency: currency
                });
                if (!completed.ok) { processing = 'failed'; errorCode = 'COMMERCE_CAPTURE_RECONCILIATION_FAILED'; }
              } else { processing = 'failed'; errorCode = 'CAPTURE_ORDER_NOT_FOUND'; }
            }
          }
        } else if (body.event_type === 'PAYMENT.CAPTURE.DENIED') {
          const relatedIds = resource.supplementary_data && resource.supplementary_data.related_ids || {};
          if (relatedIds.order_id) {
            const providerOrderId=String(relatedIds.order_id);
            const deniedCoin=await selectAdminRows(config,'payment_orders',query({select:'id',provider_order_id:'eq.'+providerOrderId,limit:'1'}));
            if(deniedCoin.ok&&deniedCoin.rows.length){
              await adminRest(config, 'payment_orders', query({
                provider_order_id: 'eq.' + providerOrderId,state:'in.(created,approved)'
              }), 'PATCH', { state: 'failed', updated_at: new Date().toISOString() });
            }else{
              const deniedCommerce=await selectAdminRows(config,'commerce_orders',query({select:'id,buyer_id',provider_order_id:'eq.'+providerOrderId,status:'eq.pending_payment',limit:'1'}));
              if(deniedCommerce.ok&&deniedCommerce.rows.length){
                const cancelled=await adminRpc(config,'cancel_commerce_order',{p_order_id:deniedCommerce.rows[0].id,p_buyer_profile_id:deniedCommerce.rows[0].buyer_id});
                if(!cancelled.ok){processing='failed';errorCode='COMMERCE_DENIED_ORDER_RELEASE_FAILED';}
              }
            }
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

    if (req.method === 'POST' && url.pathname === '/api/livekit/webhook') {
      if (!config.configured.livekit) return error(res, 503, 'LIVE_NOT_CONFIGURED');
      const rawBody = await readRawBody(req, MAX_REQUEST_BYTES);
      let body;
      try { body = JSON.parse(rawBody); } catch (_) { return error(res, 400, 'INVALID_WEBHOOK_JSON'); }
      const verified = await livekit.verifyWebhook(config.livekit, rawBody, req.headers.authorization);
      if (!verified.ok || !verified.verified) return error(res, 401, verified.code || 'LIVEKIT_WEBHOOK_SIGNATURE_INVALID');
      const event = verified.event || body;
      const eventType = typeof event.event === 'string' ? event.event : '';
      const roomInfo = event.room && typeof event.room === 'object' ? event.room : {};
      const roomId = String(roomInfo.name || '');
      const participantInfo = event.participant && typeof event.participant === 'object' ? event.participant : {};
      const profileId = String(participantInfo.identity || '');
      const providerEventId = 'livekit:' + String(event.id || createHash('sha256').update(rawBody).digest('hex'));
      const prior = await selectAdminRows(config, 'live_room_events', query({
        select: 'id,room_id,event_type,occurred_at',
        provider_event_id: 'eq.' + providerEventId,
        limit: '1'
      }));
      if (!prior.ok) return error(res, 503, 'LIVEKIT_WEBHOOK_IDEMPOTENCY_LOOKUP_FAILED');
      if (prior.rows.length) return json(res, 200, { ok: true, duplicate: true, eventId: providerEventId });
      if (!uuid(roomId)) return json(res, 200, { ok: true, ignored: true, reason: 'ROOM_NAME_NOT_ZUNO_UUID', eventType });
      const roomLookup = await selectAdminRows(config, 'live_rooms', query({
        select: 'id,host_id,state,is_private',
        id: 'eq.' + roomId,
        limit: '1'
      }));
      if (!roomLookup.ok) return error(res, 503, 'LIVEKIT_ROOM_LOOKUP_FAILED');
      if (!roomLookup.rows[0]) return error(res, 503, 'LIVEKIT_ROOM_NOT_PROVISIONED');
      const liveRoom = roomLookup.rows[0];
      const now = new Date().toISOString();
      const eventSeconds = Number(event.createdAt);
      const occurredAt = Number.isFinite(eventSeconds) && eventSeconds > 0
        ? new Date(eventSeconds * 1000).toISOString() : now;

      if (eventType === 'room_started') {
        const update = await adminRest(config, 'live_rooms', query({ id: 'eq.' + roomId, state: 'neq.ended' }), 'PATCH', {
          state: 'live', started_at: liveRoom.started_at || occurredAt, ended_at: null
        });
        if (!update.ok) return error(res, 503, 'LIVEKIT_ROOM_START_SYNC_FAILED');
      } else if (eventType === 'room_finished') {
        const update = await adminRest(config, 'live_rooms', query({ id: 'eq.' + roomId }), 'PATCH', {
          state: 'ended', ended_at: occurredAt
        });
        if (!update.ok) return error(res, 503, 'LIVEKIT_ROOM_END_SYNC_FAILED');
        await adminRest(config, 'live_participants', query({ room_id: 'eq.' + roomId, left_at: 'is.null' }), 'PATCH', { left_at: occurredAt });
        await adminRest(config, 'guest_requests', query({ room_id: 'eq.' + roomId, state: 'eq.pending' }), 'PATCH', { state: 'rejected', resolved_at: occurredAt });
        await adminRest(config, 'live_polls', query({ room_id: 'eq.' + roomId, state: 'eq.open' }), 'PATCH', { state: 'closed', closed_at: occurredAt });
      } else if (eventType === 'participant_joined' && uuid(profileId)) {
        const existing = await selectAdminRows(config, 'live_participants', query({
          select: 'room_id,profile_id,role',
          room_id: 'eq.' + roomId, profile_id: 'eq.' + profileId,
          limit: '1'
        }));
        if (!existing.ok) return error(res, 503, 'LIVEKIT_PARTICIPANT_LOOKUP_FAILED');
        if (existing.rows.length) {
          const patch = await adminRest(config, 'live_participants', query({
            room_id: 'eq.' + roomId, profile_id: 'eq.' + profileId
          }), 'PATCH', { joined_at: occurredAt, left_at: null });
          if (!patch.ok) return error(res, 503, 'LIVEKIT_PARTICIPANT_SYNC_FAILED');
        } else {
          const role = profileId === liveRoom.host_id ? 'host' : 'viewer';
          const created = await adminRest(config, 'live_participants', new URLSearchParams(), 'POST', {
            room_id: roomId, profile_id: profileId, role, joined_at: occurredAt, left_at: null
          });
          if (!created.ok) return error(res, 503, 'LIVEKIT_PARTICIPANT_SYNC_FAILED');
        }
      } else if ((eventType === 'participant_left' || eventType === 'participant_connection_aborted') && uuid(profileId)) {
        const update = await adminRest(config, 'live_participants', query({
          room_id: 'eq.' + roomId, profile_id: 'eq.' + profileId, left_at: 'is.null'
        }), 'PATCH', { left_at: occurredAt });
        if (!update.ok) return error(res, 503, 'LIVEKIT_PARTICIPANT_LEAVE_SYNC_FAILED');
      }

      const eventPayload = {
        event: eventType, roomName: roomInfo.name || null, roomSid: roomInfo.sid || null,
        participantIdentity: uuid(profileId) ? profileId : null,
        participantSid: participantInfo.sid || null,
        createdAt: event.createdAt || null
      };
      const saved = await adminRest(config, 'live_room_events', new URLSearchParams(), 'POST', {
        room_id: roomId, event_type: eventType || 'unknown',
        provider_event_id: providerEventId, payload: eventPayload, occurred_at: occurredAt
      });
      if (!saved.ok) {
        const check = await selectAdminRows(config, 'live_room_events', query({
          select: 'id', provider_event_id: 'eq.' + providerEventId, limit: '1'
        }));
        if (!check.ok || !check.rows.length) return error(res, 503, 'LIVEKIT_WEBHOOK_EVENT_STORE_FAILED');
      }
      return json(res, 200, { ok: true, duplicate: false, eventId: providerEventId, eventType });
    }

    if (req.method === 'GET' && url.pathname === '/api/live/rooms/mine') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await selectAdminRows(config, 'live_rooms', query({
        select: 'id,host_id,title,category,state,is_private,started_at,ended_at,created_at',
        host_id: 'eq.' + session.profile.id,
        order: 'created_at.desc', limit: '25'
      }));
      if (!result.ok) return badDatabase(res, result, 'LIVE_OWN_ROOMS_UNAVAILABLE');
      return json(res, 200, { ok: true, rooms: result.rows.map((room) => ({
        id: room.id, title: room.title || 'LIVE room', category: room.category || 'General',
        state: room.state, isPrivate: Boolean(room.is_private), startedAt: room.started_at || null,
        endedAt: room.ended_at || null, createdAt: room.created_at
      })) });
    }

    if (req.method === 'GET' && url.pathname === '/api/live/rooms') {
      const roomQuery = query({ select: 'id,host_id,title,category,state,is_private,started_at', state: 'eq.live', is_private: 'eq.false', order: 'started_at.desc.nullslast', limit: '24' });
      const rooms = await selectAdminRows(config, 'live_rooms', roomQuery);
      if (!rooms.ok) return json(res, 200, { ok: true, rooms: [], source: 'service-unavailable', unavailable: true });
      if (!rooms.rows.length) return json(res, 200, { ok: true, rooms: [], source: 'database' });
      const hosts = await selectAdminRows(config, 'profiles', query({ select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(rooms.rows.map((room) => room.host_id)) }));
      const hostById = new Map((hosts.rows || []).map((host) => [host.id, host]));
      const summaries = await adminRpc(config, 'get_live_room_summaries', { p_room_ids: rooms.rows.map((room) => room.id) });
      const summaryById = new Map((Array.isArray(summaries.data) ? summaries.data : []).map((item) => [item.room_id, item]));
      return json(res, 200, { ok: true, source: 'database', rooms: rooms.rows.map((room) => {
        const summary = summaryById.get(room.id) || {};
        return {
          ...safeRoom(room, hostById.get(room.host_id)),
          isPrivate: Boolean(room.is_private),
          viewerCount: Number(summary.viewer_count || 0),
          speakerCount: Number(summary.speaker_count || 0),
          pendingGuestRequests: Number(summary.pending_guest_requests || 0)
        };
      }) });
    }

    if (req.method === 'POST' && url.pathname === '/api/live/rooms') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const category = typeof body.category === 'string' ? body.category.trim() : 'General';
      if (title.length < 2 || title.length > 120) return error(res, 400, 'LIVE_ROOM_TITLE_INVALID');
      if (category.length < 2 || category.length > 80) return error(res, 400, 'LIVE_ROOM_CATEGORY_INVALID');
      if (body.isPrivate !== undefined && typeof body.isPrivate !== 'boolean') return error(res, 400, 'INVALID_LIVE_ROOM_PRIVACY');
      if (!config.configured.livekit) return error(res, 503, 'LIVE_NOT_CONFIGURED', 'LiveKit URL, API key and API secret must be configured. No room was created.');
      const roomId = randomUUID();
      const token = livekit.mintToken(config.livekit, { identity: session.profile.id, room: roomId, canPublish: true, canSubscribe: true, ttlSeconds: 900 });
      if (!token.ok) return error(res, token.status || 503, token.code || 'LIVE_NOT_CONFIGURED', token.message || 'LiveKit is not configured. No room was created.');
      const created = await adminRpc(config, 'create_live_room', {
        p_room_id: roomId, p_host_profile_id: session.profile.id, p_title: title,
        p_category: category, p_is_private: body.isPrivate === true
      });
      if (!created.ok) return badDatabase(res, created, 'LIVE_ROOM_CREATE_FAILED');
      return json(res, 201, {
        ok: true,
        room: { id: roomId, title, category, state: 'scheduled', isPrivate: body.isPrivate === true, hostProfileId: session.profile.id },
        livekit: { url: token.url, token: token.token, expiresAt: token.expiresAt },
        next: 'Connect to LiveKit and publish local tracks, then call POST /api/live/rooms/' + roomId + '/start.'
      });
    }

    const liveRoomStartMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/start$/i);
    if (req.method === 'POST' && liveRoomStartMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = liveRoomStartMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const started = await adminRpc(config, 'start_live_room', { p_room_id: roomId, p_host_profile_id: session.profile.id });
      if (!started.ok) return badDatabase(res, started, 'LIVE_ROOM_START_FAILED');
      return json(res, 200, { ok: true, room: { id: roomId, state: 'live', startedAt: new Date().toISOString() } });
    }

    const liveRoomEndMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/end$/i);
    if (req.method === 'POST' && liveRoomEndMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = liveRoomEndMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const ended = await adminRpc(config, 'end_live_room', { p_room_id: roomId, p_host_profile_id: session.profile.id });
      if (!ended.ok) return badDatabase(res, ended, 'LIVE_ROOM_END_FAILED');
      return json(res, 200, { ok: true, room: { id: roomId, state: 'ended' } });
    }

    const liveRoomJoinMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/join$/i);
    if (req.method === 'POST' && liveRoomJoinMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = liveRoomJoinMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      if (!config.configured.livekit) return error(res, 503, 'LIVE_NOT_CONFIGURED', 'LiveKit is not configured. No participant was joined.');
      const joined = await adminRpc(config, 'join_live_room', { p_room_id: roomId, p_profile_id: session.profile.id });
      if (!joined.ok) return badDatabase(res, joined, 'LIVE_ROOM_JOIN_FAILED');
      const role = typeof joined.data === 'string' ? joined.data.replace(/^"|"$/g,'') : joined.data && joined.data.join_live_room;
      const token = livekit.mintToken(config.livekit, {
        identity: session.profile.id, room: roomId,
        canPublish: role === 'host' || role === 'guest', canSubscribe: true, ttlSeconds: 900
      });
      if (!token.ok) {
        await adminRpc(config, 'leave_live_room', { p_room_id: roomId, p_profile_id: session.profile.id });
        return error(res, token.status || 503, token.code || 'LIVE_NOT_CONFIGURED', token.message || 'LiveKit token could not be issued.');
      }
      return json(res, 200, { ok: true, role: role || 'viewer', livekit: { url: token.url, token: token.token, expiresAt: token.expiresAt } });
    }

    const liveRoomLeaveMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/leave$/i);
    if (req.method === 'POST' && liveRoomLeaveMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = liveRoomLeaveMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const result = await adminRpc(config, 'leave_live_room', { p_room_id: roomId, p_profile_id: session.profile.id });
      if (!result.ok) return badDatabase(res, result, 'LIVE_ROOM_LEAVE_FAILED');
      return json(res, 200, { ok: true, roomId, state: 'left' });
    }

    const guestRequestCreateMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/guest-requests$/i);
    if (guestRequestCreateMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = guestRequestCreateMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const requestId = await adminRpc(config, 'create_live_guest_request', { p_room_id: roomId, p_requester_profile_id: session.profile.id });
      if (!requestId.ok) return badDatabase(res, requestId, 'LIVE_GUEST_REQUEST_FAILED');
      const id = typeof requestId.data === 'string' ? requestId.data.replace(/^"|"$/g,'') : requestId.data && requestId.data.create_live_guest_request;
      return json(res, 201, { ok: true, request: { id: id || null, roomId, state: 'pending' } });
    }

    if (guestRequestCreateMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = guestRequestCreateMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const rooms = await selectAdminRows(config, 'live_rooms', query({ select: 'id,host_id', id: 'eq.' + roomId, limit: '1' }));
      if (!rooms.ok) return badDatabase(res, rooms);
      if (!rooms.rows[0]) return error(res, 404, 'LIVE_ROOM_NOT_FOUND');
      if (rooms.rows[0].host_id !== session.profile.id) {
        const own = await selectAdminRows(config, 'guest_requests', query({
          select: 'id,room_id,requester_id,state,created_at,resolved_at',
          room_id: 'eq.' + roomId, requester_id: 'eq.' + session.profile.id,
          order: 'created_at.desc', limit: '1'
        }));
        if (!own.ok) return badDatabase(res, own);
        const row = own.rows[0];
        return json(res, 200, { ok: true, request: row ? {
          id: row.id, roomId: row.room_id, state: row.state, createdAt: row.created_at, resolvedAt: row.resolved_at
        } : null });
      }
      const pending = await selectAdminRows(config, 'guest_requests', query({
        select: 'id,room_id,requester_id,state,created_at', room_id: 'eq.' + roomId, state: 'eq.pending',
        order: 'created_at.asc', limit: '50'
      }));
      if (!pending.ok) return badDatabase(res, pending);
      const requesterIds = [...new Set(pending.rows.map((row) => row.requester_id).filter(uuid))];
      const profileRows = requesterIds.length ? await selectAdminRows(config, 'profiles', query({
        select: 'id,username,display_name,avatar_url', id: profileIdIn(requesterIds)
      })) : { ok: true, rows: [] };
      const profileMap = new Map((profileRows.rows || []).map((profile) => [profile.id, profile]));
      return json(res, 200, { ok: true, requests: pending.rows.map((row) => ({
        id: row.id, roomId: row.room_id, state: row.state, createdAt: row.created_at,
        requester: profileMap.has(row.requester_id) ? profileProjection(profileMap.get(row.requester_id)) : null
      })) });
    }

    const guestRequestActionMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/guest-requests\/([0-9a-f-]+)\/(accept|reject)$/i);
    if (req.method === 'POST' && guestRequestActionMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = guestRequestActionMatch[1];
      const requestId = guestRequestActionMatch[2];
      const action = guestRequestActionMatch[3].toLowerCase();
      if (!uuid(roomId) || !uuid(requestId)) return error(res, 400, 'INVALID_GUEST_REQUEST_ID');
      const rooms = await selectAdminRows(config, 'live_rooms', query({ select: 'id,host_id,state', id: 'eq.' + roomId, limit: '1' }));
      if (!rooms.ok) return badDatabase(res, rooms);
      if (!rooms.rows[0]) return error(res, 404, 'LIVE_ROOM_NOT_FOUND');
      if (rooms.rows[0].host_id !== session.profile.id) return error(res, 403, 'LIVE_HOST_REQUIRED');
      const requestRows = await selectAdminRows(config, 'guest_requests', query({ select: 'id,room_id,requester_id,state', id: 'eq.' + requestId, room_id: 'eq.' + roomId, limit: '1' }));
      if (!requestRows.ok || !requestRows.rows[0]) return error(res, 404, 'LIVE_GUEST_REQUEST_NOT_FOUND');
      if (action === 'reject') {
        const result = await adminRpc(config, 'reject_live_guest_request', { p_request_id: requestId, p_host_profile_id: session.profile.id });
        if (!result.ok) return badDatabase(res, result, 'LIVE_GUEST_REJECT_FAILED');
        return json(res, 200, { ok: true, requestId, state: 'rejected' });
      }
      const accepted = await adminRpc(config, 'accept_live_guest_request', { p_request_id: requestId, p_host_profile_id: session.profile.id });
      if (!accepted.ok) return badDatabase(res, accepted, 'LIVE_GUEST_ACCEPT_FAILED');
      if (accepted.data === null || accepted.data === undefined) return error(res, 409, 'LIVE_GUEST_REQUEST_EXPIRED', 'Guest request expired before it could be accepted.');
      return json(res, 200, {
        ok: true, requestId, state: 'accepted',
        guest: { profileId: requestRows.rows[0].requester_id },
        next: 'The guest must use their own signed-in session to join and obtain their own publishing token.'
      });
    }

    const liveChatMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/chat$/i);
    if (liveChatMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = liveChatMatch[1];
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const roomRows = await rowsForUser(session, 'live_rooms', { select: 'id,state', id: 'eq.' + roomId, limit: '1' });
      if (!roomRows.ok || !Array.isArray(roomRows.data) || !roomRows.data[0]) return error(res, 404, 'LIVE_ROOM_NOT_FOUND');
      const chat = await rowsForUser(session, 'live_chat_messages', {
        select: 'id,room_id,author_id,body,is_pinned,created_at', room_id: 'eq.' + roomId,
        deleted_at: 'is.null', order: 'created_at.desc', limit: '100'
      });
      if (!chat.ok || !Array.isArray(chat.data)) return badDatabase(res, chat, 'LIVE_CHAT_UNAVAILABLE');
      const authorIds = [...new Set(chat.data.map((item) => item.author_id).filter(uuid))];
      const authors = authorIds.length ? await rowsForUser(session, 'profiles', { select: 'id,username,display_name,avatar_url', id: profileIdIn(authorIds) }) : { ok: true, data: [] };
      const byId = new Map((authors.data || []).map((p) => [p.id,p]));
      return json(res,200,{ok:true,messages:chat.data.reverse().map(item=>({
        id:item.id,roomId:item.room_id,body:item.body,isPinned:Boolean(item.is_pinned),createdAt:item.created_at,
        author:profileProjection(byId.get(item.author_id))
      }))});
    }
    if (liveChatMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = liveChatMatch[1];
      if (!uuid(roomId)) return error(res,400,'INVALID_ROOM_ID');
      const body = await readBody(req);
      if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.trim().length > 2000) return error(res,400,'INVALID_LIVE_CHAT_MESSAGE');
      const result = await rowsForUser(session,'live_chat_messages',{select:'id,room_id,author_id,body,is_pinned,created_at'},{
        method:'POST',body:{room_id:roomId,author_id:session.profile.id,body:body.body.trim()}
      });
      if(!result.ok || !Array.isArray(result.data) || !result.data[0]) return badDatabase(res,result,'LIVE_CHAT_SEND_FAILED');
      return json(res,201,{ok:true,message:{id:result.data[0].id,roomId,body:result.data[0].body,createdAt:result.data[0].created_at}});
    }

    const livePollCollectionMatch = url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/polls$/i);
    if (livePollCollectionMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const roomId = livePollCollectionMatch[1];
      if (!uuid(roomId)) return error(res,400,'INVALID_ROOM_ID');
      const visiblePolls = await rowsForUser(session,'live_polls',{select:'id,room_id,host_id,question,state,closes_at,created_at,closed_at',room_id:'eq.'+roomId,order:'created_at.desc',limit:'20'});
      if(!visiblePolls.ok || !Array.isArray(visiblePolls.data)) return badDatabase(res,visiblePolls,'LIVE_POLLS_UNAVAILABLE');
      if(!visiblePolls.data.length)return json(res,200,{ok:true,polls:[]});
      const pollIds=visiblePolls.data.map(p=>p.id);
      const options=await rowsForUser(session,'live_poll_options',{select:'id,poll_id,label,position',poll_id:'in.('+pollIds.join(',')+')',order:'position.asc',limit:'200'});
      if(!options.ok || !Array.isArray(options.data))return badDatabase(res,options,'LIVE_POLL_OPTIONS_UNAVAILABLE');
      const votes=await selectAdminRows(config,'live_poll_votes',query({select:'poll_id,option_id,voter_id',poll_id:'in.('+pollIds.join(',')+')',limit:'10000'}));
      const countByOption=new Map();
      for(const vote of votes.rows||[]) countByOption.set(vote.option_id,(countByOption.get(vote.option_id)||0)+1);
      const optionByPoll=new Map();
      for(const option of options.data){if(!optionByPoll.has(option.poll_id))optionByPoll.set(option.poll_id,[]);optionByPoll.get(option.poll_id).push({...option,votes:countByOption.get(option.id)||0});}
      return json(res,200,{ok:true,polls:visiblePolls.data.map(p=>({...p,options:optionByPoll.get(p.id)||[]}))});
    }
    if (livePollCollectionMatch && req.method === 'POST') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const roomId=livePollCollectionMatch[1];
      if(!uuid(roomId))return error(res,400,'INVALID_ROOM_ID');
      const body=await readBody(req);
      const question=typeof body.question==='string'?body.question.trim():'';
      const options=Array.isArray(body.options)?body.options.filter(x=>typeof x==='string').map(x=>x.trim()):[];
      if(question.length<1||question.length>500)return error(res,400,'LIVE_POLL_QUESTION_INVALID');
      if(options.length<2||options.length>8||options.some(x=>x.length<1||x.length>200))return error(res,400,'LIVE_POLL_OPTION_COUNT_INVALID');
      const closesAt=body.closesAt?new Date(body.closesAt):null;
      if(body.closesAt&&(!closesAt||!Number.isFinite(closesAt.getTime())||closesAt<=new Date()))return error(res,400,'LIVE_POLL_CLOSE_TIME_INVALID');
      const result=await adminRpc(config,'create_live_poll',{p_room_id:roomId,p_host_profile_id:session.profile.id,p_question:question,p_options:options,p_closes_at:closesAt?closesAt.toISOString():null});
      if(!result.ok)return badDatabase(res,result,'LIVE_POLL_CREATE_FAILED');
      const pollId=typeof result.data==='string'?result.data.replace(/^"|"$/g,''):result.data&&result.data.create_live_poll;
      return json(res,201,{ok:true,poll:{id:pollId,roomId,question,state:'open',options:options.map((label,position)=>({label,position,votes:0})),closesAt:closesAt?closesAt.toISOString():null}});
    }

    const liveVoteMatch=url.pathname.match(/^\/api\/live\/polls\/([0-9a-f-]+)\/votes$/i);
    if(liveVoteMatch&&req.method==='POST'){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const pollId=liveVoteMatch[1];
      if(!uuid(pollId))return error(res,400,'INVALID_POLL_ID');
      const body=await readBody(req);
      if(!uuid(body.optionId))return error(res,400,'INVALID_POLL_OPTION_ID');
      const poll=await rowsForUser(session,'live_polls',{select:'id,state,closes_at',id:'eq.'+pollId,limit:'1'});
      if(!poll.ok||!Array.isArray(poll.data)||!poll.data[0])return error(res,404,'LIVE_POLL_NOT_FOUND');
      if(poll.data[0].state!=='open'||(poll.data[0].closes_at&&new Date(poll.data[0].closes_at)<=new Date()))return error(res,409,'LIVE_POLL_CLOSED');
      const vote=await rowsForUser(session,'live_poll_votes',{select:'poll_id,option_id,voter_id,created_at'},{method:'POST',body:{poll_id:pollId,option_id:body.optionId,voter_id:session.profile.id}});
      if(!vote.ok)return badDatabase(res,vote,'LIVE_POLL_VOTE_FAILED');
      return json(res,201,{ok:true,vote:Array.isArray(vote.data)?vote.data[0]:null});
    }

    const liveQuestionCollectionMatch=url.pathname.match(/^\/api\/live\/rooms\/([0-9a-f-]+)\/questions$/i);
    if(liveQuestionCollectionMatch&&req.method==='GET'){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const roomId=liveQuestionCollectionMatch[1];
      if(!uuid(roomId))return error(res,400,'INVALID_ROOM_ID');
      const questions=await rowsForUser(session,'live_questions',{select:'id,room_id,asker_id,body,state,selected_at,answered_at,created_at',room_id:'eq.'+roomId,order:'created_at.desc',limit:'100'});
      if(!questions.ok||!Array.isArray(questions.data))return badDatabase(res,questions,'LIVE_QUESTIONS_UNAVAILABLE');
      const profiles=await rowsForUser(session,'profiles',{select:'id,username,display_name,avatar_url',id:profileIdIn(questions.data.map(q=>q.asker_id))});
      const map=new Map((profiles.data||[]).map(p=>[p.id,p]));
      return json(res,200,{ok:true,questions:questions.data.map(q=>({id:q.id,roomId:q.room_id,body:q.body,state:q.state,selectedAt:q.selected_at,answeredAt:q.answered_at,createdAt:q.created_at,asker:profileProjection(map.get(q.asker_id))}))});
    }
    if(liveQuestionCollectionMatch&&req.method==='POST'){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const roomId=liveQuestionCollectionMatch[1];
      if(!uuid(roomId))return error(res,400,'INVALID_ROOM_ID');
      const body=await readBody(req);
      if(typeof body.body!=='string'||body.body.trim().length<1||body.body.trim().length>1500)return error(res,400,'INVALID_LIVE_QUESTION');
      const result=await rowsForUser(session,'live_questions',{select:'id,room_id,asker_id,body,state,created_at'},{method:'POST',body:{room_id:roomId,asker_id:session.profile.id,body:body.body.trim()}});
      if(!result.ok||!Array.isArray(result.data)||!result.data[0])return badDatabase(res,result,'LIVE_QUESTION_SUBMIT_FAILED');
      return json(res,201,{ok:true,question:result.data[0]});
    }
    const liveQuestionResolveMatch=url.pathname.match(/^\/api\/live\/questions\/([0-9a-f-]+)\/resolve$/i);
    if(liveQuestionResolveMatch&&req.method==='POST'){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const questionId=liveQuestionResolveMatch[1];
      if(!uuid(questionId))return error(res,400,'INVALID_QUESTION_ID');
      const body=await readBody(req);
      const state=['selected','answered','dismissed'].includes(body.state)?body.state:null;
      if(!state)return error(res,400,'INVALID_QUESTION_STATE');
      const found=await selectAdminRows(config,'live_questions',query({select:'id,room_id,state',id:'eq.'+questionId,limit:'1'}));
      if(!found.ok)return badDatabase(res,found);
      if(!found.rows[0])return error(res,404,'LIVE_QUESTION_NOT_FOUND');
      const rooms=await selectAdminRows(config,'live_rooms',query({select:'id,host_id',id:'eq.'+found.rows[0].room_id,limit:'1'}));
      if(!rooms.ok)return badDatabase(res,rooms);
      if(!rooms.rows[0]||rooms.rows[0].host_id!==session.profile.id)return error(res,403,'LIVE_HOST_REQUIRED');
      const patch={state,...(state==='selected'?{selected_at:new Date().toISOString()}:{}),...(state==='answered'?{answered_at:new Date().toISOString()}: {})};
      const updated=await rowsForUser(session,'live_questions',{id:'eq.'+questionId,select:'id,room_id,asker_id,body,state,selected_at,answered_at'},{method:'PATCH',body:patch});
      if(!updated.ok)return badDatabase(res,updated,'LIVE_QUESTION_RESOLUTION_FAILED');
      return json(res,200,{ok:true,question:Array.isArray(updated.data)?updated.data[0]:null});
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
      if (!host && !membership) return error(res, 403, 'LIVE_JOIN_REQUIRED', 'Join the room first so participant state is recorded.');
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

    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      const session=await requireStaffSession(req,res,['admin','moderator','finance','support']);
      if(!session)return;
      const result=await adminRpc(config,'get_admin_overview',{});
      if(!result.ok)return badDatabase(res,result,'ADMIN_OVERVIEW_UNAVAILABLE');
      const row=Array.isArray(result.data)?result.data[0]:result.data;
      if(!row)return error(res,503,'ADMIN_OVERVIEW_UNAVAILABLE');
      return json(res,200,{ok:true,overview:{
        profiles:Number(row.profile_count||0),posts:Number(row.post_count||0),liveRooms:Number(row.live_room_count||0),
        openReports:Number(row.open_report_count||0),reviewingReports:Number(row.reviewing_report_count||0),
        failedPaymentEvents:Number(row.failed_payment_event_count||0),pendingRefunds:Number(row.pending_refund_count||0),
        pendingPayouts:Number(row.pending_payout_count||0)
      }});
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/reports') {
      const session=await requireStaffSession(req,res,['admin','moderator']);
      if(!session)return;
      const state=url.searchParams.get('state')||'open';
      if(!['open','reviewing','appealed','actioned','dismissed','all'].includes(state))return error(res,400,'INVALID_REPORT_STATE');
      const limit=asSafeInt(url.searchParams.get('limit'),50,1,100);
      const params={select:'id,reporter_id,target_type,target_id,reason,state,created_at,resolved_at,resolution_code,resolution_note',order:'created_at.desc',limit:String(limit)};
      if(state!=='all')params.state='eq.'+state;
      const result=await selectAdminRows(config,'reports',query(params));
      if(!result.ok)return badDatabase(res,result,'MODERATION_QUEUE_UNAVAILABLE');
      return json(res,200,{ok:true,reports:result.rows.map(row=>({
        id:row.id,reporterId:row.reporter_id,targetType:row.target_type,targetId:row.target_id,
        reason:row.reason||'',state:row.state,createdAt:row.created_at,resolvedAt:row.resolved_at||null,
        resolutionCode:row.resolution_code||null,resolutionNote:row.resolution_note||null
      }))});
    }

    const adminResolveReportMatch=url.pathname.match(/^\/api\/admin\/reports\/([0-9a-f-]+)\/resolve$/i);
    if(req.method==='POST'&&adminResolveReportMatch){
      const session=await requireStaffSession(req,res,['admin','moderator']);
      if(!session)return;
      const reportId=adminResolveReportMatch[1];
      if(!uuid(reportId))return error(res,400,'INVALID_REPORT_ID');
      const body=await readBody(req);
      const decision=['dismiss','mark_reviewing','remove_content'].includes(body.decision)?body.decision:null;
      const reasonCode=typeof body.reasonCode==='string'?body.reasonCode.trim():'';
      const note=typeof body.note==='string'?body.note.trim():null;
      if(!decision)return error(res,400,'MODERATION_DECISION_INVALID');
      if(!/^[A-Za-z0-9_.:-]{2,80}$/.test(reasonCode))return error(res,400,'MODERATION_REASON_INVALID');
      if(note&&note.length>500)return error(res,400,'MODERATION_NOTE_TOO_LONG');
      const resolved=await adminRpc(config,'resolve_moderation_report',{
        p_report_id:reportId,p_moderator_profile_id:session.profile.id,p_decision:decision,p_reason_code:reasonCode,p_note:note
      });
      if(!resolved.ok)return badDatabase(res,resolved,'MODERATION_RESOLUTION_FAILED');
      const row=Array.isArray(resolved.data)?resolved.data[0]:resolved.data;
      if(!row)return error(res,503,'MODERATION_RESOLUTION_UNCONFIRMED');
      return json(res,200,{ok:true,report:{id:row.report_id,state:row.new_state},moderationActionId:row.moderation_action_id});
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
      const session=await requireStaffSession(req,res,['admin']);
      if(!session)return;
      const rows=await selectAdminRows(config,'audit_events',query({
        select:'id,actor_id,action,detail,created_at',order:'created_at.desc',limit:String(asSafeInt(url.searchParams.get('limit'),50,1,100))
      }));
      if(!rows.ok)return badDatabase(res,rows,'ADMIN_AUDIT_UNAVAILABLE');
      return json(res,200,{ok:true,events:rows.rows.map(row=>({id:row.id,actorId:row.actor_id,action:row.action,detail:row.detail||{},createdAt:row.created_at}))});
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/integrations') {
      const session=await requireStaffSession(req,res,['admin','finance','support']);
      if(!session)return;
      return json(res,200,{ok:true,integrations:{
        supabase:{configured:Boolean(config.configured.supabase),status:config.configured.supabase?'configured':'not_configured'},
        livekit:{configured:Boolean(config.configured.livekit),status:config.configured.livekit?'configured':'not_configured'},
        paypal:{configured:Boolean(config.configured.paypal),environment:config.paypal.env,status:config.configured.paypal?'configured':'not_configured',productionPaymentsEnabled:Boolean(config.features.productionPayments&&config.paypal.env==='live'&&config.paypal.webhookId)},
        payouts:{enabled:false,status:'disabled_until_provider_eligibility_and_reconciliation_are_verified'}
      }});
    }


    if (req.method === 'GET' && url.pathname === '/api/notifications/push-public-key') {
      const enabled = Boolean(config.configured.pushNotifications);
      return json(res, 200, { ok: true, enabled, publicKey: enabled ? config.notifications.pushVapidPublicKey : null,
        message: enabled ? null : 'Browser push is not configured on the server.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/notifications/push-subscriptions') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const found = await rowsForUser(session, 'push_subscriptions', {
        select: 'id,user_agent,created_at,last_used_at,revoked_at',
        profile_id: 'eq.' + session.profile.id, revoked_at: 'is.null',
        order: 'created_at.desc', limit: '50'
      });
      if (!found.ok || !Array.isArray(found.data)) return badDatabase(res, found, 'PUSH_SUBSCRIPTIONS_UNAVAILABLE');
      return json(res, 200, { ok: true, subscriptions: found.data.map(item => ({
        id: item.id, userAgent: item.user_agent || null, createdAt: item.created_at, lastUsedAt: item.last_used_at || null
      })), count: found.data.length, providerConfigured: Boolean(config.configured.pushNotifications) });
    }

    if (req.method === 'POST' && url.pathname === '/api/notifications/push-subscriptions') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      const keys = body.keys && typeof body.keys === 'object' ? body.keys : {};
      if (endpoint.length < 30 || endpoint.length > 2048) return error(res, 400, 'INVALID_PUSH_ENDPOINT');
      let parsedEndpoint;
      try { parsedEndpoint = new URL(endpoint); } catch (_) { return error(res, 400, 'INVALID_PUSH_ENDPOINT'); }
      if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.username || parsedEndpoint.password) return error(res, 400, 'INVALID_PUSH_ENDPOINT');
      const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
      const authKey = typeof keys.auth === 'string' ? keys.auth : '';
      if (!/^[A-Za-z0-9_-]{40,180}$/.test(p256dh) || !/^[A-Za-z0-9_-]{12,80}$/.test(authKey)) return error(res, 400, 'INVALID_PUSH_KEYS');
      if (!config.configured.pushNotifications) return error(res, 503, 'PUSH_PROVIDER_NOT_CONFIGURED', 'Browser push keys are not configured. The subscription was not saved.');
      const prior = await rowsForUser(session, 'push_subscriptions', {
        select: 'id,profile_id,endpoint,created_at',
        profile_id: 'eq.' + session.profile.id, endpoint: 'eq.' + endpoint, limit: '1'
      });
      if (!prior.ok || !Array.isArray(prior.data)) return badDatabase(res, prior, 'PUSH_SUBSCRIPTION_LOOKUP_FAILED');
      const row = {
        profile_id: session.profile.id, endpoint, p256dh_key: p256dh, auth_key: authKey,
        user_agent: String(req.headers['user-agent'] || '').slice(0,300),
        last_used_at: new Date().toISOString(), revoked_at: null
      };
      const result = prior.data[0]
        ? await rowsForUser(session, 'push_subscriptions', {
            profile_id: 'eq.' + session.profile.id, endpoint: 'eq.' + endpoint,
            select: 'id,created_at,last_used_at'
          }, { method: 'PATCH', body: row })
        : await rowsForUser(session, 'push_subscriptions', { select: 'id,created_at,last_used_at' }, { method: 'POST', body: row });
      if (!result.ok || !Array.isArray(result.data) || !result.data[0]) {
        return error(res, 409, 'PUSH_SUBSCRIPTION_SAVE_FAILED', 'The browser subscription could not be saved to this account.');
      }
      return json(res, prior.data[0] ? 200 : 201, { ok: true, idempotent: Boolean(prior.data[0]), subscription: {
        id: result.data[0].id, createdAt: result.data[0].created_at || null, lastUsedAt: result.data[0].last_used_at || null
      } });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/notifications/push-subscriptions') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      if (!endpoint || endpoint.length > 2048) return error(res, 400, 'INVALID_PUSH_ENDPOINT');
      let parsedEndpoint;
      try { parsedEndpoint = new URL(endpoint); } catch (_) { return error(res, 400, 'INVALID_PUSH_ENDPOINT'); }
      if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.username || parsedEndpoint.password) return error(res, 400, 'INVALID_PUSH_ENDPOINT');
      const result = await rowsForUser(session, 'push_subscriptions', {
        profile_id: 'eq.' + session.profile.id, endpoint: 'eq.' + endpoint, revoked_at: 'is.null', select: 'id,revoked_at'
      }, { method: 'PATCH', body: { revoked_at: new Date().toISOString() } });
      if (!result.ok) return badDatabase(res, result, 'PUSH_SUBSCRIPTION_REMOVE_FAILED');
      return json(res, 200, { ok: true, removed: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/notifications/preferences') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const queryPrefs = {
        select: 'profile_id,preferences,quiet_hours_start,quiet_hours_end,timezone,updated_at',
        profile_id: 'eq.' + session.profile.id, limit: '1'
      };
      const found = await rowsForUser(session, 'notification_preferences', queryPrefs);
      if (!found.ok || !Array.isArray(found.data)) return badDatabase(res, found, 'NOTIFICATION_PREFERENCES_UNAVAILABLE');
      let prefs = found.data[0];
      if (!prefs) {
        const created = await rowsForUser(session, 'notification_preferences', {
          select: 'profile_id,preferences,quiet_hours_start,quiet_hours_end,timezone,updated_at'
        }, { method: 'POST', body: { profile_id: session.profile.id } });
        if (!created.ok || !Array.isArray(created.data) || !created.data[0]) return badDatabase(res, created, 'NOTIFICATION_PREFERENCES_CREATE_FAILED');
        prefs = created.data[0];
      }
      return json(res, 200, { ok: true, preferences: {
        values: prefs.preferences || {},
        quietHoursStart: prefs.quiet_hours_start || null,
        quietHoursEnd: prefs.quiet_hours_end || null,
        timezone: prefs.timezone || 'America/Jamaica',
        updatedAt: prefs.updated_at
      }});
    }

    if (req.method === 'PATCH' && url.pathname === '/api/notifications/preferences') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const allowedFlags = new Set(['push','email','messages','live','creator','communities','events','marketing']);
      if (body.preferences !== undefined && (!body.preferences || typeof body.preferences !== 'object' || Array.isArray(body.preferences))) {
        return error(res, 400, 'INVALID_NOTIFICATION_PREFERENCES');
      }
      const requested = body.preferences || {};
      if (Object.keys(requested).some(key => !allowedFlags.has(key) || typeof requested[key] !== 'boolean')) {
        return error(res, 400, 'INVALID_NOTIFICATION_PREFERENCES', 'Use boolean values for supported notification categories only.');
      }
      const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      for (const key of ['quietHoursStart','quietHoursEnd']) {
        if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== 'string' || !timePattern.test(body[key]))) {
          return error(res, 400, 'INVALID_QUIET_HOURS');
        }
      }
      if ((body.quietHoursStart === null) !== (body.quietHoursEnd === null) &&
          (body.quietHoursStart === null || body.quietHoursEnd === null)) return error(res, 400, 'QUIET_HOURS_PAIR_REQUIRED');
      if (body.timezone !== undefined) {
        if (typeof body.timezone !== 'string' || body.timezone.length > 100) return error(res, 400, 'INVALID_NOTIFICATION_TIMEZONE');
        try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).format(new Date()); }
        catch (_) { return error(res, 400, 'INVALID_NOTIFICATION_TIMEZONE'); }
      }
      const current = await rowsForUser(session, 'notification_preferences', {
        select: 'profile_id,preferences,quiet_hours_start,quiet_hours_end,timezone',
        profile_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!current.ok || !Array.isArray(current.data)) return badDatabase(res, current, 'NOTIFICATION_PREFERENCES_LOOKUP_FAILED');
      const prior = current.data[0] || { preferences: { push:true,email:false,messages:true,live:true,creator:true }, quiet_hours_start:null, quiet_hours_end:null };
      const updates = {
        preferences: { ...(prior.preferences || {}), ...requested },
        updated_at: new Date().toISOString()
      };
      if (body.quietHoursStart !== undefined) updates.quiet_hours_start = body.quietHoursStart;
      if (body.quietHoursEnd !== undefined) updates.quiet_hours_end = body.quietHoursEnd;
      if (body.timezone !== undefined) updates.timezone = body.timezone;
      const saved = current.data[0]
        ? await rowsForUser(session,'notification_preferences',{select:'profile_id,preferences,quiet_hours_start,quiet_hours_end,timezone,updated_at',profile_id:'eq.'+session.profile.id},{method:'PATCH',body:updates})
        : await rowsForUser(session,'notification_preferences',{select:'profile_id,preferences,quiet_hours_start,quiet_hours_end,timezone,updated_at'},{method:'POST',body:{profile_id:session.profile.id,...updates}});
      if (!saved.ok || !Array.isArray(saved.data) || !saved.data[0]) return badDatabase(res, saved, 'NOTIFICATION_PREFERENCES_SAVE_FAILED');
      return json(res, 200, { ok:true, preferences:{
        values:saved.data[0].preferences || {}, quietHoursStart:saved.data[0].quiet_hours_start || null,
        quietHoursEnd:saved.data[0].quiet_hours_end || null, timezone:saved.data[0].timezone || 'America/Jamaica', updatedAt:saved.data[0].updated_at
      }});
    }

    if (req.method === 'GET' && url.pathname === '/api/privacy/consents') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const rows = await rowsForUser(session,'privacy_consents',{
        select:'id,purpose,status,policy_version,recorded_at,idempotency_key',
        profile_id:'eq.'+session.profile.id,order:'recorded_at.desc',limit:'250'
      });
      if(!rows.ok||!Array.isArray(rows.data))return badDatabase(res,rows,'PRIVACY_CONSENTS_UNAVAILABLE');
      return json(res,200,{ok:true,consents:rows.data.map(item=>({
        id:item.id,purpose:item.purpose,status:item.status,policyVersion:item.policy_version,recordedAt:item.recorded_at
      }))});
    }

    if (req.method === 'POST' && url.pathname === '/api/privacy/consents') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const purposes = new Set(['personalization','analytics','personalized_ads','marketing','third_party_measurement','notifications']);
      if (!purposes.has(body.purpose)) return error(res,400,'INVALID_CONSENT_PURPOSE');
      if (!['granted','denied','withdrawn'].includes(body.status)) return error(res,400,'INVALID_CONSENT_STATUS');
      const policyVersion=typeof body.policyVersion==='string'?body.policyVersion.trim():'';
      if(!/^[A-Za-z0-9._:-]{1,80}$/.test(policyVersion))return error(res,400,'INVALID_POLICY_VERSION');
      const key=String(req.headers['idempotency-key']||body.idempotencyKey||'');
      if(!/^[A-Za-z0-9._:-]{16,180}$/.test(key))return error(res,400,'IDEMPOTENCY_KEY_REQUIRED');
      const prior=await rowsForUser(session,'privacy_consents',{
        select:'id,purpose,status,policy_version,recorded_at',
        profile_id:'eq.'+session.profile.id,idempotency_key:'eq.'+key,limit:'1'
      });
      if(!prior.ok||!Array.isArray(prior.data))return badDatabase(res,prior,'PRIVACY_CONSENT_LOOKUP_FAILED');
      if(prior.data[0])return json(res,200,{ok:true,idempotent:true,consent:{
        id:prior.data[0].id,purpose:prior.data[0].purpose,status:prior.data[0].status,
        policyVersion:prior.data[0].policy_version,recordedAt:prior.data[0].recorded_at
      }});
      const saved=await rowsForUser(session,'privacy_consents',{select:'id,purpose,status,policy_version,recorded_at'},{
        method:'POST',body:{profile_id:session.profile.id,purpose:body.purpose,status:body.status,policy_version:policyVersion,idempotency_key:key}
      });
      if(!saved.ok||!Array.isArray(saved.data)||!saved.data[0])return badDatabase(res,saved,'PRIVACY_CONSENT_SAVE_FAILED');
      return json(res,201,{ok:true,consent:{
        id:saved.data[0].id,purpose:saved.data[0].purpose,status:saved.data[0].status,
        policyVersion:saved.data[0].policy_version,recordedAt:saved.data[0].recorded_at
      }});
    }

    if (req.method === 'GET' && url.pathname === '/api/privacy/data-requests') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const rows=await rowsForUser(session,'data_requests',{
        select:'id,request_type,state,requested_at,updated_at,completed_at,result_storage_path,resolution_code,request_reason',
        profile_id:'eq.'+session.profile.id,order:'requested_at.desc',limit:'100'
      });
      if(!rows.ok||!Array.isArray(rows.data))return badDatabase(res,rows,'DATA_REQUESTS_UNAVAILABLE');
      return json(res,200,{ok:true,requests:rows.data.map(item=>({
        id:item.id,requestType:item.request_type,state:item.state,requestedAt:item.requested_at,updatedAt:item.updated_at,
        completedAt:item.completed_at,resultAvailable:Boolean(item.result_storage_path),resolutionCode:item.resolution_code,
        reason:item.request_reason||null
      }))});
    }

    if (req.method === 'POST' && url.pathname === '/api/privacy/data-requests') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body=await readBody(req);
      const requestType=String(body.requestType||'');
      if(!['export','deletion','correction','restriction'].includes(requestType))return error(res,400,'INVALID_DATA_REQUEST_TYPE');
      const reason=typeof body.reason==='string'?body.reason.trim():'';
      if(reason.length>2000)return error(res,400,'DATA_REQUEST_REASON_TOO_LONG');
      const key=String(req.headers['idempotency-key']||body.idempotencyKey||'');
      if(!/^[A-Za-z0-9._:-]{16,180}$/.test(key))return error(res,400,'IDEMPOTENCY_KEY_REQUIRED');
      const prior=await rowsForUser(session,'data_requests',{
        select:'id,request_type,state,requested_at,updated_at,completed_at,result_storage_path,resolution_code,request_reason',
        profile_id:'eq.'+session.profile.id,idempotency_key:'eq.'+key,limit:'1'
      });
      if(!prior.ok||!Array.isArray(prior.data))return badDatabase(res,prior,'DATA_REQUEST_LOOKUP_FAILED');
      if(prior.data[0])return json(res,200,{ok:true,idempotent:true,request:{
        id:prior.data[0].id,requestType:prior.data[0].request_type,state:prior.data[0].state,
        requestedAt:prior.data[0].requested_at,resultAvailable:Boolean(prior.data[0].result_storage_path)
      }});
      const open=await rowsForUser(session,'data_requests',{
        select:'id,request_type,state,requested_at',profile_id:'eq.'+session.profile.id,
        request_type:'eq.'+requestType,state:'in.(submitted,reviewing,processing)',limit:'1'
      });
      if(!open.ok||!Array.isArray(open.data))return badDatabase(res,open,'DATA_REQUEST_OPEN_LOOKUP_FAILED');
      if(open.data[0])return json(res,200,{ok:true,existingOpenRequest:true,request:{
        id:open.data[0].id,requestType:open.data[0].request_type,state:open.data[0].state,requestedAt:open.data[0].requested_at
      },message:'An open request of this type already exists. It has not been marked completed.'});
      const saved=await rowsForUser(session,'data_requests',{select:'id,request_type,state,requested_at,updated_at,request_reason'},{
        method:'POST',body:{profile_id:session.profile.id,request_type:requestType,request_reason:reason||null,idempotency_key:key,state:'submitted'}
      });
      if(!saved.ok||!Array.isArray(saved.data)||!saved.data[0])return badDatabase(res,saved,'DATA_REQUEST_CREATE_FAILED');
      return json(res,202,{ok:true,request:{
        id:saved.data[0].id,requestType:saved.data[0].request_type,state:saved.data[0].state,requestedAt:saved.data[0].requested_at
      },message:'Request recorded. It is pending processing; no export, deletion or restriction is claimed completed yet.'});
    }

    if (req.method === 'GET' && url.pathname === '/api/reports/mine') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const result=await rowsForUser(session,'reports',{
        select:'id,target_type,target_id,reason,state,created_at',
        reporter_id:'eq.'+session.profile.id,order:'created_at.desc',limit:'100'
      });
      if(!result.ok||!Array.isArray(result.data))return badDatabase(res,result,'REPORTS_UNAVAILABLE');
      return json(res,200,{ok:true,reports:result.data});
    }

    if (req.method === 'POST' && url.pathname === '/api/reports') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const body=await readBody(req);
      const targetType=String(body.targetType||'');
      const targetId=String(body.targetId||'');
      const reason=typeof body.reason==='string'?body.reason.trim():'';
      const targetTable={profile:'profiles',post:'posts',comment:'comments',live_room:'live_rooms',community:'communities',message:'messages',marketplace_listing:'marketplace_listings'};
      if(!targetTable[targetType]||!uuid(targetId))return error(res,400,'INVALID_REPORT_TARGET');
      if(reason.length<1||reason.length>2000)return error(res,400,'INVALID_REPORT_REASON');
      const exists=await rowsForUser(session,targetTable[targetType],{select:'id',id:'eq.'+targetId,limit:'1'});
      if(!exists.ok||!Array.isArray(exists.data)||!exists.data[0])return error(res,404,'REPORT_TARGET_NOT_FOUND');
      const saved=await rowsForUser(session,'reports',{select:'id,target_type,target_id,reason,state,created_at'},{
        method:'POST',body:{reporter_id:session.profile.id,target_type:targetType,target_id:targetId,reason,state:'open'}
      });
      if(!saved.ok||!Array.isArray(saved.data)||!saved.data[0])return badDatabase(res,saved,'REPORT_CREATE_FAILED');
      return json(res,201,{ok:true,report:saved.data[0]});
    }

    if (req.method === 'GET' && url.pathname === '/api/moderation/appeals/mine') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const rows=await rowsForUser(session,'moderation_appeals',{
        select:'id,report_id,target_type,target_id,reason,state,resolution_note,created_at,resolved_at',
        appellant_id:'eq.'+session.profile.id,order:'created_at.desc',limit:'100'
      });
      if(!rows.ok||!Array.isArray(rows.data))return badDatabase(res,rows,'MODERATION_APPEALS_UNAVAILABLE');
      return json(res,200,{ok:true,appeals:rows.data});
    }

    if (req.method === 'POST' && url.pathname === '/api/moderation/appeals') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const body=await readBody(req);
      const targetType=String(body.targetType||''),targetId=String(body.targetId||'');
      const reason=typeof body.reason==='string'?body.reason.trim():'';
      const key=String(req.headers['idempotency-key']||body.idempotencyKey||'');
      if(!['profile','post','comment','live_room','community','marketplace_listing'].includes(targetType)||!uuid(targetId))return error(res,400,'INVALID_APPEAL_TARGET');
      if(reason.length<1||reason.length>4000)return error(res,400,'INVALID_APPEAL_REASON');
      if(!/^[A-Za-z0-9._:-]{16,180}$/.test(key))return error(res,400,'IDEMPOTENCY_KEY_REQUIRED');
      let owns=false;
      if(targetType==='profile')owns=targetId===session.profile.id;
      else{
        const ownerTable={post:['posts','author_id'],comment:['comments','author_id'],live_room:['live_rooms','host_id'],community:['communities','owner_id'],marketplace_listing:['marketplace_listings','seller_id']}[targetType];
        const check=await rowsForUser(session,ownerTable[0],{select:'id,'+ownerTable[1],id:'eq.'+targetId,limit:'1'});
        owns=Boolean(check.ok&&Array.isArray(check.data)&&check.data[0]&&check.data[0][ownerTable[1]]===session.profile.id);
      }
      if(!owns)return error(res,403,'APPEAL_TARGET_NOT_OWNED','You can only appeal moderation actions on content or accounts you own.');
      let reportId=null;
      if(body.reportId){
        if(!uuid(String(body.reportId)))return error(res,400,'INVALID_APPEAL_REPORT_ID');
        const report=await selectAdminRows(config,'reports',query({select:'id,target_type,target_id',id:'eq.'+body.reportId,limit:'1'}));
        if(!report.ok||!report.rows[0]||report.rows[0].target_type!==targetType||report.rows[0].target_id!==targetId)return error(res,404,'APPEAL_REPORT_NOT_FOUND');
        reportId=report.rows[0].id;
      }
      const prior=await rowsForUser(session,'moderation_appeals',{select:'id,target_type,target_id,state',appellant_id:'eq.'+session.profile.id,idempotency_key:'eq.'+key,limit:'1'});
      if(!prior.ok||!Array.isArray(prior.data))return badDatabase(res,prior,'MODERATION_APPEAL_LOOKUP_FAILED');
      if(prior.data[0])return json(res,200,{ok:true,idempotent:true,appeal:prior.data[0]});
      const saved=await rowsForUser(session,'moderation_appeals',{select:'id,report_id,target_type,target_id,reason,state,created_at'},{
        method:'POST',body:{appellant_id:session.profile.id,report_id:reportId,target_type:targetType,target_id:targetId,reason,state:'submitted',idempotency_key:key}
      });
      if(!saved.ok||!Array.isArray(saved.data)||!saved.data[0])return badDatabase(res,saved,'MODERATION_APPEAL_CREATE_FAILED');
      return json(res,201,{ok:true,appeal:saved.data[0]});
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

    if (req.method === 'GET' && url.pathname === '/api/search') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const term = String(url.searchParams.get('q') || '').normalize('NFKC').trim();
      const type = String(url.searchParams.get('type') || 'all');
      if (term.length < 2 || term.length > 80 || !/^[\p{L}\p{N}\p{Zs}._@'-]{2,80}$/u.test(term)) return error(res, 400, 'INVALID_SEARCH_QUERY');
      if (!['all','profiles','posts','communities','events'].includes(type)) return error(res, 400, 'INVALID_SEARCH_TYPE');
      const pattern = 'ilike.*' + term.replace(/[.*]/g, '') + '*';
      const jobs = [];
      if (type === 'all' || type === 'profiles') jobs.push(['profiles', rowsForUser(session, 'profiles', {
        select: 'id,username,display_name,avatar_url,is_verified,visibility',
        or: '(username.' + pattern + ',display_name.' + pattern + ')',
        limit: '10'
      })]);
      if (type === 'all' || type === 'posts') jobs.push(['posts', rowsForUser(session, 'posts', {
        select: 'id,author_id,kind,caption,audience,created_at',
        caption: pattern, deleted_at: 'is.null', order: 'created_at.desc', limit: '10'
      })]);
      if (type === 'all' || type === 'communities') jobs.push(['communities', rowsForUser(session, 'communities', {
        select: 'id,owner_id,name,access,created_at', name: pattern, limit: '10'
      })]);
      if (type === 'all' || type === 'events') jobs.push(['events', rowsForUser(session, 'events', {
        select: 'id,host_id,title,description,starts_at,ends_at,tz,created_at',
        title: pattern, order: 'starts_at.asc', limit: '10'
      })]);
      const settled = await Promise.all(jobs.map(async ([name, promise]) => [name, await promise]));
      const failures = settled.filter(([, result]) => !result.ok || !Array.isArray(result.data)).map(([name]) => name);
      if (failures.length === settled.length) return error(res, 503, 'SEARCH_UNAVAILABLE');
      const data = Object.fromEntries(settled.map(([name, result]) => [name, {
        ok: Boolean(result.ok && Array.isArray(result.data)),
        rows: result.ok && Array.isArray(result.data) ? result.data : []
      }]));
      const profileIds = [...new Set([
        ...(data.posts?.rows || []).map(row => row.author_id),
        ...(data.communities?.rows || []).map(row => row.owner_id),
        ...(data.events?.rows || []).map(row => row.host_id)
      ].filter(uuid))];
      const authors = profileIds.length ? await rowsForUser(session, 'profiles', {
        select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(profileIds)
      }) : { ok: true, data: [] };
      const authorById = new Map((authors.data || []).map(profile => [profile.id, profile]));
      return json(res, 200, {
        ok: true, query: term, partial: failures.length > 0, unavailableTypes: failures,
        results: {
          profiles: (data.profiles?.rows || []).map(profile => ({
            id: profile.id, username: profile.username, displayName: profile.display_name || profile.username,
            avatarUrl: profile.avatar_url || null, isVerified: Boolean(profile.is_verified)
          })),
          posts: (data.posts?.rows || []).map(post => ({
            id: post.id, kind: post.kind, caption: post.caption || '', audience: post.audience,
            createdAt: post.created_at, author: profileProjection(authorById.get(post.author_id))
          })),
          communities: (data.communities?.rows || []).map(item => ({
            id: item.id, name: item.name, access: item.access, owner: profileProjection(authorById.get(item.owner_id))
          })),
          events: (data.events?.rows || []).map(item => ({
            id: item.id, title: item.title, description: item.description || '',
            startsAt: item.starts_at, endsAt: item.ends_at, timezone: item.tz,
            host: profileProjection(authorById.get(item.host_id))
          }))
        }
      });
    }


    if (req.method === 'GET' && url.pathname === '/api/stories') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const now = new Date().toISOString();
      const result = await rowsForUser(session, 'stories', {
        select: 'id,author_id,media_asset_id,caption,audience,expires_at,created_at',
        expires_at: 'gt.' + now, deleted_at: 'is.null',
        order: 'created_at.desc', limit: '100'
      });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'STORIES_UNAVAILABLE');
      if (!result.data.length) return json(res, 200, { ok: true, stories: [] });

      const authorIds = [...new Set(result.data.map(story => story.author_id).filter(uuid))];
      const assetIds = [...new Set(result.data.map(story => story.media_asset_id).filter(uuid))];
      const [authors, assets] = await Promise.all([
        authorIds.length ? selectAdminRows(config, 'profiles', query({
          select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(authorIds), limit: String(authorIds.length)
        })) : { ok: true, rows: [] },
        assetIds.length ? selectAdminRows(config, 'media_assets', query({
          select: 'id,uploader_id,storage_path,media_type,mime_type,state,width,height,duration_ms',
          id: profileIdIn(assetIds), limit: String(assetIds.length)
        })) : { ok: true, rows: [] }
      ]);
      if (!authors.ok || !assets.ok) return error(res, 503, 'STORY_METADATA_UNAVAILABLE');
      const authorById = new Map(authors.rows.map(profile => [profile.id, profile]));
      const assetById = new Map(assets.rows.map(asset => [asset.id, asset]));
      const readyAssets = [...assetById.values()].filter(asset => asset.state === 'ready' && typeof asset.storage_path === 'string');
      let signedByPath = new Map();
      if (readyAssets.length) {
        const signed = await storage.createSignedDownloadUrls(config, config.storageBucket, readyAssets.map(asset => asset.storage_path), config.mediaSignedUrlTtlSeconds);
        if (signed.ok) signedByPath = new Map(signed.signedUrls.map(item => [item.path, item.signedUrl]));
      }
      const viewRows = await rowsForUser(session, 'story_views', {
        select: 'story_id,viewer_id,viewed_at,completed',
        viewer_id: 'eq.' + session.profile.id, story_id: 'in.(' + result.data.map(story => story.id).join(',') + ')',
        limit: '100'
      });
      if (!viewRows.ok || !Array.isArray(viewRows.data)) return badDatabase(res, viewRows, 'STORY_VIEW_STATE_UNAVAILABLE');
      const viewedIds = new Set(viewRows.data.map(row => row.story_id));
      return json(res, 200, { ok: true, stories: result.data.map(story => {
        const asset = story.media_asset_id ? assetById.get(story.media_asset_id) : null;
        const url = asset && asset.state === 'ready' ? signedByPath.get(asset.storage_path) || null : null;
        return {
          id: story.id, caption: story.caption || '', audience: story.audience,
          createdAt: story.created_at, expiresAt: story.expires_at,
          isMine: story.author_id === session.profile.id, viewedByMe: viewedIds.has(story.id),
          author: profileProjection(authorById.get(story.author_id)),
          media: asset ? {
            assetId: asset.id, mediaType: asset.media_type, mimeType: asset.mime_type,
            url, state: asset.state, width: asset.width || null, height: asset.height || null,
            durationMs: asset.duration_ms || null
          } : { url: null, state: 'unavailable' }
        };
      }) });
    }

    if (req.method === 'POST' && url.pathname === '/api/stories') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const assetId = String(body.mediaAssetId || '');
      if (!uuid(assetId)) return error(res, 400, 'STORY_MEDIA_ASSET_REQUIRED');
      const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
      if (caption.length > 2000) return error(res, 400, 'STORY_CAPTION_TOO_LONG');
      const audience = typeof body.audience === 'string' ? body.audience : 'public';
      if (!['public','followers','close_friends'].includes(audience)) return error(res, 400, 'STORY_AUDIENCE_INVALID');
      const asset = await rowsForUser(session, 'media_assets', {
        select: 'id,uploader_id,storage_path,media_type,mime_type,state,byte_size',
        id: 'eq.' + assetId, uploader_id: 'eq.' + session.profile.id, state: 'eq.ready', limit: '1'
      });
      if (!asset.ok) return badDatabase(res, asset, 'STORY_MEDIA_LOOKUP_FAILED');
      if (!Array.isArray(asset.data) || !asset.data[0]) return error(res, 409, 'STORY_MEDIA_NOT_READY', 'Only media already processed and marked ready can be shared as a story.');
      if (!['image','video','audio'].includes(asset.data[0].media_type)) return error(res, 400, 'STORY_MEDIA_TYPE_NOT_SUPPORTED');
      const created = await rowsForUser(session, 'stories', {
        select: 'id,author_id,media_asset_id,caption,audience,expires_at,created_at'
      }, { method: 'POST', body: {
        author_id: session.profile.id, media_asset_id: assetId, media_url: null,
        caption: caption || null, audience
      } });
      if (!created.ok || !Array.isArray(created.data) || !created.data[0]) return badDatabase(res, created, 'STORY_CREATE_FAILED');
      const story = created.data[0];
      return json(res, 201, { ok: true, story: {
        id: story.id, caption: story.caption || '', audience: story.audience,
        createdAt: story.created_at, expiresAt: story.expires_at, isMine: true,
        media: { assetId, mediaType: asset.data[0].media_type, state: 'ready' }
      } });
    }

    const storyIdMatch = url.pathname.match(/^\/api\/stories\/([0-9a-f-]+)$/i);
    if (storyIdMatch && req.method === 'DELETE') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const storyId = storyIdMatch[1];
      if (!uuid(storyId)) return error(res, 400, 'INVALID_STORY_ID');
      const removed = await rowsForUser(session, 'stories', {
        id: 'eq.' + storyId, author_id: 'eq.' + session.profile.id, deleted_at: 'is.null',
        select: 'id,author_id,deleted_at'
      }, { method: 'PATCH', body: { deleted_at: new Date().toISOString() } });
      if (!removed.ok) return badDatabase(res, removed, 'STORY_DELETE_FAILED');
      if (!Array.isArray(removed.data) || !removed.data[0]) return error(res, 404, 'OWN_STORY_NOT_FOUND');
      return json(res, 200, { ok: true, storyId, deleted: true });
    }

    const storyViewMatch = url.pathname.match(/^\/api\/stories\/([0-9a-f-]+)\/view$/i);
    if (storyViewMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const storyId = storyViewMatch[1];
      if (!uuid(storyId)) return error(res, 400, 'INVALID_STORY_ID');
      const visible = await rowsForUser(session, 'stories', {
        select: 'id,author_id', id: 'eq.' + storyId, deleted_at: 'is.null',
        expires_at: 'gt.' + new Date().toISOString(), limit: '1'
      });
      if (!visible.ok) return badDatabase(res, visible, 'STORY_ACCESS_CHECK_FAILED');
      if (!Array.isArray(visible.data) || !visible.data[0]) return error(res, 404, 'STORY_NOT_FOUND');
      if (visible.data[0].author_id === session.profile.id) return json(res, 200, { ok: true, idempotent: true, isMine: true });
      const body = await readBody(req);
      const completed = body.completed === undefined ? true : body.completed;
      if (typeof completed !== 'boolean') return error(res, 400, 'INVALID_STORY_VIEW_COMPLETION');
      const prior = await rowsForUser(session, 'story_views', {
        select: 'story_id,viewer_id,viewed_at,completed',
        story_id: 'eq.' + storyId, viewer_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!prior.ok || !Array.isArray(prior.data)) return badDatabase(res, prior, 'STORY_VIEW_LOOKUP_FAILED');
      if (prior.data[0]) return json(res, 200, { ok: true, idempotent: true, viewedAt: prior.data[0].viewed_at });
      const inserted = await rowsForUser(session, 'story_views', {
        select: 'story_id,viewer_id,viewed_at,completed'
      }, { method: 'POST', body: { story_id: storyId, viewer_id: session.profile.id, completed } });
      if (!inserted.ok) {
        const race = await rowsForUser(session, 'story_views', {
          select: 'story_id,viewer_id,viewed_at,completed',
          story_id: 'eq.' + storyId, viewer_id: 'eq.' + session.profile.id, limit: '1'
        });
        if (race.ok && Array.isArray(race.data) && race.data[0]) return json(res, 200, { ok: true, idempotent: true, viewedAt: race.data[0].viewed_at });
        return badDatabase(res, inserted, 'STORY_VIEW_RECORD_FAILED');
      }
      return json(res, 201, { ok: true, viewedAt: inserted.data[0].viewed_at, recorded: true });
    }

    const storyRepliesMatch = url.pathname.match(/^\/api\/stories\/([0-9a-f-]+)\/replies$/i);
    if (storyRepliesMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const storyId = storyRepliesMatch[1];
      if (!uuid(storyId)) return error(res, 400, 'INVALID_STORY_ID');
      const body = await readBody(req);
      if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.trim().length > 2000) return error(res, 400, 'INVALID_STORY_REPLY');
      const visible = await rowsForUser(session, 'stories', {
        select: 'id,author_id', id: 'eq.' + storyId, deleted_at: 'is.null',
        expires_at: 'gt.' + new Date().toISOString(), limit: '1'
      });
      if (!visible.ok) return badDatabase(res, visible, 'STORY_ACCESS_CHECK_FAILED');
      if (!Array.isArray(visible.data) || !visible.data[0]) return error(res, 404, 'STORY_NOT_FOUND');
      if (visible.data[0].author_id === session.profile.id) return error(res, 400, 'STORY_SELF_REPLY_FORBIDDEN');
      const inserted = await rowsForUser(session, 'story_replies', {
        select: 'id,story_id,author_id,message_id,body,created_at'
      }, { method: 'POST', body: { story_id: storyId, author_id: session.profile.id, body: body.body.trim() } });
      if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) return badDatabase(res, inserted, 'STORY_REPLY_FAILED');
      return json(res, 201, { ok: true, reply: {
        id: inserted.data[0].id, storyId, body: inserted.data[0].body, createdAt: inserted.data[0].created_at
      } });
    }


    if (req.method === 'GET' && url.pathname === '/api/feed/preferences') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const current = await rowsForUser(session, 'feed_preferences', {
        select: 'profile_id,preferred_topics,autoplay_video,reduced_motion,data_saver,updated_at',
        profile_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!current.ok || !Array.isArray(current.data)) return badDatabase(res, current, 'FEED_PREFERENCES_UNAVAILABLE');
      let prefs = current.data[0];
      if (!prefs) {
        const created = await rowsForUser(session, 'feed_preferences', {
          select: 'profile_id,preferred_topics,autoplay_video,reduced_motion,data_saver,updated_at'
        }, { method: 'POST', body: { profile_id: session.profile.id } });
        if (!created.ok || !Array.isArray(created.data) || !created.data[0]) return badDatabase(res, created, 'FEED_PREFERENCES_CREATE_FAILED');
        prefs = created.data[0];
      }
      return json(res, 200, { ok: true, preferences: {
        preferredTopics: Array.isArray(prefs.preferred_topics) ? prefs.preferred_topics : [],
        autoplayVideo: Boolean(prefs.autoplay_video),
        reducedMotion: Boolean(prefs.reduced_motion),
        dataSaver: Boolean(prefs.data_saver),
        updatedAt: prefs.updated_at
      } });
    }

    if (req.method === 'PATCH' && url.pathname === '/api/feed/preferences') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const patch = {};
      for (const [input, column] of [
        ['autoplayVideo', 'autoplay_video'],
        ['reducedMotion', 'reduced_motion'],
        ['dataSaver', 'data_saver']
      ]) {
        if (body[input] !== undefined) {
          if (typeof body[input] !== 'boolean') return error(res, 400, 'INVALID_FEED_PREFERENCE', input + ' must be boolean.');
          patch[column] = body[input];
        }
      }
      if (body.preferredTopics !== undefined) {
        if (!Array.isArray(body.preferredTopics) || body.preferredTopics.length > 20) return error(res, 400, 'INVALID_FEED_TOPICS');
        const topics = [];
        for (const item of body.preferredTopics) {
          if (typeof item !== 'string') return error(res, 400, 'INVALID_FEED_TOPICS');
          const normalized = item.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-');
          if (!/^[a-z0-9_-]{1,40}$/.test(normalized)) return error(res, 400, 'INVALID_FEED_TOPIC', 'Topics may use letters, numbers, spaces, underscores and hyphens.');
          if (!topics.includes(normalized)) topics.push(normalized);
        }
        patch.preferred_topics = topics;
      }
      if (!Object.keys(patch).length) return error(res, 400, 'EMPTY_FEED_PREFERENCE_UPDATE');
      patch.updated_at = new Date().toISOString();
      const saved = await rowsForUser(session, 'feed_preferences', {
        select: 'profile_id,preferred_topics,autoplay_video,reduced_motion,data_saver,updated_at',
        profile_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!saved.ok || !Array.isArray(saved.data)) return badDatabase(res, saved, 'FEED_PREFERENCES_LOOKUP_FAILED');
      let result;
      if (saved.data[0]) {
        result = await rowsForUser(session, 'feed_preferences', {
          profile_id: 'eq.' + session.profile.id,
          select: 'profile_id,preferred_topics,autoplay_video,reduced_motion,data_saver,updated_at'
        }, { method: 'PATCH', body: patch });
      } else {
        const initial = {
          profile_id: session.profile.id, preferred_topics: [],
          autoplay_video: false, reduced_motion: false, data_saver: false, ...patch
        };
        result = await rowsForUser(session, 'feed_preferences', {
          select: 'profile_id,preferred_topics,autoplay_video,reduced_motion,data_saver,updated_at'
        }, { method: 'POST', body: initial });
      }
      if (!result.ok || !Array.isArray(result.data) || !result.data[0]) return badDatabase(res, result, 'FEED_PREFERENCES_SAVE_FAILED');
      const prefs = result.data[0];
      return json(res, 200, { ok: true, preferences: {
        preferredTopics: Array.isArray(prefs.preferred_topics) ? prefs.preferred_topics : [],
        autoplayVideo: Boolean(prefs.autoplay_video), reducedMotion: Boolean(prefs.reduced_motion),
        dataSaver: Boolean(prefs.data_saver), updatedAt: prefs.updated_at
      } });
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

    if (req.method === 'GET' && url.pathname === '/api/media/mine') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const selected = await rowsForUser(session, 'media_assets', {
        select: 'id,post_id,storage_path,media_type,mime_type,byte_size,state,width,height,duration_ms,metadata,created_at,updated_at',
        uploader_id: 'eq.' + session.profile.id, order: 'created_at.desc', limit: '100'
      });
      if (!selected.ok || !Array.isArray(selected.data)) return badDatabase(res, selected, 'MEDIA_LIBRARY_UNAVAILABLE');
      const ready = selected.data.filter(asset => asset.state === 'ready' && typeof asset.storage_path === 'string');
      const signed = ready.length ? await storage.createSignedDownloadUrls(
        config, config.storageBucket, ready.map(asset => asset.storage_path),
        config.mediaSignedUrlTtlSeconds
      ) : {ok:true,signedUrls:[]};
      const signedByPath = new Map((signed.signedUrls || []).map(item => [item.path,item.signedUrl]));
      return json(res,200,{ok:true,assets:selected.data.map(asset=>{
        const objectPath=typeof asset.storage_path==='string'?asset.storage_path:null;
        const meta=asset.metadata && typeof asset.metadata==='object'?asset.metadata:{};
        return {
          id:asset.id,postId:asset.post_id,mediaType:asset.media_type,mimeType:asset.mime_type,
          byteSize:Number(asset.byte_size),state:asset.state,width:asset.width||null,height:asset.height||null,
          durationMs:asset.duration_ms||null,metadata:{
            pipelineVersion:meta.pipelineVersion||null,processedAt:meta.processedAt||null,
            lastProcessingError:meta.lastProcessingError||null,quarantineReason:meta.quarantineReason||null
          },createdAt:asset.created_at,updatedAt:asset.updated_at,
          url:asset.state==='ready'&&objectPath?signedByPath.get(objectPath)||null:null
        };
      })});
    }

    if (req.method === 'GET' && url.pathname === '/api/posts/mine') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const selected = await rowsForUser(session,'posts',{
        select:'id,author_id,kind,caption,media,audience,created_at,expires_at,deleted_at',
        author_id:'eq.'+session.profile.id,deleted_at:'is.null',order:'created_at.desc',limit:'100'
      });
      if (!selected.ok || !Array.isArray(selected.data)) return badDatabase(res,selected,'CREATOR_POSTS_UNAVAILABLE');
      const posts=selected.data;
      const mediaIds=[...new Set(posts.flatMap(post=>Array.isArray(post.media)?post.media.map(item=>item&&item.assetId).filter(uuid):[]))];
      const assets=mediaIds.length?await selectAdminRows(config,'media_assets',query({
        select:'id,storage_path,media_type,mime_type,state,width,height,duration_ms',
        id:profileIdIn(mediaIds),uploader_id:'eq.'+session.profile.id,limit:String(Math.min(mediaIds.length,300))
      })):{ok:true,rows:[]};
      if(!assets.ok)return error(res,503,'CREATOR_POST_MEDIA_UNAVAILABLE');
      const byId=new Map(assets.rows.map(asset=>[asset.id,asset]));
      const ready=assets.rows.filter(asset=>asset.state==='ready'&&asset.storage_path);
      const signed=ready.length?await storage.createSignedDownloadUrls(config,config.storageBucket,ready.map(asset=>asset.storage_path),config.mediaSignedUrlTtlSeconds):{ok:true,signedUrls:[]};
      const byPath=new Map((signed.signedUrls||[]).map(item=>[item.path,item.signedUrl]));
      return json(res,200,{ok:true,posts:posts.map(post=>({
        id:post.id,kind:post.kind,caption:post.caption||'',audience:post.audience,createdAt:post.created_at,
        media:Array.isArray(post.media)?post.media.map(item=>{
          const asset=item&&byId.get(item.assetId);
          return asset?{assetId:asset.id,mediaType:asset.media_type,mimeType:asset.mime_type,state:asset.state,
            url:asset.state==='ready'?byPath.get(asset.storage_path)||null:null}:null;
        }).filter(Boolean):[]
      }))});
    }

    const publicTierMatch = url.pathname.match(/^\/api\/creators\/([0-9a-f-]+)\/subscription-tiers$/i);
    if (req.method === 'GET' && publicTierMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const creatorId = publicTierMatch[1];
      if (!uuid(creatorId)) return error(res, 400, 'INVALID_CREATOR_ID');
      const tiers = await rowsForUser(session, 'creator_subscription_tiers', {
        select: 'id,creator_id,tier_key,title,monthly_price_minor,currency,benefits,enabled',
        creator_id: 'eq.' + creatorId, enabled: 'eq.true', order: 'monthly_price_minor.asc', limit: '20'
      });
      if (!tiers.ok || !Array.isArray(tiers.data)) return badDatabase(res, tiers, 'CREATOR_TIERS_UNAVAILABLE');
      const mine = creatorId === session.profile.id;
      return json(res, 200, { ok: true, tiers: tiers.data.map(tier => ({
        id: tier.id, creatorId: tier.creator_id, key: tier.tier_key, title: tier.title,
        monthlyPriceMinor: Number(tier.monthly_price_minor), currency: tier.currency,
        benefits: Array.isArray(tier.benefits) ? tier.benefits.map(item => typeof item === 'string' ? { key: item, label: item } : item) : [],
        canManage: mine
      })) });
    }

    if (req.method === 'GET' && url.pathname === '/api/creator/subscription-tiers') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const tiers = await selectAdminRows(config, 'creator_subscription_tiers', query({
        select: 'id,creator_id,tier_key,title,monthly_price_minor,currency,benefits,enabled,provider_product_id,provider_plan_id,creation_idempotency_key,created_at,updated_at',
        creator_id: 'eq.' + session.profile.id, order: 'created_at.desc', limit: '50'
      }));
      if (!tiers.ok) return badDatabase(res, tiers, 'CREATOR_TIERS_UNAVAILABLE');
      return json(res, 200, { ok: true, tiers: tiers.rows.map(tier => ({
        id: tier.id, key: tier.tier_key, title: tier.title, monthlyPriceMinor: Number(tier.monthly_price_minor),
        currency: tier.currency, benefits: Array.isArray(tier.benefits) ? tier.benefits : [],
        enabled: Boolean(tier.enabled), providerReady: Boolean(tier.provider_plan_id), createdAt: tier.created_at
      })) });
    }

    if (req.method === 'POST' && url.pathname === '/api/creator/subscription-tiers') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      if (!config.configured.paypal) return error(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'PayPal Developer credentials are required to create recurring subscription plans.');
      if (config.paypal.env === 'live' && (!config.features.productionPayments || !config.paypal.webhookId)) {
        return error(res, 503, 'PRODUCTION_SUBSCRIPTIONS_DISABLED', 'Live recurring subscriptions require production payment and signed webhook safeguards.');
      }
      const body = await readBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const titleKey = typeof body.tierKey === 'string' ? body.tierKey.trim().toLowerCase() : title.toLowerCase();
      const tierKey = titleKey.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const monthlyPriceMinor = Number(body.monthlyPriceMinor);
      if (title.length < 2 || title.length > 80) return error(res, 400, 'CREATOR_TIER_TITLE_INVALID');
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(tierKey)) return error(res, 400, 'CREATOR_TIER_KEY_INVALID');
      if (!Number.isSafeInteger(monthlyPriceMinor) || monthlyPriceMinor < 100 || monthlyPriceMinor > 99999) return error(res, 400, 'CREATOR_TIER_PRICE_INVALID', 'Monthly subscription price must be USD 1.00–999.99.');
      const rawKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey)) return error(res, 400, 'CREATOR_TIER_IDEMPOTENCY_INVALID');
      const rawBenefits = Array.isArray(body.benefits) ? body.benefits : [];
      if (rawBenefits.length > 10 || rawBenefits.some(item => typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 160)) {
        return error(res, 400, 'CREATOR_TIER_BENEFITS_INVALID', 'Provide up to 10 benefit descriptions, each 1–160 characters.');
      }
      const benefits = rawBenefits.map((label, index) => ({
        key: 'benefit-' + String(index + 1).padStart(2, '0') + '-' + label.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
        label: label.trim()
      }));
      const existing = await selectAdminRows(config, 'creator_subscription_tiers', query({
        select: 'id,creator_id,tier_key,title,monthly_price_minor,currency,benefits,enabled,provider_product_id,provider_plan_id,creation_idempotency_key',
        creator_id: 'eq.' + session.profile.id, creation_idempotency_key: 'eq.' + rawKey, limit: '1'
      }));
      if (!existing.ok) return badDatabase(res, existing, 'CREATOR_TIER_LOOKUP_FAILED');
      let tier = existing.rows[0] || null;
      if (tier && (tier.tier_key !== tierKey || Number(tier.monthly_price_minor) !== monthlyPriceMinor || tier.title !== title)) {
        return error(res, 409, 'CREATOR_SUBSCRIPTION_IDEMPOTENCY_CONFLICT');
      }
      if (tier && tier.enabled && tier.provider_plan_id) {
        return json(res, 200, { ok: true, idempotent: true, tier: {
          id: tier.id, key: tier.tier_key, title: tier.title, monthlyPriceMinor: Number(tier.monthly_price_minor), currency: tier.currency, enabled: true
        }});
      }
      if (!tier) {
        const inserted = await adminRest(config, 'creator_subscription_tiers', new URLSearchParams(), 'POST', {
          creator_id: session.profile.id, tier_key: tierKey, title,
          monthly_price_minor: monthlyPriceMinor, currency: 'USD',
          benefits, enabled: false, creation_idempotency_key: rawKey
        });
        if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) {
          const retry = await selectAdminRows(config, 'creator_subscription_tiers', query({
            select: 'id,creator_id,tier_key,title,monthly_price_minor,currency,benefits,enabled,provider_product_id,provider_plan_id,creation_idempotency_key',
            creator_id: 'eq.' + session.profile.id, creation_idempotency_key: 'eq.' + rawKey, limit: '1'
          }));
          if (!retry.ok || !retry.rows[0]) return badDatabase(res, inserted, 'CREATOR_TIER_CREATE_FAILED');
          tier = retry.rows[0];
        } else tier = inserted.data[0];
      }
      const plan = await paypal.createSubscriptionPlan(config.paypal, {
        creatorProfileId: session.profile.id, tierKey, title,
        description: benefits.map(item => item.label).join(' · ').slice(0, 200),
        amountUSD: monthlyPriceMinor / 100,
        requestId: String(tier.id).replace(/-/g, '')
      });
      if (!plan.ok || !plan.planId) {
        return error(res, plan.status === 400 ? 400 : 503, plan.code || 'PAYPAL_BILLING_PLAN_CREATE_FAILED',
          'The tier is saved as a disabled draft because PayPal did not confirm a recurring plan.');
      }
      const updated = await adminRest(config, 'creator_subscription_tiers', query({
        id: 'eq.' + tier.id, creator_id: 'eq.' + session.profile.id
      }), 'PATCH', {
        provider_product_id: plan.productId, provider_plan_id: plan.planId,
        enabled: true, updated_at: new Date().toISOString()
      });
      if (!updated.ok) return error(res, 503, 'CREATOR_TIER_PROVIDER_RECONCILIATION_REQUIRED', 'PayPal created a plan but the tier is not enabled until its provider record is reconciled. Retry with the same idempotency key.');
      const roleRows = await selectAdminRows(config, 'roles', query({ select: 'profile_id,role', profile_id: 'eq.' + session.profile.id, role: 'eq.creator', limit: '1' }));
      if (roleRows.ok && !roleRows.rows.length) await adminRest(config, 'roles', new URLSearchParams(), 'POST', { profile_id: session.profile.id, role: 'creator' });
      await adminRest(config, 'profiles', query({ id: 'eq.' + session.profile.id }), 'PATCH', { is_creator: true, updated_at: new Date().toISOString() });
      return json(res, 201, { ok: true, tier: {
        id: tier.id, key: tierKey, title, monthlyPriceMinor, currency: 'USD',
        benefits, enabled: true, providerReady: true
      }});
    }

    if (req.method === 'POST' && url.pathname === '/api/creator-subscriptions') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      if (!config.configured.paypal) return error(res, 503, 'PAYMENTS_NOT_CONFIGURED');
      if (config.paypal.env === 'live' && (!config.features.productionPayments || !config.paypal.webhookId)) {
        return error(res, 503, 'PRODUCTION_SUBSCRIPTIONS_DISABLED');
      }
      const body = await readBody(req);
      const tierId = String(body.tierId || '');
      if (!uuid(tierId)) return error(res, 400, 'INVALID_CREATOR_TIER_ID');
      const rawKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey)) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const prior = await selectAdminRows(config, 'creator_subscriptions', query({
        select: 'id,subscriber_id,creator_id,tier_id,tier,state,provider_subscription_id,provider_approval_url,billing_amount_minor,currency,current_period_end,idempotency_key',
        subscriber_id: 'eq.' + session.profile.id, idempotency_key: 'eq.' + rawKey, limit: '1'
      }));
      if (!prior.ok) return badDatabase(res, prior, 'CREATOR_SUBSCRIPTION_LOOKUP_FAILED');
      let subscription = prior.rows[0] || null;
      if (subscription && subscription.tier_id !== tierId) return error(res, 409, 'CREATOR_SUBSCRIPTION_IDEMPOTENCY_CONFLICT');
      if (subscription && subscription.state === 'active') return json(res, 200, {
        ok: true, idempotent: true, subscription: { id: subscription.id, state: 'active', currentPeriodEnd: subscription.current_period_end }
      });
      if (subscription && subscription.provider_subscription_id && subscription.provider_approval_url) {
        return json(res, 200, { ok: true, idempotent: true, subscription: {
          id: subscription.id, state: subscription.state, approvalUrl: subscription.provider_approval_url,
          providerSubscriptionId: subscription.provider_subscription_id, currentPeriodEnd: subscription.current_period_end
        }});
      }
      if (subscription && subscription.state !== 'pending') return error(res, 409, 'CREATOR_SUBSCRIPTION_NOT_OPEN');
      const tierRows = await selectAdminRows(config, 'creator_subscription_tiers', query({
        select: 'id,creator_id,tier_key,title,monthly_price_minor,currency,benefits,enabled,provider_plan_id',
        id: 'eq.' + tierId, enabled: 'eq.true', limit: '1'
      }));
      if (!tierRows.ok) return badDatabase(res, tierRows, 'CREATOR_TIER_LOOKUP_FAILED');
      const tier = tierRows.rows[0];
      if (!tier || !tier.provider_plan_id) return error(res, 404, 'CREATOR_SUBSCRIPTION_TIER_NOT_FOUND');
      if (tier.creator_id === session.profile.id) return error(res, 400, 'SELF_SUBSCRIPTION_FORBIDDEN');
      if (subscription) {
        // Reuse the same local subscription ID as PayPal-Request-Id after an ambiguous provider timeout.
        // PayPal idempotency lets a retry recover the same provider subscription without creating a second one.
      } else {
        const existingOpen = await selectAdminRows(config, 'creator_subscriptions', query({
          select: 'id,state,provider_subscription_id,provider_approval_url,current_period_end',
          subscriber_id: 'eq.' + session.profile.id, tier_id: 'eq.' + tier.id, state: 'in.(pending,active,grace)', limit: '1'
        }));
        if (!existingOpen.ok) return badDatabase(res, existingOpen, 'CREATOR_SUBSCRIPTION_LOOKUP_FAILED');
        if (existingOpen.rows[0]) {
          const other = existingOpen.rows[0];
          if (other.state === 'active') return json(res, 200, { ok: true, idempotent: true, subscription: { id: other.id, state: 'active', currentPeriodEnd: other.current_period_end }});
          if (other.provider_subscription_id && other.provider_approval_url) return json(res, 200, { ok: true, idempotent: true, subscription: { id: other.id, state: other.state, approvalUrl: other.provider_approval_url, providerSubscriptionId: other.provider_subscription_id }});
          return error(res, 409, 'CREATOR_SUBSCRIPTION_INITIALIZATION_IN_PROGRESS');
        }
        const inserted = await adminRest(config, 'creator_subscriptions', new URLSearchParams(), 'POST', {
          subscriber_id: session.profile.id, creator_id: tier.creator_id, tier: tier.tier_key, tier_id: tier.id,
          state: 'pending', billing_amount_minor: Number(tier.monthly_price_minor), currency: tier.currency,
          idempotency_key: rawKey, updated_at: new Date().toISOString()
        });
        if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) {
          const retry = await selectAdminRows(config, 'creator_subscriptions', query({
            select: 'id,subscriber_id,creator_id,tier_id,tier,state,provider_subscription_id,provider_approval_url,billing_amount_minor,currency,current_period_end,idempotency_key',
            subscriber_id: 'eq.' + session.profile.id, idempotency_key: 'eq.' + rawKey, limit: '1'
          }));
          if (!retry.ok || !retry.rows[0]) return badDatabase(res, inserted, 'CREATOR_SUBSCRIPTION_CREATE_FAILED');
          subscription = retry.rows[0];
        } else subscription = inserted.data[0];
      }
      const returnUrl = new URL('/', config.appBaseUrl);
      returnUrl.searchParams.set('subscription', 'return');
      returnUrl.searchParams.set('subscriptionId', subscription.id);
      const cancelUrl = new URL('/', config.appBaseUrl);
      cancelUrl.searchParams.set('subscription', 'cancel');
      cancelUrl.searchParams.set('subscriptionId', subscription.id);
      const providerSub = await paypal.createBillingSubscription(config.paypal, {
        planId: tier.provider_plan_id, customId: subscription.id, returnUrl: returnUrl.toString(),
        cancelUrl: cancelUrl.toString(), requestId: String(subscription.id).replace(/-/g, '')
      });
      if (!providerSub.ok || !providerSub.subscriptionId || !providerSub.approvalUrl) {
        return error(res, 503, providerSub.code || 'PAYPAL_SUBSCRIPTION_CREATE_FAILED', 'The subscription remains pending for reconciliation; no paid entitlement was enabled.');
      }
      const saved = await adminRest(config, 'creator_subscriptions', query({
        id: 'eq.' + subscription.id, subscriber_id: 'eq.' + session.profile.id
      }), 'PATCH', {
        provider_subscription_id: providerSub.subscriptionId, provider_approval_url: providerSub.approvalUrl,
        updated_at: new Date().toISOString()
      });
      if (!saved.ok) return error(res, 503, 'CREATOR_SUBSCRIPTION_PROVIDER_RECONCILIATION_REQUIRED', 'PayPal created the subscription but the local provider reference must be reconciled. Retry the same idempotency key.');
      return json(res, 201, { ok: true, subscription: {
        id: subscription.id, state: 'pending', creatorId: tier.creator_id, tierId: tier.id,
        monthlyPriceMinor: Number(tier.monthly_price_minor), currency: tier.currency,
        providerSubscriptionId: providerSub.subscriptionId, approvalUrl: providerSub.approvalUrl
      }});
    }

    if (req.method === 'GET' && url.pathname === '/api/creator-subscriptions/mine') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'creator_subscriptions', {
        select: 'id,subscriber_id,creator_id,tier_id,tier,state,billing_amount_minor,currency,current_period_end,provider_subscription_id,created_at,updated_at',
        subscriber_id: 'eq.' + session.profile.id, order: 'created_at.desc', limit: '100'
      });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'CREATOR_SUBSCRIPTIONS_UNAVAILABLE');
      return json(res, 200, { ok: true, subscriptions: result.data.map(item => ({
        id: item.id, creatorId: item.creator_id, tierId: item.tier_id, tier: item.tier, state: item.state,
        monthlyPriceMinor: item.billing_amount_minor === null ? null : Number(item.billing_amount_minor),
        currency: item.currency, currentPeriodEnd: item.current_period_end,
        providerSubscriptionId: item.provider_subscription_id || null, createdAt: item.created_at, updatedAt: item.updated_at
      })) });
    }

    const subscriptionRefreshMatch = url.pathname.match(/^\/api\/creator-subscriptions\/([0-9a-f-]+)\/refresh$/i);
    if (req.method === 'GET' && subscriptionRefreshMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const id = subscriptionRefreshMatch[1];
      if (!uuid(id)) return error(res, 400, 'INVALID_CREATOR_SUBSCRIPTION_ID');
      const rowResult = await selectAdminRows(config, 'creator_subscriptions', query({
        select: 'id,subscriber_id,creator_id,state,provider_subscription_id,current_period_end',
        id: 'eq.' + id, limit: '1'
      }));
      if (!rowResult.ok) return badDatabase(res, rowResult, 'CREATOR_SUBSCRIPTION_LOOKUP_FAILED');
      const row = rowResult.rows[0];
      if (!row || row.subscriber_id !== session.profile.id) return error(res, 404, 'CREATOR_SUBSCRIPTION_NOT_FOUND');
      if (!row.provider_subscription_id) return json(res, 202, { ok: true, subscription: { id: row.id, state: row.state, currentPeriodEnd: row.current_period_end } });
      const provider = await paypal.getBillingSubscription(config.paypal, row.provider_subscription_id);
      if (!provider.ok) return error(res, provider.status || 503, provider.code || 'PAYPAL_SUBSCRIPTION_LOOKUP_FAILED');
      const next = provider.nextBillingTime && Number.isFinite(new Date(provider.nextBillingTime).getTime()) ? new Date(provider.nextBillingTime).toISOString() : null;
      const sync = await adminRpc(config, 'sync_creator_subscription', {
        p_provider_subscription_id: provider.subscriptionId,
        p_provider_status: provider.status,
        p_next_billing_time: next,
        p_provider_event_id: 'return-sync:' + row.id + ':' + provider.status + ':' + (next || 'unknown')
      });
      if (!sync.ok) return badDatabase(res, sync, 'CREATOR_SUBSCRIPTION_RECONCILIATION_FAILED');
      return json(res, 200, { ok: true, subscription: {
        id: row.id, state: typeof sync.data === 'string' ? sync.data.replace(/^"|"$/g, '') : provider.status,
        currentPeriodEnd: next, providerStatus: provider.status
      }});
    }

    const subscriptionCancelMatch = url.pathname.match(/^\/api\/creator-subscriptions\/([0-9a-f-]+)\/cancel$/i);
    if (req.method === 'POST' && subscriptionCancelMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const id = subscriptionCancelMatch[1];
      if (!uuid(id)) return error(res, 400, 'INVALID_CREATOR_SUBSCRIPTION_ID');
      const rowResult = await selectAdminRows(config, 'creator_subscriptions', query({
        select: 'id,subscriber_id,state,provider_subscription_id,current_period_end',
        id: 'eq.' + id, limit: '1'
      }));
      if (!rowResult.ok) return badDatabase(res, rowResult, 'CREATOR_SUBSCRIPTION_LOOKUP_FAILED');
      const row = rowResult.rows[0];
      if (!row || row.subscriber_id !== session.profile.id) return error(res, 404, 'CREATOR_SUBSCRIPTION_NOT_FOUND');
      if (row.state === 'cancelled' || row.state === 'expired') return json(res, 200, { ok: true, idempotent: true, subscription: { id, state: row.state } });
      if (row.provider_subscription_id) {
        const cancelled = await paypal.cancelBillingSubscription(config.paypal, row.provider_subscription_id);
        if (!cancelled.ok) return error(res, cancelled.status || 503, cancelled.code || 'PAYPAL_SUBSCRIPTION_CANCEL_FAILED', 'The provider did not confirm cancellation; the local status was not changed.');
      }
      const newState = row.provider_subscription_id ? await adminRpc(config, 'sync_creator_subscription', {
        p_provider_subscription_id: row.provider_subscription_id,
        p_provider_status: 'CANCELLED',
        p_next_billing_time: row.current_period_end,
        p_provider_event_id: 'user-cancel:' + row.id
      }) : await adminRest(config, 'creator_subscriptions', query({ id: 'eq.' + row.id, subscriber_id: 'eq.' + session.profile.id }), 'PATCH', { state: 'cancelled', updated_at: new Date().toISOString() });
      if (!newState.ok) return error(res, 503, 'CREATOR_SUBSCRIPTION_CANCELLATION_RECONCILIATION_REQUIRED');
      return json(res, 200, { ok: true, subscription: { id, state: 'cancelled', currentPeriodEnd: row.current_period_end } });
    }

    if (req.method === 'GET' && url.pathname === '/api/creator/subscriptions') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const rows = await selectAdminRows(config, 'creator_subscriptions', query({
        select: 'id,subscriber_id,creator_id,tier_id,tier,state,billing_amount_minor,currency,current_period_end,created_at,updated_at',
        creator_id: 'eq.' + session.profile.id, order: 'created_at.desc', limit: '200'
      }));
      if (!rows.ok) return badDatabase(res, rows, 'CREATOR_SUBSCRIBERS_UNAVAILABLE');
      const subscriberIds = [...new Set(rows.rows.map(item => item.subscriber_id).filter(uuid))];
      const profiles = subscriberIds.length ? await selectAdminRows(config, 'profiles', query({
        select: 'id,username,display_name,avatar_url', id: profileIdIn(subscriberIds)
      })) : { ok: true, rows: [] };
      if (!profiles.ok) return badDatabase(res, profiles, 'CREATOR_SUBSCRIBER_PROFILES_UNAVAILABLE');
      const profileMap = new Map(profiles.rows.map(item => [item.id, item]));
      return json(res, 200, { ok: true, subscriptions: rows.rows.map(item => ({
        id: item.id, subscriber: profileProjection(profileMap.get(item.subscriber_id)),
        tierId: item.tier_id, tier: item.tier, state: item.state,
        monthlyPriceMinor: item.billing_amount_minor == null ? null : Number(item.billing_amount_minor),
        currency: item.currency, currentPeriodEnd: item.current_period_end,
        createdAt: item.created_at, updatedAt: item.updated_at
      })) });
    }

    if (req.method === 'GET' && url.pathname === '/api/creator/analytics') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const analytics=await adminRpc(config,'get_creator_analytics',{p_profile_id:session.profile.id});
      if (!analytics.ok) return badDatabase(res,analytics,'CREATOR_ANALYTICS_UNAVAILABLE');
      const row=Array.isArray(analytics.data)?analytics.data[0]:analytics.data;
      if(!row)return error(res,503,'CREATOR_ANALYTICS_UNAVAILABLE');
      return json(res,200,{ok:true,analytics:{
        totalPosts:Number(row.total_posts||0),views:Number(row.total_views||0),
        completedViews:Number(row.completed_views||0),watchTimeMs:Number(row.watch_time_ms||0),
        followers:Number(row.follower_count||0),comments:Number(row.comment_count||0),reactions:Number(row.reaction_count||0)
      }});
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


    const postInteractionMatch = url.pathname.match(/^\/api\/posts\/([0-9a-f-]+)\/(reactions|bookmark|repost|share|view)$/i);
    if (postInteractionMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const postId = postInteractionMatch[1];
      const action = postInteractionMatch[2].toLowerCase();
      if (!uuid(postId)) return error(res, 400, 'INVALID_POST_ID');

      const visible = await rowsForUser(session, 'posts', {
        select: 'id,author_id,kind,audience',
        id: 'eq.' + postId, deleted_at: 'is.null', limit: '1'
      });
      if (!visible.ok) return badDatabase(res, visible, 'POST_ACCESS_CHECK_FAILED');
      if (!Array.isArray(visible.data) || !visible.data[0]) return error(res, 404, 'POST_NOT_FOUND');

      if (action === 'reactions' && req.method === 'POST') {
        const body = await readBody(req);
        const kind = typeof body.kind === 'string' ? body.kind : 'like';
        if (!['like','love','laugh','wow','sad','angry','support'].includes(kind)) return error(res, 400, 'INVALID_REACTION_KIND');
        const existing = await rowsForUser(session, 'reactions', {
          select: 'id,post_id,profile_id,kind,created_at',
          post_id: 'eq.' + postId, profile_id: 'eq.' + session.profile.id, kind: 'eq.' + kind, limit: '1'
        });
        if (!existing.ok || !Array.isArray(existing.data)) return badDatabase(res, existing, 'REACTION_LOOKUP_FAILED');
        if (existing.data[0]) return json(res, 200, { ok: true, idempotent: true, reaction: existing.data[0] });
        const inserted = await rowsForUser(session, 'reactions', {
          select: 'id,post_id,profile_id,kind,created_at'
        }, { method: 'POST', body: { post_id: postId, profile_id: session.profile.id, kind } });
        if (!inserted.ok) {
          const race = await rowsForUser(session, 'reactions', {
            select: 'id,post_id,profile_id,kind,created_at',
            post_id: 'eq.' + postId, profile_id: 'eq.' + session.profile.id, kind: 'eq.' + kind, limit: '1'
          });
          if (race.ok && Array.isArray(race.data) && race.data[0]) return json(res, 200, { ok: true, idempotent: true, reaction: race.data[0] });
          return badDatabase(res, inserted, 'REACTION_FAILED');
        }
        return json(res, 201, { ok: true, reaction: Array.isArray(inserted.data) ? inserted.data[0] : null });
      }

      if (action === 'reactions' && req.method === 'DELETE') {
        const kind = url.searchParams.get('kind') || 'like';
        if (!['like','love','laugh','wow','sad','angry','support'].includes(kind)) return error(res, 400, 'INVALID_REACTION_KIND');
        const removed = await rowsForUser(session, 'reactions', {
          post_id: 'eq.' + postId, profile_id: 'eq.' + session.profile.id, kind: 'eq.' + kind
        }, { method: 'DELETE' });
        if (!removed.ok) return badDatabase(res, removed, 'REACTION_REMOVE_FAILED');
        return json(res, 200, { ok: true, removed: true, kind });
      }

      if (action === 'bookmark' && req.method === 'POST') {
        const prior = await rowsForUser(session, 'post_bookmarks', {
          select: 'profile_id,post_id,created_at', profile_id: 'eq.' + session.profile.id, post_id: 'eq.' + postId, limit: '1'
        });
        if (!prior.ok || !Array.isArray(prior.data)) return badDatabase(res, prior, 'BOOKMARK_LOOKUP_FAILED');
        if (prior.data[0]) return json(res, 200, { ok: true, idempotent: true, bookmark: prior.data[0] });
        const saved = await rowsForUser(session, 'post_bookmarks', { select: 'profile_id,post_id,created_at' }, {
          method: 'POST', body: { profile_id: session.profile.id, post_id: postId }
        });
        if (!saved.ok) {
          const race = await rowsForUser(session, 'post_bookmarks', {
            select: 'profile_id,post_id,created_at', profile_id: 'eq.' + session.profile.id, post_id: 'eq.' + postId, limit: '1'
          });
          if (race.ok && Array.isArray(race.data) && race.data[0]) return json(res, 200, { ok: true, idempotent: true, bookmark: race.data[0] });
          return badDatabase(res, saved, 'BOOKMARK_FAILED');
        }
        return json(res, 201, { ok: true, bookmark: Array.isArray(saved.data) ? saved.data[0] : null });
      }
      if (action === 'bookmark' && req.method === 'DELETE') {
        const removed = await rowsForUser(session, 'post_bookmarks', {
          profile_id: 'eq.' + session.profile.id, post_id: 'eq.' + postId
        }, { method: 'DELETE' });
        if (!removed.ok) return badDatabase(res, removed, 'BOOKMARK_REMOVE_FAILED');
        return json(res, 200, { ok: true, removed: true });
      }

      if (action === 'repost' && req.method === 'POST') {
        const body = await readBody(req);
        const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
        if (caption.length > 1000) return error(res, 400, 'REPOST_CAPTION_TOO_LONG');
        const prior = await rowsForUser(session, 'post_reposts', {
          select: 'id,profile_id,post_id,caption,created_at',
          profile_id: 'eq.' + session.profile.id, post_id: 'eq.' + postId, limit: '1'
        });
        if (!prior.ok || !Array.isArray(prior.data)) return badDatabase(res, prior, 'REPOST_LOOKUP_FAILED');
        if (prior.data[0]) return json(res, 200, { ok: true, idempotent: true, repost: prior.data[0] });
        const created = await rowsForUser(session, 'post_reposts', {
          select: 'id,profile_id,post_id,caption,created_at'
        }, { method: 'POST', body: { profile_id: session.profile.id, post_id: postId, caption: caption || null } });
        if (!created.ok) {
          const race = await rowsForUser(session, 'post_reposts', {
            select: 'id,profile_id,post_id,caption,created_at',
            profile_id: 'eq.' + session.profile.id, post_id: 'eq.' + postId, limit: '1'
          });
          if (race.ok && Array.isArray(race.data) && race.data[0]) return json(res, 200, { ok: true, idempotent: true, repost: race.data[0] });
          return badDatabase(res, created, 'REPOST_FAILED');
        }
        return json(res, 201, { ok: true, repost: Array.isArray(created.data) ? created.data[0] : null });
      }
      if (action === 'repost' && req.method === 'DELETE') {
        const removed = await rowsForUser(session, 'post_reposts', {
          profile_id: 'eq.' + session.profile.id, post_id: 'eq.' + postId
        }, { method: 'DELETE' });
        if (!removed.ok) return badDatabase(res, removed, 'REPOST_REMOVE_FAILED');
        return json(res, 200, { ok: true, removed: true });
      }

      if (action === 'share' && req.method === 'POST') {
        const body = await readBody(req);
        const destination = typeof body.destination === 'string' ? body.destination : 'copy_link';
        if (!['internal','copy_link','external','message'].includes(destination)) return error(res, 400, 'INVALID_SHARE_DESTINATION');
        const key = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
        if (key && !/^[A-Za-z0-9._:-]{16,180}$/.test(key)) return error(res, 400, 'INVALID_IDEMPOTENCY_KEY');
        const idempotencyKey = key ? session.profile.id + ':' + key : null;
        if (idempotencyKey) {
          const prior = await selectAdminRows(config, 'post_share_events', query({
            select: 'id,post_id,actor_id,destination,created_at',
            actor_id: 'eq.' + session.profile.id, idempotency_key: 'eq.' + idempotencyKey, limit: '1'
          }));
          if (!prior.ok) return error(res, 503, 'POST_SHARE_LOOKUP_FAILED');
          if (prior.rows[0]) {
            const target = new URL('/', config.appBaseUrl); target.searchParams.set('post', postId);
            return json(res, 200, { ok: true, idempotent: true, destination: prior.rows[0].destination, shareUrl: target.toString(), recorded: true });
          }
        }
        const inserted = await adminRest(config, 'post_share_events', new URLSearchParams(), 'POST', {
          post_id: postId, actor_id: session.profile.id, destination,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
        });
        if (!inserted.ok) return badDatabase(res, inserted, 'POST_SHARE_RECORD_FAILED');
        const target = new URL('/', config.appBaseUrl);
        target.searchParams.set('post', postId);
        return json(res, 201, { ok: true, destination, shareUrl: target.toString(), recorded: true });
      }

      if (action === 'view' && req.method === 'POST') {
        const body = await readBody(req);
        const watchMs = body.watchMs === undefined ? 0 : Number(body.watchMs);
        const completed = body.completed === undefined ? false : body.completed;
        if (!Number.isSafeInteger(watchMs) || watchMs < 0 || watchMs > 86400000) return error(res, 400, 'INVALID_WATCH_TIME');
        if (typeof completed !== 'boolean') return error(res, 400, 'INVALID_COMPLETION_FLAG');
        const key = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
        if (key && !/^[A-Za-z0-9._:-]{16,180}$/.test(key)) return error(res, 400, 'INVALID_IDEMPOTENCY_KEY');
        const idempotencyKey = key ? session.profile.id + ':' + key : null;
        if (idempotencyKey) {
          const prior = await selectAdminRows(config, 'post_view_events', query({
            select: 'id,post_id,viewer_id,watch_ms,completed,created_at',
            viewer_id: 'eq.' + session.profile.id, idempotency_key: 'eq.' + idempotencyKey, limit: '1'
          }));
          if (!prior.ok) return error(res, 503, 'POST_VIEW_LOOKUP_FAILED');
          if (prior.rows[0]) return json(res, 200, { ok: true, idempotent: true, view: {
            postId: prior.rows[0].post_id, watchMs: Number(prior.rows[0].watch_ms || 0),
            completed: Boolean(prior.rows[0].completed), recorded: true
          } });
        }
        const inserted = await adminRest(config, 'post_view_events', new URLSearchParams(), 'POST', {
          post_id: postId, viewer_id: session.profile.id, watch_ms: watchMs, completed,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
        });
        if (!inserted.ok) return badDatabase(res, inserted, 'POST_VIEW_RECORD_FAILED');
        return json(res, 201, { ok: true, view: { postId, watchMs, completed, recorded: true } });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/bookmarks') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const limit = asSafeInt(url.searchParams.get('limit'), 30, 1, 100);
      const offset = asSafeInt(url.searchParams.get('offset'), 0, 0, 10000);
      const saved = await rowsForUser(session, 'post_bookmarks', {
        select: 'profile_id,post_id,created_at', profile_id: 'eq.' + session.profile.id,
        order: 'created_at.desc', limit: String(limit), offset: String(offset)
      });
      if (!saved.ok || !Array.isArray(saved.data)) return badDatabase(res, saved, 'BOOKMARKS_UNAVAILABLE');
      const ids = [...new Set(saved.data.map(row => row.post_id).filter(uuid))];
      if (!ids.length) return json(res, 200, { ok: true, bookmarks: [], offset, limit, hasMore: saved.data.length === limit });
      const posts = await rowsForUser(session, 'posts', {
        select: 'id,author_id,kind,caption,audience,created_at,media', id: 'in.(' + ids.join(',') + ')', deleted_at: 'is.null'
      });
      if (!posts.ok || !Array.isArray(posts.data)) return badDatabase(res, posts, 'BOOKMARKED_POSTS_UNAVAILABLE');
      const postById = new Map(posts.data.map(post => [post.id, post]));
      return json(res, 200, { ok: true, bookmarks: saved.data.filter(row => postById.has(row.post_id)).map(row => ({
        createdAt: row.created_at, post: { id: postById.get(row.post_id).id, kind: postById.get(row.post_id).kind,
          caption: postById.get(row.post_id).caption || '', createdAt: postById.get(row.post_id).created_at }
      })), offset, limit, hasMore: saved.data.length === limit });
    }

    const commentListMatch = url.pathname.match(/^\/api\/posts\/([0-9a-f-]+)\/comments$/i);
    if (req.method === 'GET' && commentListMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const postId = commentListMatch[1];
      if (!uuid(postId)) return error(res, 400, 'INVALID_POST_ID');
      const post = await rowsForUser(session, 'posts', { select: 'id', id: 'eq.' + postId, deleted_at: 'is.null', limit: '1' });
      if (!post.ok) return badDatabase(res, post, 'POST_ACCESS_CHECK_FAILED');
      if (!Array.isArray(post.data) || !post.data[0]) return error(res, 404, 'POST_NOT_FOUND');
      const limit = asSafeInt(url.searchParams.get('limit'), 50, 1, 100);
      const offset = asSafeInt(url.searchParams.get('offset'), 0, 0, 10000);
      const comments = await rowsForUser(session, 'comments', {
        select: 'id,post_id,author_id,parent_id,body,created_at',
        post_id: 'eq.' + postId, deleted_at: 'is.null', order: 'created_at.asc',
        limit: String(limit), offset: String(offset)
      });
      if (!comments.ok || !Array.isArray(comments.data)) return badDatabase(res, comments, 'COMMENTS_UNAVAILABLE');
      const authorIds = [...new Set(comments.data.map(item => item.author_id).filter(uuid))];
      const authors = authorIds.length ? await selectAdminRows(config, 'profiles', query({
        select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(authorIds), limit: String(authorIds.length)
      })) : { ok: true, rows: [] };
      if (!authors.ok) return error(res, 503, 'COMMENT_AUTHORS_UNAVAILABLE');
      const byId = new Map(authors.rows.map(profile => [profile.id, profile]));
      return json(res, 200, { ok: true, comments: comments.data.map(item => ({
        id: item.id, postId: item.post_id, body: item.body, parentId: item.parent_id,
        createdAt: item.created_at, author: profileProjection(byId.get(item.author_id))
      })), offset, limit, hasMore: comments.data.length === limit });
    }

    if (req.method === 'POST' && url.pathname === '/api/comments') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      if (!uuid(body.postId)) return error(res, 400, 'INVALID_POST_ID');
      const postAccess = await rowsForUser(session, 'posts', { select: 'id', id: 'eq.' + body.postId, deleted_at: 'is.null', limit: '1' });
      if (!postAccess.ok) return badDatabase(res, postAccess, 'POST_ACCESS_CHECK_FAILED');
      if (!Array.isArray(postAccess.data) || !postAccess.data[0]) return error(res, 404, 'POST_NOT_FOUND');
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

    const relationshipRouteMatch = url.pathname.match(/^\/api\/relationships\/(blocks|mutes|restrictions)$/i);
    if (relationshipRouteMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const kind = relationshipRouteMatch[1].toLowerCase();
      const spec = kind === 'blocks'
        ? { table:'blocks', ownerColumn:'blocker_id', targetColumn:'blocked_id', select:'blocker_id,blocked_id,created_at' }
        : kind === 'mutes'
          ? { table:'muted_profiles', ownerColumn:'profile_id', targetColumn:'muted_profile_id', select:'profile_id,muted_profile_id,created_at' }
          : { table:'restricted_profiles', ownerColumn:'profile_id', targetColumn:'restricted_profile_id', select:'profile_id,restricted_profile_id,reason_code,created_at' };
      const relationships = await rowsForUser(session, spec.table, {
        select:spec.select, [spec.ownerColumn]:'eq.'+session.profile.id, order:'created_at.desc', limit:'500'
      });
      if (!relationships.ok || !Array.isArray(relationships.data)) return badDatabase(res, relationships, 'RELATIONSHIPS_UNAVAILABLE');
      const targetIds = [...new Set(relationships.data.map(row => row[spec.targetColumn]).filter(uuid))];
      const profiles = targetIds.length ? await selectAdminRows(config, 'profiles', query({
        select:'id,username,display_name,avatar_url,is_verified', id:profileIdIn(targetIds), limit:String(targetIds.length)
      })) : { ok:true, rows:[] };
      if (!profiles.ok) return error(res, 503, 'RELATIONSHIP_PROFILES_UNAVAILABLE');
      const byId = new Map(profiles.rows.map(profile => [profile.id, profile]));
      return json(res, 200, { ok:true, kind, relationships:relationships.data.map(row => {
        const targetId = row[spec.targetColumn];
        return { profileId:targetId, createdAt:row.created_at, reasonCode:row.reason_code || null,
          profile:byId.has(targetId) ? profileProjection(byId.get(targetId)) : null };
      }) });
    }

    if (relationshipRouteMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const kind = relationshipRouteMatch[1].toLowerCase();
      const body = await readBody(req);
      if (!uuid(body.profileId) || body.profileId === session.profile.id) return error(res, 400, 'INVALID_RELATIONSHIP_TARGET');
      const reasonCode = body.reasonCode == null || body.reasonCode === '' ? null : String(body.reasonCode);
      if (reasonCode && !/^[A-Za-z0-9_.:-]{2,80}$/.test(reasonCode)) return error(res, 400, 'INVALID_RELATIONSHIP_REASON');
      const rpcKind = kind === 'blocks' ? 'block' : kind === 'mutes' ? 'mute' : 'restrict';
      const result = await adminRpc(config, 'set_profile_relationship', {
        p_owner_profile_id:session.profile.id, p_target_profile_id:body.profileId,
        p_kind:rpcKind, p_action:'add', p_reason_code:reasonCode
      });
      if (!result.ok) return badDatabase(res, result, 'RELATIONSHIP_ADD_FAILED');
      return json(res, 200, { ok:true, kind:rpcKind, profileId:body.profileId, state:'added' });
    }

    if (relationshipRouteMatch && req.method === 'DELETE') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const kind = relationshipRouteMatch[1].toLowerCase();
      const targetId = url.searchParams.get('profileId');
      if (!uuid(targetId) || targetId === session.profile.id) return error(res, 400, 'INVALID_RELATIONSHIP_TARGET');
      const rpcKind = kind === 'blocks' ? 'block' : kind === 'mutes' ? 'mute' : 'restrict';
      const result = await adminRpc(config, 'set_profile_relationship', {
        p_owner_profile_id:session.profile.id, p_target_profile_id:targetId,
        p_kind:rpcKind, p_action:'remove', p_reason_code:null
      });
      if (!result.ok) return badDatabase(res, result, 'RELATIONSHIP_REMOVE_FAILED');
      return json(res, 200, { ok:true, kind:rpcKind, profileId:targetId, state:'removed' });
    }

    if (req.method === 'GET' && url.pathname === '/api/communities') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'communities', { select: 'id,owner_id,name,access,created_at', order: 'created_at.desc', limit: '50' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'COMMUNITIES_UNAVAILABLE');
      return json(res, 200, { ok: true, communities: result.data });
    }

    if (req.method === 'GET' && url.pathname === '/api/marketplace/listings') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const rawSearch = String(url.searchParams.get('q') || '').normalize('NFKC').trim();
      const category = String(url.searchParams.get('category') || '').trim().slice(0,80);
      if (rawSearch && !/^[\p{L}\p{N}\p{Zs}._'-]{2,80}$/u.test(rawSearch)) return error(res, 400, 'INVALID_MARKETPLACE_SEARCH');
      const params = {
        select: 'id,seller_id,title,description,category,currency,price_minor,status,created_at',
        status: 'eq.active', order: 'created_at.desc', limit: String(asSafeInt(url.searchParams.get('limit'), 24, 1, 60))
      };
      if (category) params.category = 'eq.' + category;
      if (rawSearch) params.title = 'ilike.*' + rawSearch.replace(/[.*]/g, '') + '*';
      const listings = await rowsForUser(session, 'marketplace_listings', params);
      if (!listings.ok || !Array.isArray(listings.data)) return badDatabase(res, listings, 'MARKETPLACE_LISTINGS_UNAVAILABLE');
      const ids = listings.data.map(item => item.id).filter(uuid);
      const inventory = ids.length ? await rowsForUser(session, 'listing_inventory', {
        select: 'listing_id,quantity_available,quantity_reserved', listing_id: profileIdIn(ids)
      }) : { ok: true, data: [] };
      if (!inventory.ok || !Array.isArray(inventory.data)) return badDatabase(res, inventory, 'MARKETPLACE_INVENTORY_UNAVAILABLE');
      const inventoryById = new Map(inventory.data.map(item => [item.listing_id,item]));
      const sellerIds = [...new Set(listings.data.map(item => item.seller_id).filter(uuid))];
      const sellers = sellerIds.length ? await rowsForUser(session,'profiles',{select:'id,username,display_name,avatar_url,is_verified',id:profileIdIn(sellerIds)}) : {ok:true,data:[]};
      const sellerById = new Map((sellers.data||[]).map(item=>[item.id,item]));
      return json(res,200,{ok:true,listings:listings.data.map(item=>{
        const stock=inventoryById.get(item.id);
        return {
          id:item.id,title:item.title,description:item.description||'',category:item.category,
          currency:item.currency,priceMinor:Number(item.price_minor),status:item.status,
          availableQuantity:stock?Math.max(0,Number(stock.quantity_available)-Number(stock.quantity_reserved)):0,
          seller:profileProjection(sellerById.get(item.seller_id)),createdAt:item.created_at
        };
      })});
    }

    if (req.method === 'GET' && url.pathname === '/api/marketplace/listings/mine') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const listings = await rowsForUser(session,'marketplace_listings',{
        select:'id,seller_id,title,description,category,currency,price_minor,status,created_at',
        seller_id:'eq.'+session.profile.id,order:'created_at.desc',limit:'100'
      });
      if(!listings.ok||!Array.isArray(listings.data))return badDatabase(res,listings,'MY_LISTINGS_UNAVAILABLE');
      const ids=listings.data.map(item=>item.id).filter(uuid);
      const stock=ids.length?await rowsForUser(session,'listing_inventory',{select:'listing_id,quantity_available,quantity_reserved',listing_id:profileIdIn(ids)}):{ok:true,data:[]};
      const stockById=new Map((stock.data||[]).map(item=>[item.listing_id,item]));
      return json(res,200,{ok:true,listings:listings.data.map(item=>{
        const inventory=stockById.get(item.id);
        return {id:item.id,title:item.title,description:item.description||'',category:item.category,priceMinor:Number(item.price_minor),currency:item.currency,status:item.status,quantityAvailable:inventory?Number(inventory.quantity_available):null,quantityReserved:inventory?Number(inventory.quantity_reserved):null,createdAt:item.created_at};
      })});
    }

    if (req.method === 'POST' && url.pathname === '/api/marketplace/listings') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const body=await readBody(req);
      const title=typeof body.title==='string'?body.title.trim():'';
      const description=typeof body.description==='string'?body.description.trim():'';
      const category=typeof body.category==='string'?body.category.trim():'';
      const priceMinor=Number(body.priceMinor);
      const quantity=Number(body.quantity);
      if(title.length<2||title.length>160)return error(res,400,'MARKETPLACE_LISTING_TITLE_INVALID');
      if(category.length<2||category.length>80)return error(res,400,'MARKETPLACE_LISTING_CATEGORY_INVALID');
      if(description.length>4000||!Number.isSafeInteger(priceMinor)||priceMinor<1||priceMinor>100000000000)return error(res,400,'MARKETPLACE_LISTING_PRICE_INVALID');
      if(!Number.isSafeInteger(quantity)||quantity<0||quantity>1000000)return error(res,400,'MARKETPLACE_LISTING_QUANTITY_INVALID');
      const rawKey=String(req.headers['idempotency-key']||body.idempotencyKey||'');
      if(!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey))return error(res,400,'IDEMPOTENCY_KEY_REQUIRED');
      if(!config.configured.supabase)return error(res,503,'DATABASE_NOT_CONFIGURED');
      const created=await adminRpc(config,'create_marketplace_listing',{
        p_listing_id:randomUUID(),p_seller_profile_id:session.profile.id,p_title:title,
        p_description:description||null,p_category:category,p_price_minor:priceMinor,p_quantity:quantity,p_idempotency_key:rawKey
      });
      if(!created.ok)return badDatabase(res,created,'MARKETPLACE_LISTING_CREATE_FAILED');
      const listingId=typeof created.data==='string'?created.data.replace(/^"|"$/g,''):Array.isArray(created.data)?created.data[0]:created.data&&created.data.create_marketplace_listing;
      if(!uuid(String(listingId||'')))return error(res,503,'MARKETPLACE_LISTING_CREATE_RESULT_INVALID');
      const found=await rowsForUser(session,'marketplace_listings',{select:'id,title,description,category,currency,price_minor,status,created_at',id:'eq.'+listingId,limit:'1'});
      if(!found.ok||!found.data||!found.data[0])return error(res,503,'MARKETPLACE_LISTING_READBACK_FAILED');
      return json(res,201,{ok:true,listing:{id:found.data[0].id,title:found.data[0].title,description:found.data[0].description||'',category:found.data[0].category,priceMinor:Number(found.data[0].price_minor),currency:found.data[0].currency,status:found.data[0].status,createdAt:found.data[0].created_at}});
    }

    const listingStateMatch=url.pathname.match(/^\/api\/marketplace\/listings\/([0-9a-f-]+)\/status$/i);
    if(req.method==='PATCH'&&listingStateMatch){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const listingId=listingStateMatch[1];
      if(!uuid(listingId))return error(res,400,'INVALID_LISTING_ID');
      const body=await readBody(req);
      const state=['draft','active','paused','sold_out'].includes(body.status)?body.status:null;
      if(!state)return error(res,400,'MARKETPLACE_LISTING_STATE_INVALID');
      const result=await adminRpc(config,'set_marketplace_listing_state',{p_listing_id:listingId,p_seller_profile_id:session.profile.id,p_state:state});
      if(!result.ok)return badDatabase(res,result,'MARKETPLACE_LISTING_STATUS_UPDATE_FAILED');
      return json(res,200,{ok:true,listing:{id:listingId,status:typeof result.data==='string'?result.data.replace(/^"|"$/g,''):state}});
    }

    if (req.method === 'GET' && url.pathname === '/api/marketplace/orders') {
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const result=await rowsForUser(session,'commerce_orders',{select:'id,buyer_id,currency,subtotal_minor,tax_minor,shipping_minor,total_minor,status,idempotency_key,provider_order_id,provider_approval_url,provider_capture_id,created_at,updated_at',buyer_id:'eq.'+session.profile.id,order:'created_at.desc',limit:'100'});
      if(!result.ok||!Array.isArray(result.data))return badDatabase(res,result,'COMMERCE_ORDERS_UNAVAILABLE');
      const ids=result.data.map(item=>item.id).filter(uuid);
      const lineItems=ids.length?await rowsForUser(session,'commerce_order_items',{select:'id,order_id,listing_id,seller_id,quantity,unit_price_minor,line_total_minor',order_id:profileIdIn(ids),order:'created_at.desc',limit:'500'}):{ok:true,data:[]};
      if(!lineItems.ok||!Array.isArray(lineItems.data))return badDatabase(res,lineItems,'COMMERCE_ORDER_ITEMS_UNAVAILABLE');
      const itemMap=new Map();
      lineItems.data.forEach(item=>{if(!itemMap.has(item.order_id))itemMap.set(item.order_id,[]);itemMap.get(item.order_id).push({id:item.id,listingId:item.listing_id,sellerId:item.seller_id,quantity:Number(item.quantity),unitPriceMinor:Number(item.unit_price_minor),lineTotalMinor:Number(item.line_total_minor)});});
      return json(res,200,{ok:true,orders:result.data.map(item=>({id:item.id,status:item.status,currency:item.currency,subtotalMinor:Number(item.subtotal_minor),taxMinor:Number(item.tax_minor),shippingMinor:Number(item.shipping_minor),totalMinor:Number(item.total_minor),providerCaptureId:item.provider_capture_id||null,createdAt:item.created_at,items:itemMap.get(item.id)||[]}))});
    }

    if(req.method==='POST'&&url.pathname==='/api/marketplace/orders'){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      if(!config.configured.paypal)return error(res,503,'PAYMENTS_NOT_CONFIGURED','PayPal Developer credentials are required for marketplace checkout.');
      if(config.paypal.env==='live'&&(!config.features.productionPayments||!config.paypal.webhookId))return error(res,503,'PRODUCTION_CHECKOUT_DISABLED');
      const body=await readBody(req);
      const items=Array.isArray(body.items)?body.items:[];
      if(items.length<1||items.length>20||items.some(item=>!item||!uuid(item.listingId)||!Number.isSafeInteger(Number(item.quantity))||Number(item.quantity)<1||Number(item.quantity)>100))return error(res,400,'MARKETPLACE_ORDER_ITEMS_INVALID');
      const normalized=items.map(item=>({listingId:item.listingId,quantity:Number(item.quantity)})).sort((a,b)=>a.listingId.localeCompare(b.listingId));
      if(new Set(normalized.map(item=>item.listingId)).size!==normalized.length)return error(res,400,'MARKETPLACE_ORDER_ITEM_DUPLICATE');
      const rawKey=String(req.headers['idempotency-key']||body.idempotencyKey||'');
      if(!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey))return error(res,400,'IDEMPOTENCY_KEY_REQUIRED');
      const created=await adminRpc(config,'create_commerce_order',{p_buyer_profile_id:session.profile.id,p_items:normalized,p_idempotency_key:rawKey});
      if(!created.ok)return badDatabase(res,created,'COMMERCE_ORDER_CREATE_FAILED');
      const orderId=typeof created.data==='string'?created.data.replace(/^"|"$/g,''):Array.isArray(created.data)?created.data[0]:created.data&&created.data.create_commerce_order;
      if(!uuid(String(orderId||'')))return error(res,503,'COMMERCE_ORDER_RESULT_INVALID');
      const findOrder=()=>selectAdminRows(config,'commerce_orders',query({select:'id,buyer_id,total_minor,currency,status,provider_order_id,provider_approval_url,provider_capture_id,request_hash',id:'eq.'+orderId,buyer_id:'eq.'+session.profile.id,limit:'1'}));
      const orderResult=await findOrder();
      if(!orderResult.ok||!orderResult.rows[0])return error(res,503,'COMMERCE_ORDER_READBACK_FAILED');
      let order=orderResult.rows[0];
      if(order.status==='paid')return json(res,200,{ok:true,idempotent:true,order:{id:order.id,status:order.status,totalMinor:Number(order.total_minor),captureId:order.provider_capture_id}});
      if(order.provider_order_id&&order.provider_approval_url)return json(res,200,{ok:true,idempotent:true,order:{id:order.id,status:order.status,totalMinor:Number(order.total_minor),approvalUrl:order.provider_approval_url,providerOrderId:order.provider_order_id}});
      if(order.status!=='pending_payment')return error(res,409,'COMMERCE_ORDER_NOT_OPEN');
      const returnUrl=new URL('/',config.appBaseUrl);returnUrl.searchParams.set('commerce','return');returnUrl.searchParams.set('order',order.id);
      const cancelUrl=new URL('/',config.appBaseUrl);cancelUrl.searchParams.set('commerce','cancel');cancelUrl.searchParams.set('order',order.id);
      const providerOrder=await paypal.createOrder(config.paypal,{amountUSD:Number(order.total_minor)/100,referenceId:'commerce:'+order.id,requestId:order.id,returnUrl:returnUrl.toString(),cancelUrl:cancelUrl.toString()});
      if(!providerOrder.ok||!providerOrder.orderId||!providerOrder.approvalUrl){
        await adminRpc(config,'cancel_commerce_order',{p_order_id:order.id,p_buyer_profile_id:session.profile.id});
        return error(res,503,providerOrder.code||'PAYPAL_ORDER_CREATE_FAILED','The provider checkout was not created; reserved inventory was released.');
      }
      const saved=await adminRest(config,'commerce_orders',query({id:'eq.'+order.id,buyer_id:'eq.'+session.profile.id}), 'PATCH', {provider_order_id:providerOrder.orderId,provider_approval_url:providerOrder.approvalUrl,updated_at:new Date().toISOString()});
      if(!saved.ok)return error(res,503,'COMMERCE_PROVIDER_ORDER_PERSIST_FAILED','Provider checkout exists but reconciliation is required. Do not submit a new order.');
      return json(res,201,{ok:true,order:{id:order.id,status:order.status,totalMinor:Number(order.total_minor),currency:order.currency,providerOrderId:providerOrder.orderId,approvalUrl:providerOrder.approvalUrl}});
    }

    const commerceCaptureMatch=url.pathname.match(/^\/api\/marketplace\/orders\/([0-9a-f-]+)\/capture$/i);
    if(req.method==='POST'&&commerceCaptureMatch){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      if(!config.configured.paypal)return error(res,503,'PAYMENTS_NOT_CONFIGURED');
      const orderId=commerceCaptureMatch[1];
      if(!uuid(orderId))return error(res,400,'INVALID_COMMERCE_ORDER_ID');
      const found=await selectAdminRows(config,'commerce_orders',query({select:'id,buyer_id,total_minor,currency,status,provider_order_id,provider_capture_id',id:'eq.'+orderId,buyer_id:'eq.'+session.profile.id,limit:'1'}));
      if(!found.ok)return error(res,503,'COMMERCE_ORDER_UNAVAILABLE');
      const order=found.rows[0];
      if(!order)return error(res,404,'COMMERCE_ORDER_NOT_FOUND');
      if(order.status==='paid')return json(res,200,{ok:true,idempotent:true,order:{id:order.id,status:'paid',captureId:order.provider_capture_id,totalMinor:Number(order.total_minor)}});
      if(order.status!=='pending_payment'||!order.provider_order_id)return error(res,409,'COMMERCE_ORDER_NOT_OPEN');
      const captured=await paypal.captureOrder(config.paypal,order.provider_order_id,order.id.replace(/-/g,'')+'m');
      if(!captured.ok||captured.captureStatus!=='COMPLETED'||!captured.captureId)return error(res,captured.status===503?503:409,captured.code||'PAYPAL_CAPTURE_NOT_CONFIRMED','No marketplace order was marked paid because PayPal did not confirm capture.');
      if(captured.currency!==order.currency||!Number.isFinite(captured.amountUSD)||Math.round(captured.amountUSD*100)!==Number(order.total_minor))return error(res,409,'COMMERCE_CAPTURE_AMOUNT_MISMATCH');
      const completed=await adminRpc(config,'complete_commerce_order',{p_order_id:order.id,p_provider_capture_id:captured.captureId,p_capture_amount:captured.amountUSD,p_currency:captured.currency});
      if(!completed.ok)return error(res,503,'COMMERCE_RECONCILIATION_REQUIRED','PayPal capture needs reconciliation. Do not purchase again.');
      return json(res,200,{ok:true,order:{id:order.id,status:'paid',captureId:captured.captureId,totalMinor:Number(order.total_minor)}});
    }

    const commerceCancelMatch=url.pathname.match(/^\/api\/marketplace\/orders\/([0-9a-f-]+)\/cancel$/i);
    if(req.method==='POST'&&commerceCancelMatch){
      const session=await requireSession(req,res);
      if(!session.ok)return;
      const orderId=commerceCancelMatch[1];
      if(!uuid(orderId))return error(res,400,'INVALID_COMMERCE_ORDER_ID');
      const cancelled=await adminRpc(config,'cancel_commerce_order',{p_order_id:orderId,p_buyer_profile_id:session.profile.id});
      if(!cancelled.ok)return badDatabase(res,cancelled,'COMMERCE_ORDER_CANCEL_FAILED');
      return json(res,200,{ok:true,order:{id:orderId,status:typeof cancelled.data==='string'?cancelled.data.replace(/^"|"$/g,''):'cancelled'}});
    }

    if (req.method === 'POST' && url.pathname === '/api/communities') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const access = ['public','private','invite'].includes(body.access) ? body.access : null;
      if (name.length < 2 || name.length > 120) return error(res, 400, 'INVALID_COMMUNITY_NAME');
      if (!access) return error(res, 400, 'INVALID_COMMUNITY_ACCESS');
      const rawKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey)) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const communityId = randomUUID();
      const created = await adminRpc(config, 'create_community_with_owner', {
        p_community_id: communityId,
        p_owner_profile_id: session.profile.id,
        p_name: name,
        p_access: access,
        p_idempotency_key: rawKey
      });
      if (!created.ok) return badDatabase(res, created, 'COMMUNITY_CREATE_FAILED');
      const returnedId = typeof created.data === 'string' ? created.data.replace(/^"|"$/g, '') :
        Array.isArray(created.data) ? created.data[0] : created.data && created.data.create_community_with_owner;
      if (!uuid(String(returnedId || ''))) return error(res, 503, 'COMMUNITY_CREATE_RESULT_INVALID');
      const found = await rowsForUser(session, 'communities', { select: 'id,owner_id,name,access,created_at', id: 'eq.' + returnedId, limit: '1' });
      if (!found.ok || !Array.isArray(found.data) || !found.data[0]) return error(res, 503, 'COMMUNITY_CREATE_READBACK_FAILED');
      return json(res, 201, { ok: true, community: found.data[0] });
    }

    const communityJoinMatch = url.pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/join$/i);
    if (req.method === 'POST' && communityJoinMatch) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const communityId = communityJoinMatch[1];
      if (!uuid(communityId)) return error(res, 400, 'INVALID_COMMUNITY_ID');
      const existing = await rowsForUser(session, 'community_members', {
        select: 'community_id,profile_id,role', community_id: 'eq.' + communityId,
        profile_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!existing.ok) return badDatabase(res, existing, 'COMMUNITY_MEMBERSHIP_LOOKUP_FAILED');
      if (existing.data.length) return json(res, 200, { ok: true, communityId, role: existing.data[0].role, idempotent: true });
      const joined = await rowsForUser(session, 'community_members', { select: 'community_id,profile_id,role' }, {
        method: 'POST', body: { community_id: communityId, profile_id: session.profile.id, role: 'member' }
      });
      if (!joined.ok || !Array.isArray(joined.data) || !joined.data[0]) return badDatabase(res, joined, 'COMMUNITY_JOIN_FAILED');
      return json(res, 201, { ok: true, communityId, role: joined.data[0].role, idempotent: false });
    }

    const communityChannelsMatch=url.pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/channels$/i);
    if(communityChannelsMatch&&(req.method==='GET'||req.method==='POST')){
      const session=await requireSession(req,res);if(!session.ok)return;
      const communityId=communityChannelsMatch[1];if(!uuid(communityId))return error(res,400,'INVALID_COMMUNITY_ID');
      if(req.method==='GET'){
        const channels=await rowsForUser(session,'community_channels',{
          select:'id,community_id,slug,name,description,channel_type,created_by,created_at',
          community_id:'eq.'+communityId,order:'created_at.asc',limit:'100'
        });
        if(!channels.ok||!Array.isArray(channels.data))return badDatabase(res,channels,'COMMUNITY_CHANNELS_UNAVAILABLE');
        return json(res,200,{ok:true,channels:channels.data.map(ch=>({
          id:ch.id,communityId:ch.community_id,slug:ch.slug,name:ch.name,
          description:ch.description||'',channelType:ch.channel_type,createdBy:ch.created_by,createdAt:ch.created_at
        }))});
      }
      const body=await readBody(req);
      const name=typeof body.name==='string'?body.name.trim():'';
      const channelType=['chat','announcement','media','voice','event'].includes(body.channelType)?body.channelType:'chat';
      if(name.length<2||name.length>80)return error(res,400,'INVALID_CHANNEL_NAME');
      const communityRow=await rowsForUser(session,'communities',{select:'id,owner_id',id:'eq.'+communityId,limit:'1'});
      if(!communityRow.ok)return badDatabase(res,communityRow,'COMMUNITY_LOOKUP_FAILED');
      if(!communityRow.data[0])return error(res,404,'COMMUNITY_NOT_FOUND');
      const memberships=await rowsForUser(session,'community_members',{select:'role',community_id:'eq.'+communityId,profile_id:'eq.'+session.profile.id,limit:'1'});
      if(!memberships.ok)return badDatabase(res,memberships,'COMMUNITY_MEMBERSHIP_LOOKUP_FAILED');
      const role=memberships.data[0]?.role||null;
      if(communityRow.data[0].owner_id!==session.profile.id&&!['owner','moderator'].includes(role))return error(res,403,'COMMUNITY_CHANNEL_MANAGER_REQUIRED');
      const slugInput=typeof body.slug==='string'?body.slug:name;
      const slug=slugInput.toLowerCase().trim().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
      if(!/^[a-z0-9_-]{1,80}$/.test(slug))return error(res,400,'INVALID_CHANNEL_SLUG');
      const created=await rowsForUser(session,'community_channels',{select:'id,community_id,slug,name,description,channel_type,created_by,created_at'},{
        method:'POST',body:{community_id:communityId,slug,name,description:typeof body.description==='string'?body.description.trim().slice(0,500):null,channel_type:channelType,created_by:session.profile.id}
      });
      if(!created.ok||!Array.isArray(created.data)||!created.data[0])return badDatabase(res,created,'COMMUNITY_CHANNEL_CREATE_FAILED');
      const ch=created.data[0];
      return json(res,201,{ok:true,channel:{id:ch.id,communityId:ch.community_id,slug:ch.slug,name:ch.name,description:ch.description||'',channelType:ch.channel_type,createdBy:ch.created_by,createdAt:ch.created_at}});
    }

    const communityChannelPostsMatch=url.pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/channels\/([0-9a-f-]+)\/posts$/i);
    if(communityChannelPostsMatch&&(req.method==='GET'||req.method==='POST')){
      const session=await requireSession(req,res);if(!session.ok)return;
      const communityId=communityChannelPostsMatch[1],channelId=communityChannelPostsMatch[2];
      if(!uuid(communityId)||!uuid(channelId))return error(res,400,'INVALID_COMMUNITY_CHANNEL_ID');
      const channel=await rowsForUser(session,'community_channels',{select:'id,community_id,name,channel_type',id:'eq.'+channelId,community_id:'eq.'+communityId,limit:'1'});
      if(!channel.ok)return badDatabase(res,channel,'COMMUNITY_CHANNEL_LOOKUP_FAILED');
      if(!channel.data[0])return error(res,404,'COMMUNITY_CHANNEL_NOT_FOUND');
      if(req.method==='POST'){
        const body=await readBody(req);const text=typeof body.body==='string'?body.body.trim():'';
        if(text.length<1||text.length>4000)return error(res,400,'INVALID_COMMUNITY_POST');
        const created=await rowsForUser(session,'community_posts',{select:'id,community_id,channel_id,author_id,body,attachments,pinned_at,created_at'},{
          method:'POST',body:{community_id:communityId,channel_id:channelId,author_id:session.profile.id,body:text,attachments:[]}
        });
        if(!created.ok||!Array.isArray(created.data)||!created.data[0])return badDatabase(res,created,'COMMUNITY_CHANNEL_POST_CREATE_FAILED');
        const post=created.data[0];
        return json(res,201,{ok:true,post:{id:post.id,communityId,channelId,authorId:session.profile.id,body:post.body,attachments:post.attachments||[],createdAt:post.created_at}});
      }
      const posts=await rowsForUser(session,'community_posts',{
        select:'id,community_id,channel_id,author_id,body,attachments,pinned_at,created_at',
        community_id:'eq.'+communityId,channel_id:'eq.'+channelId,deleted_at:'is.null',
        order:'created_at.desc',limit:String(asSafeInt(url.searchParams.get('limit'),30,1,100))
      });
      if(!posts.ok||!Array.isArray(posts.data))return badDatabase(res,posts,'COMMUNITY_CHANNEL_POSTS_UNAVAILABLE');
      const authorIds=[...new Set(posts.data.map(post=>post.author_id).filter(uuid))];
      const authors=authorIds.length?await rowsForUser(session,'profiles',{select:'id,username,display_name,avatar_url,is_verified',id:profileIdIn(authorIds)}):{ok:true,data:[]};
      if(!authors.ok)return badDatabase(res,authors,'COMMUNITY_POST_AUTHORS_UNAVAILABLE');
      const authorMap=new Map((authors.data||[]).map(profile=>[profile.id,profile]));
      return json(res,200,{ok:true,channel:{id:channelId,name:channel.data[0].name,channelType:channel.data[0].channel_type},posts:posts.data.reverse().map(post=>({
        id:post.id,communityId,channelId,author:profileProjection(authorMap.get(post.author_id)),
        body:post.body||'',attachments:Array.isArray(post.attachments)?post.attachments:[],pinnedAt:post.pinned_at||null,createdAt:post.created_at
      }))});
    }

    const communityPostsMatch = url.pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/posts$/i);
    if (communityPostsMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const communityId = communityPostsMatch[1];
      if (!uuid(communityId)) return error(res, 400, 'INVALID_COMMUNITY_ID');
      const posts = await rowsForUser(session, 'community_posts', {
        select: 'id,community_id,channel_id,author_id,body,attachments,pinned_at,created_at',
        community_id: 'eq.' + communityId, deleted_at: 'is.null', order: 'created_at.desc',
        limit: String(asSafeInt(url.searchParams.get('limit'), 30, 1, 100))
      });
      if (!posts.ok || !Array.isArray(posts.data)) return badDatabase(res, posts, 'COMMUNITY_POSTS_UNAVAILABLE');
      const authorsIds = [...new Set(posts.data.map((post) => post.author_id).filter(uuid))];
      const authors = authorsIds.length ? await rowsForUser(session, 'profiles', {
        select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(authorsIds)
      }) : { ok: true, data: [] };
      const byId = new Map((authors.data || []).map((profile) => [profile.id, profile]));
      return json(res, 200, { ok: true, posts: posts.data.map((post) => ({
        id: post.id, communityId: post.community_id, channelId: post.channel_id,
        author: profileProjection(byId.get(post.author_id)), body: post.body || '',
        attachments: Array.isArray(post.attachments) ? post.attachments : [],
        pinnedAt: post.pinned_at || null, createdAt: post.created_at
      })) });
    }
    if (communityPostsMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const communityId = communityPostsMatch[1];
      if (!uuid(communityId)) return error(res, 400, 'INVALID_COMMUNITY_ID');
      const body = await readBody(req);
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (text.length < 1 || text.length > 4000) return error(res, 400, 'INVALID_COMMUNITY_POST');
      const created = await rowsForUser(session, 'community_posts', {
        select: 'id,community_id,channel_id,author_id,body,attachments,pinned_at,created_at'
      }, { method: 'POST', body: {
        community_id: communityId, channel_id: null, author_id: session.profile.id, body: text, attachments: []
      }});
      if (!created.ok || !Array.isArray(created.data) || !created.data[0]) return badDatabase(res, created, 'COMMUNITY_POST_CREATE_FAILED');
      return json(res, 201, { ok: true, post: {
        id: created.data[0].id, communityId, authorId: session.profile.id,
        body: created.data[0].body, attachments: [], createdAt: created.data[0].created_at
      }});
    }

    const eventRsvpMatch = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/rsvp$/i);
    if (eventRsvpMatch && (req.method === 'GET' || req.method === 'POST')) {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const eventId = eventRsvpMatch[1];
      if (!uuid(eventId)) return error(res, 400, 'INVALID_EVENT_ID');
      const lookup = await rowsForUser(session, 'community_event_rsvps', {
        select: 'event_id,profile_id,response,created_at,updated_at',
        event_id: 'eq.' + eventId, profile_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!lookup.ok || !Array.isArray(lookup.data)) return badDatabase(res, lookup, 'EVENT_RSVP_LOOKUP_FAILED');
      if (req.method === 'GET') return json(res, 200, {
        ok: true, rsvp: lookup.data[0] ? {
          eventId, response: lookup.data[0].response,
          createdAt: lookup.data[0].created_at, updatedAt: lookup.data[0].updated_at
        } : null
      });
      const body = await readBody(req);
      const responseValue = ['going','interested','not_going'].includes(body.response) ? body.response : null;
      if (!responseValue) return error(res, 400, 'INVALID_RSVP_RESPONSE');
      let saved;
      if (lookup.data[0]) {
        saved = await rowsForUser(session, 'community_event_rsvps', {
          select: 'event_id,profile_id,response,created_at,updated_at',
          event_id: 'eq.' + eventId, profile_id: 'eq.' + session.profile.id
        }, { method: 'PATCH', body: { response: responseValue, updated_at: new Date().toISOString() } });
      } else {
        saved = await rowsForUser(session, 'community_event_rsvps', {
          select: 'event_id,profile_id,response,created_at,updated_at'
        }, { method: 'POST', body: { event_id: eventId, profile_id: session.profile.id, response: responseValue } });
      }
      if (!saved.ok || !Array.isArray(saved.data) || !saved.data[0]) return badDatabase(res, saved, 'EVENT_RSVP_SAVE_FAILED');
      return json(res, lookup.data[0] ? 200 : 201, { ok: true, rsvp: {
        eventId, response: saved.data[0].response,
        createdAt: saved.data[0].created_at, updatedAt: saved.data[0].updated_at
      }});
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

    if (req.method === 'POST' && url.pathname === '/api/conversations') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const memberIds = Array.isArray(body.memberProfileIds) ? body.memberProfileIds : [];
      if (memberIds.length > 249 || memberIds.some((value) => !uuid(value))) return error(res, 400, 'INVALID_CONVERSATION_MEMBERS');
      const isGroup = body.isGroup === true;
      if (!isGroup && memberIds.length !== 1) return error(res, 400, 'DIRECT_CONVERSATION_REQUIRES_ONE_OTHER_MEMBER');
      if (isGroup && memberIds.length < 1) return error(res, 400, 'GROUP_REQUIRES_MEMBERS');
      const rawKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(rawKey)) return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const created = await adminRpc(config, 'create_conversation', {
        p_creator_profile_id: session.profile.id,
        p_member_profile_ids: [...new Set([...memberIds, session.profile.id])],
        p_is_group: isGroup,
        p_idempotency_key: rawKey
      });
      if (!created.ok) return badDatabase(res, created, 'CONVERSATION_CREATE_FAILED');
      const conversationId = typeof created.data === 'string' ? created.data.replace(/^"|"$/g, '') :
        Array.isArray(created.data) ? created.data[0] : created.data && created.data.create_conversation;
      if (!uuid(String(conversationId || ''))) return error(res, 503, 'CONVERSATION_CREATE_RESULT_INVALID');
      return json(res, 201, { ok: true, conversation: { id: conversationId, isGroup, createdBy: session.profile.id } });
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
      const membersResult = await rowsForUser(session, 'conversation_members', {
        select: 'conversation_id,profile_id,role,joined_at', conversation_id: profileIdIn(ids), limit: '2500'
      });
      if (!membersResult.ok || !Array.isArray(membersResult.data)) return badDatabase(res, membersResult, 'CONVERSATION_MEMBERS_UNAVAILABLE');
      const memberIds = [...new Set(membersResult.data.map((row) => row.profile_id).filter(uuid))];
      const profilesResult = memberIds.length ? await rowsForUser(session, 'profiles', {
        select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(memberIds), limit: '500'
      }) : { ok: true, data: [] };
      const profileMap = new Map((profilesResult.data || []).map((profile) => [profile.id, profile]));
      const messageResult = await rowsForUser(session, 'messages', {
        select: 'id,conversation_id,sender_id,body,created_at,edited_at',
        conversation_id: profileIdIn(ids), deleted_at: 'is.null', order: 'created_at.desc', limit: '1000'
      });
      if (!messageResult.ok || !Array.isArray(messageResult.data)) return badDatabase(res, messageResult, 'CONVERSATION_PREVIEWS_UNAVAILABLE');
      const latestByConversation = new Map();
      for (const message of messageResult.data) if (!latestByConversation.has(message.conversation_id)) latestByConversation.set(message.conversation_id, message);
      const conversations = conversationRows.data.map((conversation) => {
        const members = membersResult.data.filter((member) => member.conversation_id === conversation.id);
        const last = latestByConversation.get(conversation.id);
        return {
          id: conversation.id, isGroup: Boolean(conversation.is_group), createdAt: conversation.created_at,
          members: members.map((member) => ({
            id: member.profile_id, role: member.role,
            profile: profileProjection(profileMap.get(member.profile_id))
          })),
          lastMessage: last ? {
            id: last.id, senderId: last.sender_id, body: last.body || '', createdAt: last.created_at, editedAt: last.edited_at || null
          } : null
        };
      }).sort((a,b) => new Date(b.lastMessage?.createdAt || b.createdAt) - new Date(a.lastMessage?.createdAt || a.createdAt));
      return json(res, 200, { ok: true, conversations });
    }

    const messageIdMatch=url.pathname.match(/^\/api\/messages\/([0-9a-f-]+)$/i);
    if(messageIdMatch&&req.method==='PATCH'){
      const session=await requireSession(req,res);if(!session.ok)return;
      const messageId=messageIdMatch[1];if(!uuid(messageId))return error(res,400,'INVALID_MESSAGE_ID');
      const body=await readBody(req);
      if(typeof body.body!=='string'||body.body.trim().length<1||body.body.trim().length>4000)return error(res,400,'INVALID_MESSAGE');
      const result=await rowsForUser(session,'messages',{select:'id,conversation_id,sender_id,body,attachments,created_at,edited_at',id:'eq.'+messageId,sender_id:'eq.'+session.profile.id,deleted_at:'is.null'},{
        method:'PATCH',body:{body:body.body.trim(),edited_at:new Date().toISOString()}
      });
      if(!result.ok)return badDatabase(res,result,'MESSAGE_EDIT_FAILED');
      if(!Array.isArray(result.data)||!result.data[0])return error(res,404,'MESSAGE_NOT_FOUND');
      return json(res,200,{ok:true,message:result.data[0]});
    }
    if(messageIdMatch&&req.method==='DELETE'){
      const session=await requireSession(req,res);if(!session.ok)return;
      const messageId=messageIdMatch[1];if(!uuid(messageId))return error(res,400,'INVALID_MESSAGE_ID');
      const result=await rowsForUser(session,'messages',{select:'id,deleted_at',id:'eq.'+messageId,sender_id:'eq.'+session.profile.id,deleted_at:'is.null'},{
        method:'PATCH',body:{body:null,attachments:[],deleted_at:new Date().toISOString()}
      });
      if(!result.ok)return badDatabase(res,result,'MESSAGE_DELETE_FAILED');
      if(!Array.isArray(result.data)||!result.data[0])return error(res,404,'MESSAGE_NOT_FOUND');
      return json(res,200,{ok:true,message:{id:messageId,state:'deleted',deletedAt:result.data[0].deleted_at}});
    }

    const messageReactionMatch=url.pathname.match(/^\/api\/messages\/([0-9a-f-]+)\/reactions$/i);
    if(messageReactionMatch&&(req.method==='POST'||req.method==='DELETE')){
      const session=await requireSession(req,res);if(!session.ok)return;
      const messageId=messageReactionMatch[1];if(!uuid(messageId))return error(res,400,'INVALID_MESSAGE_ID');
      const body=await readBody(req);const reaction=String(body.reaction||'').trim();
      if(!['like','love','laugh','wow','sad','celebrate','custom'].includes(reaction))return error(res,400,'INVALID_MESSAGE_REACTION');
      if(req.method==='POST'){
        const created=await rowsForUser(session,'message_reactions',{select:'message_id,profile_id,reaction,created_at'},{method:'POST',body:{message_id:messageId,profile_id:session.profile.id,reaction}});
        if(!created.ok){
          if(created.status===409)return json(res,200,{ok:true,idempotent:true,reaction:{messageId,profileId:session.profile.id,reaction}});
          return badDatabase(res,created,'MESSAGE_REACTION_FAILED');
        }
        return json(res,201,{ok:true,reaction:Array.isArray(created.data)?created.data[0]:null});
      }
      const removed=await rowsForUser(session,'message_reactions',{message_id:'eq.'+messageId,profile_id:'eq.'+session.profile.id,reaction:'eq.'+reaction},{method:'DELETE'});
      if(!removed.ok)return badDatabase(res,removed,'MESSAGE_REACTION_REMOVE_FAILED');
      return json(res,200,{ok:true,removed:true});
    }

    const messageReadMatch=url.pathname.match(/^\/api\/messages\/([0-9a-f-]+)\/read$/i);
    if(messageReadMatch&&req.method==='POST'){
      const session=await requireSession(req,res);if(!session.ok)return;
      const messageId=messageReadMatch[1];if(!uuid(messageId))return error(res,400,'INVALID_MESSAGE_ID');
      const prior=await rowsForUser(session,'message_read_receipts',{select:'message_id,profile_id,read_at',message_id:'eq.'+messageId,profile_id:'eq.'+session.profile.id,limit:'1'});
      if(!prior.ok)return badDatabase(res,prior,'MESSAGE_RECEIPT_LOOKUP_FAILED');
      if(prior.data.length)return json(res,200,{ok:true,idempotent:true,receipt:prior.data[0]});
      const created=await rowsForUser(session,'message_read_receipts',{select:'message_id,profile_id,read_at'},{method:'POST',body:{message_id:messageId,profile_id:session.profile.id}});
      if(!created.ok){
        if(created.status===409)return json(res,200,{ok:true,idempotent:true});
        return badDatabase(res,created,'MESSAGE_RECEIPT_CREATE_FAILED');
      }
      return json(res,201,{ok:true,receipt:Array.isArray(created.data)?created.data[0]:null});
    }

    if(req.method==='GET'&&url.pathname==='/api/calls/incoming'){
      const session=await requireSession(req,res);if(!session.ok)return;
      const own=await rowsForUser(session,'call_participants',{
        select:'call_id,profile_id,last_state,invited_at',profile_id:'eq.'+session.profile.id,last_state:'eq.ringing',left_at:'is.null',limit:'50'
      });
      if(!own.ok||!Array.isArray(own.data))return badDatabase(res,own,'INCOMING_CALLS_UNAVAILABLE');
      const ids=[...new Set(own.data.map(row=>row.call_id).filter(uuid))];
      if(!ids.length)return json(res,200,{ok:true,calls:[]});
      const sessions=await rowsForUser(session,'call_sessions',{
        select:'id,conversation_id,initiated_by,call_type,state,provider_room,created_at',id:profileIdIn(ids),state:'in.(ringing,active)',order:'created_at.desc',limit:'50'
      });
      if(!sessions.ok||!Array.isArray(sessions.data))return badDatabase(res,sessions,'INCOMING_CALLS_UNAVAILABLE');
      const callerIds=[...new Set(sessions.data.map(row=>row.initiated_by).filter(uuid))];
      const callers=callerIds.length?await rowsForUser(session,'profiles',{select:'id,username,display_name,avatar_url',id:profileIdIn(callerIds)}):{ok:true,data:[]};
      if(!callers.ok)return badDatabase(res,callers,'CALLER_PROFILES_UNAVAILABLE');
      const callerMap=new Map((callers.data||[]).map(profile=>[profile.id,profile]));
      return json(res,200,{ok:true,calls:sessions.data.map(call=>({
        id:call.id,conversationId:call.conversation_id,callType:call.call_type,state:call.state,createdAt:call.created_at,
        caller:profileProjection(callerMap.get(call.initiated_by))
      }))});
    }

    if(req.method==='POST'&&url.pathname==='/api/calls'){
      const session=await requireSession(req,res);if(!session.ok)return;
      if(!config.configured.livekit)return error(res,503,'LIVE_NOT_CONFIGURED','LiveKit must be configured before creating a call.');
      const body=await readBody(req);const conversationId=String(body.conversationId||'');
      const callType=body.callType==='video'?'video':body.callType==='audio'?'audio':null;
      const invitees=Array.isArray(body.participantProfileIds)?body.participantProfileIds:[];
      if(!uuid(conversationId)||!callType)return error(res,400,'INVALID_CALL_REQUEST');
      if(invitees.length<1||invitees.length>7||invitees.some(id=>!uuid(id)))return error(res,400,'CALL_PARTICIPANT_COUNT_INVALID');
      const callId=randomUUID();
      const created=await adminRpc(config,'create_call_session',{
        p_call_id:callId,p_conversation_id:conversationId,p_initiated_by:session.profile.id,
        p_call_type:callType,p_invited_profile_ids:[...new Set([...invitees,session.profile.id])]
      });
      if(!created.ok)return badDatabase(res,created,'CALL_CREATE_FAILED');
      const room='zuno-call-'+callId.replace(/-/g,'');
      const token=livekit.mintToken(config.livekit,{identity:session.profile.id,room,canPublish:true,canSubscribe:true,ttlSeconds:900});
      if(!token.ok){
        await adminRpc(config,'leave_call_session',{p_call_id:callId,p_profile_id:session.profile.id,p_decline:true});
        return error(res,token.status||503,token.code||'LIVE_NOT_CONFIGURED');
      }
      return json(res,201,{ok:true,call:{id:callId,callType,state:'ringing',conversationId,providerRoom:room,livekit:{url:token.url,token:token.token,expiresAt:token.expiresAt}}});
    }
    const callJoinMatch=url.pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/join$/i);
    if(callJoinMatch&&req.method==='POST'){
      const session=await requireSession(req,res);if(!session.ok)return;
      if(!config.configured.livekit)return error(res,503,'LIVE_NOT_CONFIGURED');
      const callId=callJoinMatch[1];if(!uuid(callId))return error(res,400,'INVALID_CALL_ID');
      const joined=await adminRpc(config,'join_call_session',{p_call_id:callId,p_profile_id:session.profile.id});
      if(!joined.ok)return badDatabase(res,joined,'CALL_JOIN_FAILED');
      const row=Array.isArray(joined.data)?joined.data[0]:joined.data;
      if(!row||!row.provider_room)return error(res,503,'CALL_JOIN_RESULT_INVALID');
      const token=livekit.mintToken(config.livekit,{identity:session.profile.id,room:row.provider_room,canPublish:true,canSubscribe:true,ttlSeconds:900});
      if(!token.ok){
        await adminRpc(config,'leave_call_session',{p_call_id:callId,p_profile_id:session.profile.id,p_decline:false});
        return error(res,token.status||503,token.code||'LIVE_NOT_CONFIGURED');
      }
      return json(res,200,{ok:true,call:{id:callId,callType:row.call_type,state:row.state,providerRoom:row.provider_room,participantCount:row.participant_count,livekit:{url:token.url,token:token.token,expiresAt:token.expiresAt}}});
    }
    const callLeaveMatch=url.pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/(leave|decline)$/i);
    if(callLeaveMatch&&req.method==='POST'){
      const session=await requireSession(req,res);if(!session.ok)return;
      const callId=callLeaveMatch[1];if(!uuid(callId))return error(res,400,'INVALID_CALL_ID');
      const result=await adminRpc(config,'leave_call_session',{p_call_id:callId,p_profile_id:session.profile.id,p_decline:callLeaveMatch[2]==='decline'});
      if(!result.ok)return badDatabase(res,result,'CALL_LEAVE_FAILED');
      return json(res,200,{ok:true,call:{id:callId,state:'left'}});
    }

    const messagesMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
    if (messagesMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const conversationId = messagesMatch[1];
      if (!uuid(conversationId)) return error(res, 400, 'INVALID_CONVERSATION_ID');
      const membership = await rowsForUser(session, 'conversation_members', {
        select: 'conversation_id,profile_id', conversation_id: 'eq.' + conversationId, profile_id: 'eq.' + session.profile.id, limit: '1'
      });
      if (!membership.ok) return badDatabase(res, membership, 'CONVERSATION_ACCESS_UNAVAILABLE');
      if (!membership.data.length) return error(res, 404, 'CONVERSATION_NOT_FOUND');
      const result = await rowsForUser(session, 'messages', { select: 'id,conversation_id,sender_id,body,attachments,created_at,edited_at,deleted_at', conversation_id: 'eq.' + conversationId, deleted_at: 'is.null', order: 'created_at.desc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'MESSAGES_UNAVAILABLE');
      const messageRows = result.data.reverse();
      const senderIds = [...new Set(messageRows.map((message) => message.sender_id).filter(uuid))];
      const senders = senderIds.length ? await rowsForUser(session, 'profiles', { select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(senderIds) }) : { ok: true, data: [] };
      if (!senders.ok) return badDatabase(res, senders, 'MESSAGE_SENDER_PROFILES_UNAVAILABLE');
      const senderMap = new Map((senders.data || []).map((profile) => [profile.id, profile]));
      const messageIds = messageRows.map((message) => message.id);
      const reactions = messageIds.length ? await rowsForUser(session, 'message_reactions', {
        select: 'message_id,profile_id,reaction,created_at', message_id: profileIdIn(messageIds), limit: '1000'
      }) : { ok: true, data: [] };
      if (!reactions.ok) return badDatabase(res, reactions, 'MESSAGE_REACTIONS_UNAVAILABLE');
      const receipts = messageIds.length ? await rowsForUser(session, 'message_read_receipts', {
        select: 'message_id,profile_id,read_at', message_id: profileIdIn(messageIds), limit: '1000'
      }) : { ok: true, data: [] };
      if (!receipts.ok) return badDatabase(res, receipts, 'MESSAGE_RECEIPTS_UNAVAILABLE');
      const reactionMap = new Map();
      for (const reaction of reactions.data || []) {
        if (!reactionMap.has(reaction.message_id)) reactionMap.set(reaction.message_id, []);
        reactionMap.get(reaction.message_id).push({
          profileId: reaction.profile_id, reaction: reaction.reaction,
          mine: reaction.profile_id === session.profile.id
        });
      }
      const receiptMap = new Map();
      for (const receipt of receipts.data || []) receiptMap.set(receipt.message_id, (receiptMap.get(receipt.message_id) || 0) + 1);
      return json(res, 200, { ok: true, messages: messageRows.map((message) => ({
        ...message, sender: profileProjection(senderMap.get(message.sender_id)),
        reactions: reactionMap.get(message.id) || [], readReceiptCount: receiptMap.get(message.id) || 0,
        mine: message.sender_id === session.profile.id
      })) });
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
      const recipientUsername = typeof body.recipientUsername === 'string' ? body.recipientUsername.trim().toLowerCase() : '';
      let recipientId = String(body.recipientProfileId || '');
      const giftId = String(body.giftId || '');
      if (recipientUsername && recipientId) return error(res, 400, 'CHOOSE_ONE_GIFT_RECIPIENT');
      if (recipientUsername) {
        if (!/^[a-z0-9_.]{3,30}$/.test(recipientUsername)) return error(res, 400, 'INVALID_GIFT_RECIPIENT_USERNAME');
        const resolved = await selectAdminRows(config, 'profiles', query({ select: 'id,username', username: 'eq.' + recipientUsername, limit: '1' }));
        if (!resolved.ok) return error(res, 503, 'GIFT_RECIPIENT_LOOKUP_FAILED');
        if (!resolved.rows[0]) return error(res, 404, 'GIFT_RECIPIENT_NOT_FOUND', 'No ZUNO account uses that username.');
        recipientId = resolved.rows[0].id;
      }
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
