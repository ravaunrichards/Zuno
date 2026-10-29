'use strict';
/**
 * Supabase adapter. Two clients:
 *   - anon client for user-scoped requests (RLS enforced),
 *   - service-role client for trusted server operations (NEVER shipped to clients).
 * When not configured, returns an explicit 503 instead of pretending.
 *
 * This wraps the REST (PostgREST) + Auth endpoints with Node's https so it is
 * real and runnable without the @supabase/supabase-js dependency; swap in the
 * official client in production if preferred.
 */
const https = require('https');
const { URL } = require('url');

function notConfigured() {
  return { ok: false, status: 503, code: 'DB_NOT_CONFIGURED',
    message: 'Supabase is not configured. Provide SUPABASE_URL and keys.' };
}

function restRequest(baseUrl, key, { method, path: p, body, userJwt }) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + p);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${userJwt || key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed = null; try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function createClient(cfg, { serviceRole = false } = {}) {
  if (!cfg || !cfg.url || (serviceRole ? !cfg.serviceRoleKey : !cfg.anonKey)) {
    return { configured: false, notConfigured };
  }
  const key = serviceRole ? cfg.serviceRoleKey : cfg.anonKey;
  const base = cfg.url.replace(/\/$/, '') + '/rest/v1';
  return {
    configured: true,
    serviceRole,
    from(table) {
      return {
        select: (cols = '*', userJwt) => restRequest(base, key, { method: 'GET', path: `/${table}?select=${encodeURIComponent(cols)}`, userJwt }),
        insert: (row, userJwt) => restRequest(base, key, { method: 'POST', path: `/${table}`, body: row, userJwt }),
        update: (match, patch, userJwt) => restRequest(base, key, { method: 'PATCH', path: `/${table}?${match}`, body: patch, userJwt }),
      };
    },
  };
}

module.exports = { createClient, notConfigured };
