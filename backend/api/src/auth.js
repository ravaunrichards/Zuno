'use strict';
const { URL } = require('node:url');

const USER_TABLES = new Set([
  'profiles','posts','media_assets','comments','reactions','follows','blocks',
  'post_bookmarks','post_reposts','post_view_events','post_share_events','hashtags','post_hashtags',
  'stories','story_views','story_replies','feed_preferences','conversations','conversation_members',
  'messages','message_reactions','message_read_receipts','communities','community_members',
  'community_channels','community_posts','community_post_reactions','events','community_event_rsvps',
  'muted_profiles','restricted_profiles','notification_preferences','notifications','push_subscriptions','live_rooms',
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
  'roles',
  'coin_packages','provider_webhook_attempts','creator_payout_profiles',
  'wallet_restrictions','creator_subscription_tiers','creator_subscriptions','creator_subscription_entitlements','live_rooms','live_participants','profiles','wallet_accounts','ledger_postings',
  'ranking_aggregates','notifications','live_room_events','guest_requests','gift_definitions','live_poll_votes','live_polls',
  'media_assets','posts','follows','blocks','post_share_events','post_view_events','recommendation_events','event_outbox',
  'background_jobs','payment_orders','payment_webhook_events','refund_records','gift_deliveries',
  'creator_earning_entries','creator_earnings','payouts','payout_reconciliation_records','recharge_purchases','creator_subscriptions',
  'marketplace_listings','listing_inventory','commerce_orders','commerce_order_items','commerce_shipments','commerce_fulfillment_events','ad_campaigns','reports','moderation_actions','audit_events'
]);
const ADMIN_RPCS = new Set(['sync_creator_subscription','create_marketplace_listing','set_marketplace_listing_state','create_commerce_order','complete_commerce_order','cancel_commerce_order','update_commerce_fulfillment','create_conversation','create_community_with_owner','accept_live_guest_request','refresh_gifter_progress','claim_background_job','finish_background_job','fail_background_job','queue_media_processing_job','deliver_gift','credit_captured_coin_order','reserve_coin_refund','finalize_coin_refund','request_creator_payout','attach_creator_payout_batch','complete_creator_payout','release_creator_payout','set_profile_relationship','create_live_room','start_live_room','end_live_room','join_live_room','leave_live_room','create_live_guest_request','reject_live_guest_request','create_live_poll','get_live_room_summaries','search_public_documents','get_creator_analytics','get_admin_overview','resolve_moderation_report','create_call_session','join_call_session','leave_call_session']);

function readBearerToken(req) {
  const value = req && req.headers ? req.headers.authorization : '';
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
  return match ? match[1] : null;
}

function supabaseAuthReady(cfg) {
  return Boolean(cfg && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey);
}

