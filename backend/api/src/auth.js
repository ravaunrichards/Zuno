'use strict';
const { URL } = require('node:url');

const USER_TABLES = new Set([
  'profiles','posts','media_assets','comments','reactions','follows','blocks',
  'post_bookmarks','post_reposts','post_view_events','post_share_events','hashtags','post_hashtags',
  'stories','story_views','story_replies','feed_preferences','conversations','conversation_members',
  'messages','message_reactions','message_read_receipts','communities','community_members',
  'community_channels','community_posts','community_post_reactions','events','community_event_rsvps',
  'muted_profiles','restricted_profiles','notification_preferences','notifications','live_rooms',
  'live_participants','guest_requests','live_chat_messages','live_polls','live_poll_options',
  'live_poll_votes','live_questions','creator_subscription_tiers','creator_subscriptions',
  'creator_subscription_entitlements','coin_packages','payment_orders','refund_records',
  'gift_deliveries','gifter_progress','gifter_level_thresholds','gifter_milestone_history',
  'creator_earning_entries','ranking_aggregates','marketplace_listings','listing_inventory',
  'commerce_orders','commerce_order_items','commerce_shipments','commerce_refunds',
  'ad_campaigns','ad_creatives','ad_placements','moderation_appeals','privacy_consents','data_requests',
  'recommendation_feedback','search_events'
]);
const ADMIN_TABLES = new Set([
  'live_rooms','live_participants','profiles','wallet_accounts','ledger_postings',
  'ranking_aggregates','notifications','live_room_events','guest_requests','gift_definitions',
  'media_assets','posts','follows','blocks','recommendation_events','event_outbox',
  'background_jobs','payment_orders','payment_webhook_events','refund_records','gift_deliveries',
  'creator_earning_entries','creator_earnings','payouts','recharge_purchases','creator_subscriptions',
  'marketplace_listings','commerce_orders','ad_campaigns','reports','moderation_actions','audit_events'
]);
const ADMIN_RPCS = new Set(['accept_live_guest_request','refresh_gifter_progress','claim_background_job','finish_background_job','fail_background_job']);

function readBearerToken(req) {
  const value = req && req.headers ? req.headers.authorization : '';
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
  return match ? match[1] : null;
}

function supabaseReady(cfg) {
  return Boolean(cfg && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey && cfg.supabase.serviceRoleKey);
}

async function boundedFetch(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { message: 'NON_JSON_PROVIDER_RESPONSE' }; }
}

async function requestRest(url, headers, method = 'GET', body = null, timeoutMs = 6500) {
  const requestHeaders = { Accept: 'application/json', ...headers };
  const options = { method, headers: requestHeaders };
  if (body !== null && body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders.Prefer = requestHeaders.Prefer || 'return=representation';
    options.body = JSON.stringify(body);
  }
  const response = await boundedFetch(url, options, timeoutMs);
  const data = await readResponse(response);
  if (!response.ok) return { ok: false, status: response.status, code: 'SUPABASE_REST_FAILED', data: null };
  return { ok: true, status: response.status, data };
}

