'use strict';
/**
 * PayPal Developer REST adapter. Only the API/worker process can call this module.
 * Provider uncertainty is surfaced as a retryable result rather than being
 * misreported as a successful capture or refund.
 */
const https = require('https');
const HOSTS = { sandbox: 'api-m.sandbox.paypal.com', live: 'api-m.paypal.com' };

function notConfigured() {
  return { ok: false, status: 503, code: 'PAYMENTS_NOT_CONFIGURED', message: 'PayPal Developer credentials are not set.' };
}
function request(host, pathName, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : JSON.stringify(body);
    const req = https.request({ host, path: pathName, method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers,
        ...(data !== null ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) {}
          resolve({ status: res.statusCode, body: parsed, raw: chunks });
        });
      });
    req.setTimeout(12000, () => req.destroy(new Error('PAYPAL_TIMEOUT')));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
async function getAccessToken(cfg) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const auth = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
  try {
    const res = await request(host, '/v1/oauth2/token?grant_type=client_credentials', 'POST',
      { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, null);
    if (res.status !== 200 || !res.body || !res.body.access_token) return { ok: false, status: res.status || 502, code: 'PAYPAL_AUTH_FAILED' };
    return { ok: true, accessToken: res.body.access_token, expiresIn: res.body.expires_in };
  } catch (_) { return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' }; }
}
async function createOrder(cfg, { amountUSD, referenceId, requestId, returnUrl, cancelUrl }) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  const amount = Number(amountUSD);
  if (!Number.isFinite(amount) || amount <= 0 || !referenceId) return { ok: false, status: 400, code: 'PAYPAL_ORDER_INPUT_INVALID' };
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const applicationContext = { user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' };
  if (returnUrl) applicationContext.return_url = returnUrl;
  if (cancelUrl) applicationContext.cancel_url = cancelUrl;
  try {
    const result = await request(host, '/v2/checkout/orders', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {})
    }, {
      intent: 'CAPTURE',
      application_context: applicationContext,
      purchase_units: [{
        reference_id: referenceId,
        custom_id: referenceId,
        amount: { currency_code: 'USD', value: amount.toFixed(2) }
      }]
    });
    if (result.status < 200 || result.status >= 300 || !result.body || !result.body.id) {
      return { ok: false, status: result.status || 502, code: 'PAYPAL_ORDER_FAILED' };
    }
    const links = Array.isArray(result.body.links) ? result.body.links : [];
    const approval = links.find((link) => link.rel === 'approve' || link.rel === 'payer-action');
    return { ok: true, orderId: result.body.id, status: result.body.status || null, approvalUrl: approval && approval.href || null };
  } catch (_) { return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' }; }
}
async function captureOrder(cfg, orderId, requestId) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{5,100}$/.test(orderId)) return { ok: false, status: 400, code: 'PAYPAL_ORDER_ID_INVALID' };
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  try {
    const result = await request(host, '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {})
    }, {});
    if (result.status < 200 || result.status >= 300 || !result.body) {
      return { ok: false, status: result.status || 502, code: 'PAYPAL_CAPTURE_FAILED' };
    }
    const units = Array.isArray(result.body.purchase_units) ? result.body.purchase_units : [];
    const payments = units[0] && units[0].payments;
    const captures = payments && Array.isArray(payments.captures) ? payments.captures : [];
    const capture = captures[0] || null;
    return {
      ok: true, orderId, status: result.body.status || null,
      captureId: capture && capture.id || null,
      captureStatus: capture && capture.status || null,
      amountUSD: capture && capture.amount ? Number(capture.amount.value) : null,
      currency: capture && capture.amount ? String(capture.amount.currency_code || '') : null
    };
  } catch (_) { return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' }; }
}
async function refundCapture(cfg, captureId, requestId) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  if (typeof captureId !== 'string' || !/^[A-Za-z0-9_-]{5,100}$/.test(captureId)) return { ok: false, status: 400, code: 'PAYPAL_CAPTURE_ID_INVALID' };
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  try {
    const result = await request(host, '/v2/payments/captures/' + encodeURIComponent(captureId) + '/refund', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {})
    }, {});
    if (result.status < 200 || result.status >= 300 || !result.body || !result.body.id) {
      const status = result.status || 502;
      return { ok: false, status, code: status >= 500 ? 'PAYPAL_PROVIDER_UNAVAILABLE' : 'PAYPAL_REFUND_REJECTED' };
    }
    return {
      ok: true,
      refundId: result.body.id,
      status: result.body.status || null,
      amountUSD: result.body.amount ? Number(result.body.amount.value) : null,
      currency: result.body.amount ? String(result.body.amount.currency_code || '') : 'USD'
    };
  } catch (_) { return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' }; }
}
async function verifyWebhook(cfg, headers, eventBody) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret || !cfg.webhookId) return { ok: false, verified: false, code: 'WEBHOOK_NOT_CONFIGURED' };
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  try {
    const result = await request(host, '/v1/notifications/verify-webhook-signature', 'POST', {
      Authorization: 'Bearer ' + token.accessToken
    }, {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: cfg.webhookId,
      webhook_event: eventBody
    });
    if (result.status < 200 || result.status >= 300) return { ok: false, status: result.status || 502, verified: false, code: 'WEBHOOK_VERIFICATION_FAILED' };
    return { ok: true, verified: Boolean(result.body && result.body.verification_status === 'SUCCESS') };
  } catch (_) { return { ok: false, status: 503, verified: false, code: 'PAYPAL_PROVIDER_UNAVAILABLE' }; }
}
module.exports = { getAccessToken, createOrder, captureOrder, refundCapture, verifyWebhook, notConfigured, HOSTS };
