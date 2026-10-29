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
    const data = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
    const res = await request(host, '/v1/oauth2/token', 'POST',
      { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, 'grant_type=client_credentials');
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

async function createSubscriptionPlan(cfg, { creatorProfileId, tierKey, title, description, amountUSD, requestId }) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  if (!creatorProfileId || !tierKey || typeof title !== 'string' || title.trim().length < 2 ||
      !Number.isFinite(Number(amountUSD)) || Number(amountUSD) <= 0) {
    return { ok: false, status: 400, code: 'PAYPAL_PLAN_INPUT_INVALID' };
  }
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const base = String(requestId || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 34);
  if (base.length < 10) return { ok: false, status: 400, code: 'PAYPAL_PLAN_REQUEST_ID_INVALID' };
  try {
    const productResult = await request(host, '/v1/catalogs/products', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      'PayPal-Request-Id': (base + 'p').slice(0, 38)
    }, {
      name: ('ZUNO Creator ' + title.trim()).slice(0, 127),
      description: String(description || ('ZUNO creator subscription tier ' + tierKey)).trim().slice(0, 256),
      type: 'SERVICE',
      category: 'SOFTWARE'
    });
    if (productResult.status < 200 || productResult.status >= 300 || !productResult.body || !productResult.body.id) {
      return { ok: false, status: productResult.status || 502, code: 'PAYPAL_PRODUCT_CREATE_FAILED' };
    }
    const productId = String(productResult.body.id);
    const planResult = await request(host, '/v1/billing/plans', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      'PayPal-Request-Id': (base + 'l').slice(0, 38)
    }, {
      product_id: productId,
      name: ('ZUNO ' + title.trim()).slice(0, 127),
      description: String(description || ('Monthly creator subscription: ' + tierKey)).trim().slice(0, 127),
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: Number(amountUSD).toFixed(2), currency_code: 'USD' } }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3
      }
    });
    if (planResult.status < 200 || planResult.status >= 300 || !planResult.body || !planResult.body.id) {
      return { ok: false, status: planResult.status || 502, code: 'PAYPAL_BILLING_PLAN_CREATE_FAILED', productId };
    }
    return {
      ok: true,
      productId,
      planId: String(planResult.body.id),
      status: planResult.body.status || 'ACTIVE'
    };
  } catch (_) {
    return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' };
  }
}

async function createBillingSubscription(cfg, { planId, customId, returnUrl, cancelUrl, requestId }) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  if (typeof planId !== 'string' || !/^[A-Za-z0-9_-]{3,100}$/.test(planId) || !customId) {
    return { ok: false, status: 400, code: 'PAYPAL_SUBSCRIPTION_INPUT_INVALID' };
  }
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  try {
    const response = await request(host, '/v1/billing/subscriptions', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {})
    }, {
      plan_id: planId,
      custom_id: String(customId).slice(0, 127),
      application_context: {
        brand_name: 'ZUNO',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        ...(returnUrl ? { return_url: returnUrl } : {}),
        ...(cancelUrl ? { cancel_url: cancelUrl } : {})
      }
    });
    if (response.status < 200 || response.status >= 300 || !response.body || !response.body.id) {
      return { ok: false, status: response.status || 502, code: 'PAYPAL_SUBSCRIPTION_CREATE_FAILED' };
    }
    const links = Array.isArray(response.body.links) ? response.body.links : [];
    const approve = links.find(link => link.rel === 'approve');
    return {
      ok: true,
      subscriptionId: String(response.body.id),
      status: response.body.status || 'APPROVAL_PENDING',
      approvalUrl: approve && approve.href || null,
      nextBillingTime: response.body.billing_info && response.body.billing_info.next_billing_time || null
    };
  } catch (_) {
    return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' };
  }
}

async function getBillingSubscription(cfg, providerSubscriptionId) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  if (typeof providerSubscriptionId !== 'string' || !/^[A-Za-z0-9_-]{3,100}$/.test(providerSubscriptionId)) {
    return { ok: false, status: 400, code: 'PAYPAL_SUBSCRIPTION_ID_INVALID' };
  }
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  try {
    const response = await request(host, '/v1/billing/subscriptions/' + encodeURIComponent(providerSubscriptionId), 'GET', {
      Authorization: 'Bearer ' + token.accessToken
    }, null);
    if (response.status < 200 || response.status >= 300 || !response.body || !response.body.id) {
      return { ok: false, status: response.status || 502, code: 'PAYPAL_SUBSCRIPTION_LOOKUP_FAILED' };
    }
    return {
      ok: true,
      subscriptionId: String(response.body.id),
      status: String(response.body.status || ''),
      planId: response.body.plan_id || null,
      nextBillingTime: response.body.billing_info && response.body.billing_info.next_billing_time || null
    };
  } catch (_) {
    return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' };
  }
}