// Privileged server-side database access requires the service-role secret.
// User-scoped reads/writes and authentication must work with a verified user JWT
// and the public anon key, with RLS enforcing ownership.
function supabaseReady(cfg) {
  return Boolean(supabaseAuthReady(cfg) && cfg.supabase.serviceRoleKey);
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
  if (!response.ok) {
    const domainMessage = data && typeof data.message === 'string' ? data.message.trim() : '';
    const allowedDomainCodes = new Set(["CALL_IDENTITY_REQUIRED","CALL_TYPE_INVALID","CALL_CONVERSATION_ACCESS_DENIED","CALL_PARTICIPANT_COUNT_INVALID","CALL_INVITE_NOT_CONVERSATION_MEMBER","CALL_BLOCK_RELATION_EXISTS","CALL_ALREADY_ACTIVE","CALL_NOT_FOUND","CALL_INVITATION_REQUIRED","CALL_PARTICIPATION_CLOSED","CALL_NOT_JOINABLE","CALL_FULL","CALL_PARTICIPANT_NOT_FOUND","CONVERSATION_CREATOR_REQUIRED","CONVERSATION_IDEMPOTENCY_KEY_INVALID","GROUP_MEMBER_COUNT_INVALID","DIRECT_CONVERSATION_REQUIRES_TWO_MEMBERS","CONVERSATION_MEMBER_NOT_FOUND","CONVERSATION_IDEMPOTENCY_CONFLICT","CONVERSATION_CREATION_IN_PROGRESS","DIRECT_MESSAGE_BLOCKED","COMMUNITY_IDENTITY_REQUIRED","INVALID_COMMUNITY_NAME","INVALID_COMMUNITY_ACCESS","COMMUNITY_IDEMPOTENCY_KEY_INVALID","COMMUNITY_IDEMPOTENCY_CONFLICT","COMMUNITY_CREATION_IN_PROGRESS","LIVE_ROOM_REQUEST_INVALID","LIVE_ROOM_TITLE_INVALID","LIVE_ROOM_CATEGORY_INVALID","LIVE_HOST_NOT_FOUND","LIVE_ROOM_NOT_FOUND","LIVE_HOST_REQUIRED","LIVE_ROOM_ENDED","LIVE_ROOM_NOT_LIVE","LIVE_BLOCK_RELATION_EXISTS","LIVE_ROOM_ACCESS_DENIED","LIVE_HOST_MUST_END_ROOM","LIVE_HOST_CANNOT_REQUEST","LIVE_ALREADY_PUBLISHING","LIVE_GUEST_REQUEST_NOT_FOUND","LIVE_GUEST_REQUEST_NOT_PENDING","LIVE_GUEST_REQUEST_EXPIRED","LIVE_ROOM_FULL","LIVE_POLL_QUESTION_INVALID","LIVE_POLL_OPTION_COUNT_INVALID","LIVE_POLL_CLOSE_TIME_INVALID","LIVE_POLL_OPTION_INVALID","LIVE_POLL_OPTIONS_DUPLICATE","MODERATION_REQUEST_INVALID","MODERATION_DECISION_INVALID","MODERATION_REASON_INVALID","MODERATION_NOTE_TOO_LONG","MODERATION_ROLE_REQUIRED","REPORT_NOT_FOUND","REPORT_ALREADY_RESOLVED","MODERATION_TARGET_INVALID","MODERATION_TARGET_NOT_FOUND","MODERATION_TARGET_TYPE_UNSUPPORTED","INSUFFICIENT_FUNDS","NO_ACCOUNT","NO_RECIPIENT_ACCOUNT","INVALID_GIFT_PRICE","SELF_GIFT_NOT_ALLOWED","INVALID_IDEMPOTENCY_KEY","GIFT_REQUEST_INVALID","SELF_GIFT_FORBIDDEN","GIFT_IDEMPOTENCY_KEY_INVALID","GIFT_MESSAGE_TOO_LONG","GIFT_IDEMPOTENCY_CONFLICT","UNKNOWN_GIFT","SENDER_NOT_FOUND","RECIPIENT_NOT_FOUND","GIFT_LOCKED","GIFT_UNLOCK_RULE_UNSUPPORTED","LIVE_ROOM_NOT_ACTIVE","SENDER_NOT_IN_LIVE_ROOM","RECIPIENT_NOT_IN_LIVE_ROOM","WALLET_ACCOUNT_UNAVAILABLE","GIFT_DELIVERY_RECORD_FAILED","PAYMENT_CAPTURE_IDENTIFIERS_REQUIRED","PAYMENT_CURRENCY_MISMATCH","PAYMENT_ORDER_NOT_FOUND","PAYMENT_ALREADY_CREDITED","PAYMENT_ORDER_STATE_INVALID","PAYMENT_AMOUNT_MISMATCH","CAPTURE_ALREADY_USED","COIN_PACKAGE_UNAVAILABLE","MARKETPLACE_LISTING_IDENTITY_REQUIRED","MARKETPLACE_LISTING_TITLE_INVALID","MARKETPLACE_LISTING_CATEGORY_INVALID","MARKETPLACE_LISTING_DESCRIPTION_INVALID","MARKETPLACE_LISTING_PRICE_INVALID","MARKETPLACE_LISTING_QUANTITY_INVALID","MARKETPLACE_LISTING_IDEMPOTENCY_INVALID","MARKETPLACE_LISTING_IDEMPOTENCY_CONFLICT","MARKETPLACE_LISTING_CREATION_IN_PROGRESS","MARKETPLACE_LISTING_STATE_INVALID","MARKETPLACE_LISTING_NOT_FOUND","MARKETPLACE_LISTING_NOT_OWNER","MARKETPLACE_STOCK_EMPTY","MARKETPLACE_BUYER_REQUIRED","MARKETPLACE_ORDER_ITEMS_INVALID","MARKETPLACE_ORDER_IDEMPOTENCY_INVALID","MARKETPLACE_ORDER_IDEMPOTENCY_CONFLICT","MARKETPLACE_ORDER_ITEM_DUPLICATE","MARKETPLACE_ITEM_QUANTITY_INVALID","MARKETPLACE_LISTING_NOT_ACTIVE","MARKETPLACE_SELF_PURCHASE_FORBIDDEN","MARKETPLACE_INVENTORY_UNAVAILABLE","MARKETPLACE_ORDER_TOTAL_INVALID","COMMERCE_CAPTURE_ID_REQUIRED","COMMERCE_ORDER_NOT_FOUND","COMMERCE_CURRENCY_MISMATCH","COMMERCE_CAPTURE_AMOUNT_MISMATCH","COMMERCE_ORDER_ALREADY_PAID","COMMERCE_ORDER_NOT_OPEN","COMMERCE_CAPTURE_ALREADY_USED","COMMERCE_INVENTORY_RECONCILIATION_REQUIRED","COMMERCE_ORDER_NOT_CANCELLABLE","COMMERCE_FULFILLMENT_IDENTITY_REQUIRED","COMMERCE_FULFILLMENT_STATE_INVALID","COMMERCE_CARRIER_INVALID","COMMERCE_TRACKING_REFERENCE_INVALID","COMMERCE_TRACKING_REQUIRED","COMMERCE_ORDER_NOT_FULFILLABLE","COMMERCE_SELLER_NOT_ORDER_PARTY","COMMERCE_ORDER_ALREADY_FULFILLED","COMMERCE_FULFILLMENT_TRANSITION_INVALID","CREATOR_REQUIRED","CREATOR_TIER_TITLE_INVALID","CREATOR_TIER_KEY_INVALID","CREATOR_TIER_PRICE_INVALID","CREATOR_TIER_BENEFITS_INVALID","CREATOR_TIER_IDEMPOTENCY_INVALID","CREATOR_SUBSCRIPTION_TIER_NOT_FOUND","CREATOR_SUBSCRIPTION_PLAN_UNAVAILABLE","CREATOR_SUBSCRIPTION_NOT_FOUND","CREATOR_SUBSCRIPTION_ALREADY_ACTIVE","CREATOR_SUBSCRIPTION_IDEMPOTENCY_CONFLICT","CREATOR_SUBSCRIPTION_PROVIDER_ID_REQUIRED","CREATOR_SUBSCRIPTION_PROVIDER_STATUS_INVALID"]);
    for (const code of ["PAYOUT_CREATOR_REQUIRED","PAYOUT_MINIMUM_NOT_CONFIGURED","PAYOUT_IDEMPOTENCY_KEY_INVALID","PAYOUT_IDEMPOTENCY_CONFLICT","PAYOUT_DESTINATION_REQUIRED","PAYOUT_RECIPIENT_NOT_READY","PAYOUT_IDENTITY_NOT_VERIFIED","PAYOUT_COUNTRY_NOT_ELIGIBLE","PAYOUT_COMPLIANCE_NOT_CLEARED","PAYOUT_RISK_HOLD","PAYOUT_NO_AVAILABLE_EARNINGS","PAYOUT_BELOW_MINIMUM","PAYOUT_RESERVATION_FAILED","PAYOUT_PROVIDER_BATCH_INVALID","PAYOUT_NOT_FOUND","PAYOUT_ALREADY_FAILED","PAYOUT_PROVIDER_BATCH_CONFLICT","PAYOUT_PROVIDER_REFERENCE_REQUIRED","PAYOUT_COMPLETION_CONFLICT","PAYOUT_STATE_NOT_COMPLETABLE","PAYOUT_AMOUNT_MISMATCH","PAYOUT_EARNINGS_RESERVATION_MISMATCH","PAYOUT_ID_REQUIRED","PAYOUT_ALREADY_PAID"]) allowedDomainCodes.add(code);
    for (const code of ['RELATIONSHIP_ID_REQUIRED','SELF_RELATIONSHIP_FORBIDDEN','RELATIONSHIP_KIND_INVALID','RELATIONSHIP_ACTION_INVALID','RELATIONSHIP_OWNER_NOT_FOUND','RELATIONSHIP_TARGET_NOT_FOUND','RELATIONSHIP_REASON_INVALID']) allowedDomainCodes.add(code);
    return { ok: false, status: response.status, code: allowedDomainCodes.has(domainMessage) ? domainMessage : 'SUPABASE_REST_FAILED', data: null };
  }
  return { ok: true, status: response.status, data };
}

