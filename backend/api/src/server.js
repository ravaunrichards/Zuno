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
const paypal = require('../../../integrations/paypal');
const { Ledger } = require('../../../packages/shared/src/ledger');
const { sendGift } = require('../../../packages/gift-engine/src/delivery');
const { getPackage } = require('../../../packages/payments/src/coins');

const config = load();
const envCheck = validateRequired(config);
if (!envCheck.ok) console.warn('[config] problems:', envCheck.problems.join('; '));

// Dev fallback ledger (replaced by Postgres in a wired deployment).
const ledger = new Ledger();
ledger.openAccount('mint', 'mint');

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
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', configured: config.configured, ts: new Date().toISOString() });
    }

    // Mint a LiveKit token (server-side only). Auth check omitted here for the
    // sandbox; production validates the caller's session + room permission.
    if (req.method === 'POST' && url.pathname === '/api/livekit/token') {
      const body = await readBody(req);
      const out = livekit.mintToken(config.livekit, {
        identity: body.identity, room: body.room,
        canPublish: Boolean(body.canPublish), ttlSeconds: body.ttlSeconds,
      });
      return json(res, out.ok ? 200 : out.status || 500, out);
    }

    // Send a gift (server decides price + balance).
    if (req.method === 'POST' && url.pathname === '/api/gifts/send') {
      const body = await readBody(req);
      if (!ledger.accounts.has(body.senderId)) ledger.openAccount(body.senderId);
      if (!ledger.accounts.has(body.recipientId)) ledger.openAccount(body.recipientId);
      const result = sendGift({ ledger }, body);
      return json(res, result.ok ? 200 : 400, result);
    }

    // Create a PayPal recharge order.
    if (req.method === 'POST' && url.pathname === '/api/payments/order') {
      const body = await readBody(req);
      const pkg = getPackage(body.packageId);
      if (!pkg) return json(res, 400, { ok: false, code: 'UNKNOWN_PACKAGE' });
      const out = await paypal.createOrder(config.paypal, { amountUSD: pkg.priceUSD, referenceId: body.packageId });
      return json(res, out.ok ? 200 : out.status || 502, out);
    }

    return json(res, 404, { ok: false, code: 'NOT_FOUND' });
  } catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return json(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: e.message });
  }
});

if (require.main === module) {
  server.listen(config.apiPort, '127.0.0.1', () => console.log(`ZUNO API on 127.0.0.1:${config.apiPort}`));
}
module.exports = { server, config };