async function authenticateProfile(req, cfg) {
  const token = readBearerToken(req);
  if (!token) return { ok: false, status: 401, code: 'AUTH_REQUIRED', message: 'A valid ZUNO session is required.' };
  if (!supabaseReady(cfg)) return { ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED', message: 'Supabase authentication and profile lookup are not configured.' };

  try {
    const authUrl = new URL('/auth/v1/user', cfg.supabase.url);
    const authResponse = await boundedFetch(authUrl, {
      headers: { apikey: cfg.supabase.anonKey, Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    if (!authResponse.ok) return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'The session is invalid or expired.' };
    const user = await readResponse(authResponse);
    if (!user || typeof user.id !== 'string') return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'The authentication provider did not return a verified user.' };

    const query = new URLSearchParams({
      auth_user_id: 'eq.' + user.id,
      select: 'id,auth_user_id,username,display_name,bio,avatar_url,cover_url,visibility,is_creator,is_verified,created_at,updated_at'
    });
    const profileUrl = new URL('/rest/v1/profiles?' + query.toString(), cfg.supabase.url);
    const profileResponse = await boundedFetch(profileUrl, {
      headers: { apikey: cfg.supabase.serviceRoleKey, Authorization: 'Bearer ' + cfg.supabase.serviceRoleKey, Accept: 'application/json' }
    });
    if (!profileResponse.ok) return { ok: false, status: 503, code: 'PROFILE_LOOKUP_FAILED', message: 'The authenticated profile could not be verified.' };
    const profiles = await readResponse(profileResponse);
    if (!Array.isArray(profiles) || profiles.length !== 1 || !profiles[0].id) return { ok: false, status: 403, code: 'PROFILE_NOT_PROVISIONED', message: 'This account does not have a ZUNO profile yet.' };
    return { ok: true, user: { id: user.id }, profile: profiles[0], jwt: token };
  } catch (_) {
    return { ok: false, status: 503, code: 'AUTH_PROVIDER_UNAVAILABLE', message: 'Authentication could not be verified. Please retry when the service is available.' };
  }
}

function restUrl(cfg, tableOrRpc, params, rpc = false) {
  const endpoint = rpc ? '/rest/v1/rpc/' + tableOrRpc : '/rest/v1/' + tableOrRpc;
  const url = new URL(endpoint, cfg.supabase.url);
  if (params && !rpc) url.search = params.toString();
  return url;
}

async function userRest(cfg, session, table, params = new URLSearchParams(), method = 'GET', body = null) {
  if (!supabaseReady(cfg)) return { ok: false, status: 503, code: 'DB_NOT_CONFIGURED', data: null };
  if (!session || !session.jwt || !session.profile || !session.profile.id) return { ok: false, status: 401, code: 'AUTH_REQUIRED', data: null };
  if (!USER_TABLES.has(table)) return { ok: false, status: 400, code: 'TABLE_NOT_ALLOWED', data: null };
  try {
    return await requestRest(restUrl(cfg, table, params), {
      apikey: cfg.supabase.anonKey,
      Authorization: 'Bearer ' + session.jwt
    }, method, body);
  } catch (_) {
    return { ok: false, status: 503, code: 'DB_UNAVAILABLE', data: null };
  }
}

async function adminRest(cfg, table, params = new URLSearchParams(), method = 'GET', body = null) {
  if (!supabaseReady(cfg)) return { ok: false, status: 503, code: 'DB_NOT_CONFIGURED', data: null };
  if (!ADMIN_TABLES.has(table)) return { ok: false, status: 400, code: 'TABLE_NOT_ALLOWED', data: null };
  try {
    return await requestRest(restUrl(cfg, table, params), {
      apikey: cfg.supabase.serviceRoleKey,
      Authorization: 'Bearer ' + cfg.supabase.serviceRoleKey
    }, method, body);
  } catch (_) {
    return { ok: false, status: 503, code: 'DB_UNAVAILABLE', data: null };
  }
}

async function adminRpc(cfg, rpc, body) {
  if (!supabaseReady(cfg)) return { ok: false, status: 503, code: 'DB_NOT_CONFIGURED', data: null };
  if (!ADMIN_RPCS.has(rpc)) return { ok: false, status: 400, code: 'RPC_NOT_ALLOWED', data: null };
  try {
    return await requestRest(restUrl(cfg, rpc, null, true), {
      apikey: cfg.supabase.serviceRoleKey,
      Authorization: 'Bearer ' + cfg.supabase.serviceRoleKey
    }, 'POST', body);
  } catch (_) {
    return { ok: false, status: 503, code: 'DB_UNAVAILABLE', data: null };
  }
}

async function selectAdminRows(cfg, table, params = new URLSearchParams()) {
  const result = await adminRest(cfg, table, params);
  return { ok: result.ok, status: result.status, code: result.code, rows: Array.isArray(result.data) ? result.data : [] };
}

function profileProjection(profile) {
  if (!profile) return null;
  const { id, username, display_name, bio, avatar_url, cover_url, visibility, is_creator, is_verified, created_at, updated_at } = profile;
  return { id, username, displayName: display_name || username, bio: bio || '', avatarUrl: avatar_url || null, coverUrl: cover_url || null, visibility, isCreator: Boolean(is_creator), isVerified: Boolean(is_verified), createdAt: created_at || null, updatedAt: updated_at || null };
}

module.exports = { readBearerToken, supabaseReady, authenticateProfile, userRest, adminRest, adminRpc, selectAdminRows, profileProjection };