async function authenticateProfile(req, cfg) {
  const token = readBearerToken(req);
  if (!token) return { ok: false, status: 401, code: 'AUTH_REQUIRED', message: 'A valid ZUNO session is required.' };
  if (!supabaseAuthReady(cfg)) return { ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED', message: 'Supabase authentication is not configured.' };

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
      select: 'id,auth_user_id,username,display_name,bio,avatar_url,cover_url,visibility,is_creator,is_verified,is_deleted,created_at,updated_at'
    });
    const profileUrl = new URL('/rest/v1/profiles?' + query.toString(), cfg.supabase.url);
    const profileResponse = await boundedFetch(profileUrl, {
      // The supplied bearer token was just verified with Supabase Auth.
      // RLS permits the caller to read their own profile; no service role needed.
      headers: { apikey: cfg.supabase.anonKey, Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    if (!profileResponse.ok) return { ok: false, status: 503, code: 'PROFILE_LOOKUP_FAILED', message: 'The authenticated profile could not be verified.' };
    const profiles = await readResponse(profileResponse);
    if (!Array.isArray(profiles) || profiles.length !== 1 || !profiles[0].id) return { ok: false, status: 403, code: 'PROFILE_NOT_PROVISIONED', message: 'This account does not have a ZUNO profile yet.' };
    if (profiles[0].is_deleted) return { ok: false, status: 403, code: 'ACCOUNT_DELETION_IN_PROGRESS', message: 'This account is being erased and can no longer be used.' };
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
  if (!supabaseAuthReady(cfg)) return { ok: false, status: 503, code: 'DB_NOT_CONFIGURED', data: null };
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
