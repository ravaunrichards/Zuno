'use strict';
/**
 * PayPal Developer adapter. Real REST calls against the official API hosts.
 * When credentials are absent, every operation returns an explicit 503
 * (PAYMENTS_NOT_CONFIGURED) rather than fabricating a successful charge.
 *
 * Uses Node's global fetch (Node 18+) or falls back to https. No secret is
 * ever exposed to clients; this module runs on the server only.
 */
const https = require('https');

const HOSTS = { sandbox: 'api-m.sandbox.paypal.com', live: 'api-m.paypal.com' };

function notConfigured() {
  return { ok: false, status: 503, code: 'PAYMENTS_NOT_CONFIGURED',
    message: 'PayPal credentials are not set. Provide PAYPAL_CLIENT_ID/CLIENT_SECRET.' };
}

function request(host, pathName, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ host, path: pathName, method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = null; try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) {}
          resolve({ status: res.statusCode, body: parsed, raw: chunks });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getAccessToken(cfg) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await request(host, '/v1/oauth2/token?grant_type=client_credentials', 'POST',
    { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, null);
  if (res.status !== 200) return { ok: false, status: res.status, code: 'AUTH_FAILED', body: res.body };
  return { ok: true, accessToken: res.body.access_token, expiresIn: res.body.expires_in };
}

/** Create a checkout order (coins recharge). Amount in USD. */
async function createOrder(cfg, { amountUSD, referenceId, requestId }) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  const tok = await getAccessToken(cfg);
  if (!tok.ok) return tok;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const res = await request(host, '/v2/checkout/orders', 'POST',
    { Authorization: `Bearer ${tok.accessToken}`, ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {}) },
    { intent: 'CAPTURE', purchase_units: [{ reference_id: referenceId, custom_id: referenceId, amount: { currency_code: 'USD', value: amountUSD.toFixed(2) } }] });
  if (res.status >= 300) return { ok: false, status: res.status, code: 'ORDER_FAILED', body: res.body };
  const links = Array.isArray(res.body && res.body.links) ? res.body.links : [];
  const approval = links.find((link) => link.rel === 'approve' || link.rel === 'payer-action');
  return { ok: true, orderId: res.body.id, status: res.body.status, approvalUrl: approval && approval.href || null };
}

/** Capture an approved order. */
async function captureOrder(cfg, orderId, requestId) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  const tok = await getAccessToken(cfg);
  if (!tok.ok) return tok;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const res = await request(host, `/v2/checkout/orders/${orderId}/capture`, 'POST',
    { Authorization: `Bearer ${tok.accessToken}`, ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {}) }, {});
  if (res.status >= 300) return { ok: false, status: res.status, code: 'CAPTURE_FAILED', body: res.body };
  const units = Array.isArray(res.body && res.body.purchase_units) ? res.body.purchase_units : [];
  const payments = units[0] && units[0].payments;
  const captures = payments && Array.isArray(payments.captures) ? payments.captures : [];
  const capture = captures[0] || null;
  return { ok: true, orderId, captureId: capture && capture.id || null, status: res.body.status || null,
    captureStatus: capture && capture.status || null,
    amountUSD: capture && capture.amount ? Number(capture.amount.value) : null,
    currency: capture && capture.amount ? String(capture.amount.currency_code || '') : null };
}

/**
 * Verify a PayPal webhook using the documented verify-webhook-signature API.
 * Never trust an unsigned or unverified webhook as proof of payment.
 * @param {object} headers raw request headers (lowercased keys)
 * @param {object} eventBody parsed webhook event JSON
 */
async function verifyWebhook(cfg, headers, eventBody) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret || !cfg.webhookId) return { ok: false, verified: false, code: 'WEBHOOK_NOT_CONFIGURED' };
  const tok = await getAccessToken(cfg);
  if (!tok.ok) return tok;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const res = await request(host, '/v1/notifications/verify-webhook-signature', 'POST',
    { Authorization: `Bearer ${tok.accessToken}` },
    {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: cfg.webhookId,
      webhook_event: eventBody,
    });
  const verified = res.body && res.body.verification_status === 'SUCCESS';
  return { ok: true, verified: Boolean(verified) };
}

module.exports = { getAccessToken, createOrder, captureOrder, verifyWebhook, notConfigured, HOSTS };
