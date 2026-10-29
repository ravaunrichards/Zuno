'use strict';
/** Canonical API contracts shared by server and clients. Single source of truth
 *  for endpoint shapes; keep server responses consistent with these. */
const endpoints = {
  'GET /health': { response: { status: 'string', configured: 'object', ts: 'string' } },
  'POST /api/livekit/token': {
    request: { identity: 'string', room: 'string', canPublish: 'boolean?', ttlSeconds: 'number?' },
    response: { ok: 'boolean', token: 'string?', expiresAt: 'number?', url: 'string?', code: 'string?' },
  },
  'POST /api/gifts/send': {
    request: { senderId: 'string', recipientId: 'string', giftId: 'string', idempotencyKey: 'string', senderLifetimeCoins: 'number?' },
    response: { ok: 'boolean', transactionId: 'string?', giftId: 'string?', priceCoins: 'number?', fx: 'string?', code: 'string?' },
  },
  'POST /api/payments/order': {
    request: { packageId: 'string' },
    response: { ok: 'boolean', orderId: 'string?', status: 'string?', code: 'string?' },
  },
};
const errorCodes = [
  'NOT_FOUND', 'BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNKNOWN_GIFT', 'GIFT_LOCKED',
  'INSUFFICIENT_FUNDS', 'SELF_GIFT_FORBIDDEN', 'UNKNOWN_PACKAGE',
  'LIVE_NOT_CONFIGURED', 'PAYMENTS_NOT_CONFIGURED', 'DB_NOT_CONFIGURED',
];
module.exports = { endpoints, errorCodes };
