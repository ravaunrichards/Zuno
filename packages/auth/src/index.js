'use strict';
/** Reusable auth: verify a Supabase-issued JWT (HS256) server-side and extract
 *  the auth user id. Never trust client-submitted roles — roles are read from
 *  the database (roles table) on the server, not from the token claims alone. */
const crypto = require('crypto');

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function verifyJwt(token, secret) {
  if (!token || !secret) return { ok: false, code: 'NO_TOKEN_OR_SECRET' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'MALFORMED' };
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const a = Buffer.from(expected), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'BAD_SIGNATURE' };
  let claims; try { claims = JSON.parse(b64urlDecode(parts[1])); } catch (_) { return { ok: false, code: 'BAD_CLAIMS' }; }
  if (claims.exp && Date.now() / 1000 > claims.exp) return { ok: false, code: 'EXPIRED' };
  return { ok: true, authUserId: claims.sub, claims };
}

module.exports = { verifyJwt };
