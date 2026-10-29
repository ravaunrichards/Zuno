'use strict';

const SESSION_KEY = 'zuno:auth-session';
let publicConfigPromise = null;

export function apiBaseUrl() {
  const fromRuntime = typeof window !== 'undefined' && window.ZUNO_CONFIG && typeof window.ZUNO_CONFIG.apiBaseUrl === 'string'
    ? window.ZUNO_CONFIG.apiBaseUrl.trim() : '';
  if (fromRuntime) return fromRuntime.replace(/\/$/, '');
  if (typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname)) return 'http://localhost:4000';
  return '';
}

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session && typeof session.access_token === 'string' && typeof session.refresh_token === 'string' ? session : null;
  } catch (_) { return null; }
}

function persistSession(result) {
  if (!result || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') return null;
  const expiresAtRaw = Number(result.expires_at);
  const expiresAt = Number.isFinite(expiresAtRaw)
    ? (expiresAtRaw < 100000000000 ? expiresAtRaw * 1000 : expiresAtRaw)
    : Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000;
  const safe = {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expires_at: expiresAt,
    token_type: result.token_type || 'bearer',
    user: result.user && typeof result.user === 'object'
      ? { id: result.user.id || null, email: result.user.email || null } : null
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(safe)); } catch (_) {}
  window.dispatchEvent(new CustomEvent('zuno:session-change'));
  return safe;
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  window.dispatchEvent(new CustomEvent('zuno:session-change'));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 8000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok) {
      const error = new Error(String(payload.msg || payload.message || payload.error_description || payload.error || 'Request failed').slice(0, 240));
      error.status = response.status;
      error.code = payload.code || payload.error || 'REQUEST_FAILED';
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPublicConfig() {
  if (!publicConfigPromise) {
    publicConfigPromise = fetchJson(apiBaseUrl() + '/api/meta/public-config', {
      headers: { Accept: 'application/json' }
    }).then((payload) => {
      const runtime = window.ZUNO_CONFIG || {};
      const value = {
        apiBaseUrl: apiBaseUrl(),
        supabaseUrl: payload.supabaseUrl || runtime.supabaseUrl || '',
        supabaseAnonKey: payload.supabaseAnonKey || runtime.supabaseAnonKey || ''
      };
      if (!value.supabaseUrl || !value.supabaseAnonKey) {
        throw new Error('Supabase Auth is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY on the API service.');
      }
      return value;
    }).catch((error) => {
      publicConfigPromise = null;
      throw error;
    });
  }
  return publicConfigPromise;
}

export function getSession() {
  return readStoredSession();
}

export async function getFreshAccessToken() {
  let session = readStoredSession();
  if (!session) return null;
  if (Number(session.expires_at || 0) > Date.now() + 60000) return session.access_token;
  try {
    const config = await getPublicConfig();
    const url = new URL('/auth/v1/token?grant_type=refresh_token', config.supabaseUrl);
    const refreshed = await fetchJson(url, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    session = persistSession(refreshed);
    return session ? session.access_token : null;
  } catch (_) {
    clearSession();
    return null;
  }
}

async function authRequest(path, payload) {
  const config = await getPublicConfig();
  const url = new URL(path, config.supabaseUrl);
  return fetchJson(url, {
    method: 'POST',
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });
}

export async function signIn(email, password) {
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    throw new Error('Enter your email address and password.');
  }
  const response = await authRequest('/auth/v1/token?grant_type=password', { email: email.trim(), password });
  if (!persistSession(response)) throw new Error('Supabase did not return a valid session.');
  return response;
}

export async function signUp({ email, password, username, displayName }) {
  if (typeof email !== 'string' || !email.trim()) throw new Error('Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password with at least 8 characters.');
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,30}$/.test(normalizedUsername)) {
    throw new Error('Username must be 3–30 characters using letters, numbers, underscores or periods.');
  }
  const response = await authRequest('/auth/v1/signup', {
    email: email.trim(),
    password,
    data: {
      username: normalizedUsername,
      display_name: String(displayName || normalizedUsername).trim().slice(0, 80)
    }
  });
  if (response.access_token) persistSession(response);
  return response;
}

export async function signOut() {
  const session = readStoredSession();
  if (session) {
    try {
      const config = await getPublicConfig();
      await fetchJson(new URL('/auth/v1/logout', config.supabaseUrl), {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: 'Bearer ' + session.access_token,
          Accept: 'application/json'
        }
      });
    } catch (_) {}
  }
  clearSession();
}