async function cancelBillingSubscription(cfg, providerSubscriptionId, reason = 'Subscriber requested cancellation') {
  if (!cfg || !cfg.clientId || !cfg.clientSecret) return notConfigured();
  if (typeof providerSubscriptionId !== 'string' || !/^[A-Za-z0-9_-]{3,100}$/.test(providerSubscriptionId)) {
    return { ok: false, status: 400, code: 'PAYPAL_SUBSCRIPTION_ID_INVALID' };
  }
  const token = await getAccessToken(cfg);
  if (!token.ok) return token;
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  try {
    const response = await request(host, '/v1/billing/subscriptions/' + encodeURIComponent(providerSubscriptionId) + '/cancel', 'POST', {
      Authorization: 'Bearer ' + token.accessToken
    }, { reason: String(reason || 'Subscriber requested cancellation').slice(0, 128) });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status || 502, code: 'PAYPAL_SUBSCRIPTION_CANCEL_FAILED' };
    }
    return { ok: true, status: response.status, subscriptionId: providerSubscriptionId };
  } catch (_) {
    return { ok: false, status: 503, code: 'PAYPAL_PROVIDER_UNAVAILABLE' };
  }
}


async function createPayout(cfg, { senderBatchId, amountMinor, recipientEmail, requestId }) {
  if (!cfg || !cfg.clientId || !cfg.clientSecret || cfg.payoutsEnabled !== true) {
    return { ok: false, status: 503, code: 'PAYPAL_PAYOUTS_NOT_ENABLED', uncertain: false };
  }
  const amount = Number(amountMinor);
  const email = typeof recipientEmail === 'string' ? recipientEmail.trim() : '';
  if (!/^[A-Za-z0-9._:%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) || email.length > 127 ||
      !Number.isSafeInteger(amount) || amount <= 0 ||
      typeof senderBatchId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(senderBatchId)) {
    return { ok: false, status: 400, code: 'PAYPAL_PAYOUT_INPUT_INVALID', uncertain: false };
  }
  const token = await getAccessToken(cfg);
  if (!token.ok) return { ...token, uncertain: true };
  const host = HOSTS[cfg.env] || HOSTS.sandbox;
  const body = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'Your ZUNO creator payout',
      email_message: 'Your creator earnings payout has been submitted. Provider processing status determines when it is complete.'
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: { value: (amount / 100).toFixed(2), currency: 'USD' },
      receiver: email,
      sender_item_id: senderBatchId,
      note: 'ZUNO creator earnings payout'
    }]
  };
  try {
    const result = await request(host, '/v1/payments/payouts', 'POST', {
      Authorization: 'Bearer ' + token.accessToken,
      ...(requestId ? { 'PayPal-Request-Id': String(requestId).slice(0, 38) } : {})
    }, body);
    const header = result.body && result.body.batch_header || {};
    const batchId = header.payout_batch_id || result.body && result.body.payout_batch_id || null;
    const state = String(header.batch_status || result.body && result.body.batch_status || '').toUpperCase();
    if (result.status >= 200 && result.status < 300 && batchId) {
      return { ok: true, batchId, status: state || 'PENDING', requestId: requestId || null };
    }
    // PayPal prevents duplicate sender_batch_id dispatches for 30 days. If a retry
    // reports a duplicate, recover the original batch id from its HATEOAS URL.
    const detail = result.body && (result.body.details || []);
    const duplicate = Array.isArray(detail) && detail.some(x => /duplicate.*sender_batch_id|sender_batch_id.*duplicate/i.test(String(x.issue || '')+' '+String(x.description || '')));
    const links = Array.isArray(result.body && result.body.links) ? result.body.links : [];
    const originalLink = links.find(x => x && typeof x.href === 'string' && /\/v1\/payments\/payouts\//.test(x.href));
    const linkMatch = originalLink && originalLink.href.match(/\/v1\/payments\/payouts\/([A-Za-z0-9_-]{5,128})(?:\?|$)/);
    if (duplicate && linkMatch) return { ok: true, batchId: linkMatch[1], status: 'PENDING', recoveredDuplicate: true };
    const uncertain = result.status >= 500 || result.status === 408 || result.status === 429 || duplicate;
    return { ok: false, status: result.status || 502, code: uncertain ? 'PAYPAL_PAYOUT_OUTCOME_UNCERTAIN' : 'PAYPAL_PAYOUT_REJECTED', uncertain };
  } catch (_) {
    return { ok: false, status: 503, code: 'PAYPAL_PAYOUT_OUTCOME_UNCERTAIN', uncertain: true };
  }
}

module.exports = { getAccessToken, createOrder, captureOrder, refundCapture, createPayout, verifyWebhook, createSubscriptionPlan, createBillingSubscription, getBillingSubscription, cancelBillingSubscription, notConfigured, HOSTS };
