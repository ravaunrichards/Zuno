'use strict';
const { URL } = require('node:url');

function readBearerToken(req) {
  const value = req && req.headers ? req.headers.authorization : '';
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
  return match ? match[1] : null;
}

function supabaseReady(cfg) {
  return Boolean(cfg && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey && cfg.supabase.serviceRoleKey);
}

async function boundedFetch(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
    const user = await authResponse.json();
    if (!user || typeof user.id !== 'string') return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'The authentication provider did not return a verified user.' };

    const query = new URLSearchParams({ auth_user_id: 'eq.' + user.id, select: 'id,auth_user_id,username' });
    const profileUrl = new URL('/rest/v1/profiles?' + query.toString(), cfg.supabase.url);
    const profileResponse = await boundedFetch(profileUrl, {
      headers: { apikey: cfg.supabase.serviceRoleKey, Authorization: 'Bearer ' + cfg.supabase.serviceRoleKey, Accept: 'application/json' }
    });
    if (!profileResponse.ok) return { ok: false, status: 503, code: 'PROFILE_LOOKUP_FAILED', message: 'The authenticated profile could not be verified.' };
    const profiles = await profileResponse.json();
    if (!Array.isArray(profiles) || profiles.length !== 1 || !profiles[0].id) return { ok: false, status: 403, code: 'PROFILE_NOT_PROVISIONED', message: 'This account does not have a ZUNO profile yet.' };
    return { ok: true, user: { id: user.id }, profile: profiles[0] };
  } catch (_) {
    return { ok: false, status: 503, code: 'AUTH_PROVIDER_UNAVAILABLE', message: 'Authentication could not be verified. Please retry when the service is available.' };
  }
}

async function selectAdminRows(cfg, table, params) {
  if (!supabaseReady(cfg)) return { ok: false, status: 503, code: 'DB_NOT_CONFIGURED', rows: [] };
  const allowedTables = new Set(['live_rooms', 'live_participants']);
  if (!allowedTables.has(table)) return { ok: false, status: 400, code: 'TABLE_NOT_ALLOWED', rows: [] };
  try {
    const url = new URL('/rest/v1/' + table + '?' + params.toString(), cfg.supabase.url);
    const response = await boundedFetch(url, {
      headers: { apikey: cfg.supabase.serviceRoleKey, Authorization: 'Bearer ' + cfg.supabase.serviceRoleKey, Accept: 'application/json' }
    });
    if (!response.ok) return { ok: false, status: 503, code: 'DB_QUERY_FAILED', rows: [] };
    const rows = await response.json();
    return { ok: Array.isArray(rows), status: 200, code: null, rows: Array.isArray(rows) ? rows : [] };
  } catch (_) {
    return { ok: false, status: 503, code: 'DB_UNAVAILABLE', rows: [] };
  }
}

module.exports = { readBearerToken, supabaseReady, authenticateProfile, selectAdminRows };
