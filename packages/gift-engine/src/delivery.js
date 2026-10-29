'use strict';
/**
 * Server-authoritative gift delivery.
 *
 * The browser NEVER decides the gift price or the wallet balance. This module
 * is the single source of truth the API layer calls. It:
 *   1. looks up the authoritative gift price from the catalog,
 *   2. validates sender/recipient and eligibility (unlock rule vs level),
 *   3. posts an atomic, idempotent ledger transaction (sender -> recipient),
 *   4. returns a genuine result the realtime layer broadcasts to the room.
 *
 * Coins move sender -> recipient on the 'coins' ledger. Creator earnings
 * (diamonds/cash) are a SEPARATE accounting step (see packages/payments),
 * never a silent conversion here.
 */
const { getGift } = require('./catalog');
const { levelFor } = require('./levels');

function eligibleForGift(gift, senderLevelInfo) {
  switch (gift.unlockRule) {
    case 'none': return true;
    case 'level>=5': return senderLevelInfo.level >= 5;
    case 'level>=15': return senderLevelInfo.level >= 15;
    default: return true;
  }
}

/**
 * @param {object} deps { ledger }
 * @param {object} req { senderId, recipientId, giftId, idempotencyKey, senderLifetimeCoins }
 */
function sendGift(deps, req) {
  const { ledger } = deps;
  const { senderId, recipientId, giftId, idempotencyKey, senderLifetimeCoins } = req;
  if (!senderId || !recipientId || !giftId || !idempotencyKey) {
    return { ok: false, code: 'BAD_REQUEST' };
  }
  if (senderId === recipientId) return { ok: false, code: 'SELF_GIFT_FORBIDDEN' };
  const gift = getGift(giftId);
  if (!gift) return { ok: false, code: 'UNKNOWN_GIFT' };
  const senderLevel = levelFor(senderLifetimeCoins || 0);
  if (!eligibleForGift(gift, senderLevel)) {
    return { ok: false, code: 'GIFT_LOCKED', requiredRule: gift.unlockRule };
  }
  try {
    const record = ledger.post({
      idempotencyKey,
      unit: 'coins',
      type: 'gift',
      postings: [
        { account: senderId, delta: -gift.priceCoins },
        { account: recipientId, delta: gift.priceCoins },
      ],
    });
    return {
      ok: true,
      transactionId: record.id,
      giftId: gift.id,
      priceCoins: gift.priceCoins, // authoritative, server-sourced
      fx: gift.fx,
      modelPath: gift.modelPath,
      audioPath: gift.audioPath,
      recipientId,
    };
  } catch (e) {
    if (e.code === 'INSUFFICIENT_FUNDS') return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    return { ok: false, code: e.code || 'LEDGER_ERROR', message: e.message };
  }
}

module.exports = { sendGift, eligibleForGift };
