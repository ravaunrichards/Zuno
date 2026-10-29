'use strict';
/**
 * Z Coins: recharge packages + server-authoritative coin crediting.
 *
 * Cash (a real PayPal payment) and coins (virtual currency) are SEPARATE. A
 * captured payment is reconciled with EXACTLY ONE coin-credit operation, keyed
 * by the provider capture id so duplicate webhooks never double-credit.
 * Coins are minted from a system 'mint' account (allowed to go negative) into
 * the user account.
 */

// Server-authoritative packages (>=7 required). Client never sends price.
const RECHARGE_PACKAGES = Object.freeze([
  { id: 'z_coins_60',     coins: 60,     priceUSD: 0.99 },
  { id: 'z_coins_300',    coins: 300,    priceUSD: 4.99 },
  { id: 'z_coins_980',    coins: 980,    priceUSD: 14.99 },
  { id: 'z_coins_1980',   coins: 1980,   priceUSD: 29.99 },
  { id: 'z_coins_3280',   coins: 3280,   priceUSD: 49.99 },
  { id: 'z_coins_6600',   coins: 6600,   priceUSD: 99.99 },
  { id: 'z_coins_16500',  coins: 16500,  priceUSD: 249.99 },
  { id: 'z_coins_33000',  coins: 33000,  priceUSD: 499.99 },
]);

const MIN_CUSTOM_USD = 0.99;
const MAX_CUSTOM_USD = 999.99;
const CUSTOM_COINS_PER_USD = 60; // same base rate as the smallest package

function getPackage(id) {
  return RECHARGE_PACKAGES.find((p) => p.id === id) || null;
}

function customQuote(usd) {
  if (typeof usd !== 'number' || usd < MIN_CUSTOM_USD || usd > MAX_CUSTOM_USD) return null;
  return { coins: Math.floor(usd * CUSTOM_COINS_PER_USD), priceUSD: Math.round(usd * 100) / 100 };
}

/**
 * Credit coins for a CAPTURED payment. Idempotent on captureId.
 * @param {object} deps { ledger, mintAccountId }
 * @param {object} ev  { userId, coins, captureId, status }
 */
function creditCoinsFromCapture(deps, ev) {
  const { ledger, mintAccountId } = deps;
  if (ev.status !== 'captured') return { ok: false, code: 'NOT_CAPTURED' };
  if (!ev.userId || !ev.captureId || !Number.isInteger(ev.coins) || ev.coins <= 0) {
    return { ok: false, code: 'BAD_CREDIT' };
  }
  const record = ledger.post({
    idempotencyKey: `coin_credit:${ev.captureId}`, // one credit per capture
    unit: 'coins',
    type: 'recharge',
    postings: [
      { account: mintAccountId, delta: -ev.coins },
      { account: ev.userId, delta: ev.coins },
    ],
  });
  return { ok: true, transactionId: record.id, coins: ev.coins };
}

module.exports = {
  RECHARGE_PACKAGES, MIN_CUSTOM_USD, MAX_CUSTOM_USD, CUSTOM_COINS_PER_USD,
  getPackage, customQuote, creditCoinsFromCapture,
};
