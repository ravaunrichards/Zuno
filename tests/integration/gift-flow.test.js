'use strict';
const { test, eq, ok } = require('../../tools/test-harness');
const { Ledger } = require('../../packages/shared/src/ledger');
const { sendGift } = require('../../packages/gift-engine/src/delivery');
const { loadGifts } = require('../../packages/gift-engine/src/catalog');

function cheapGift() { return loadGifts().filter((g) => g.unlockRule === 'none').sort((a,b)=>a.priceCoins-b.priceCoins)[0]; }

test('end-to-end gift: server price, atomic debit/credit, recipient event', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('sender'); L.openAccount('host');
  L.post({ idempotencyKey: 'seed', unit: 'coins',
    postings: [{ account: 'mint', delta: -100000 }, { account: 'sender', delta: 100000 }] });
  const g = cheapGift();
  const r = sendGift({ ledger: L }, {
    senderId: 'sender', recipientId: 'host', giftId: g.id,
    idempotencyKey: 'gift-1', senderLifetimeCoins: 0,
  });
  ok(r.ok, 'gift sent');
  eq(r.priceCoins, g.priceCoins, 'price is server-sourced, not client-sent');
  eq(L.balance('host', 'coins'), g.priceCoins, 'recipient credited');
  eq(L.balance('sender', 'coins'), 100000 - g.priceCoins, 'sender debited');
});

test('duplicate gift idempotency key does not double-charge', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('s'); L.openAccount('h');
  L.post({ idempotencyKey: 'seed', unit: 'coins',
    postings: [{ account: 'mint', delta: -100000 }, { account: 's', delta: 100000 }] });
  const g = cheapGift();
  const a = sendGift({ ledger: L }, { senderId: 's', recipientId: 'h', giftId: g.id, idempotencyKey: 'dup', senderLifetimeCoins: 0 });
  const b = sendGift({ ledger: L }, { senderId: 's', recipientId: 'h', giftId: g.id, idempotencyKey: 'dup', senderLifetimeCoins: 0 });
  eq(a.transactionId, b.transactionId, 'same txn');
  eq(L.balance('s', 'coins'), 100000 - g.priceCoins, 'charged once');
});

test('insufficient balance blocks gift (no silent overdraft)', () => {
  const L = new Ledger();
  L.openAccount('s'); L.openAccount('h');
  const g = cheapGift();
  const r = sendGift({ ledger: L }, { senderId: 's', recipientId: 'h', giftId: g.id, idempotencyKey: 'x', senderLifetimeCoins: 0 });
  eq(r.ok, false, 'blocked');
  eq(r.code, 'INSUFFICIENT_FUNDS', 'reason');
});

test('locked premium gift rejected for low-level sender', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('s'); L.openAccount('h');
  L.post({ idempotencyKey: 'seed', unit: 'coins', postings: [{account:'mint',delta:-10000000},{account:'s',delta:10000000}] });
  const locked = loadGifts().find((g) => g.unlockRule === 'level>=15');
  const r = sendGift({ ledger: L }, { senderId: 's', recipientId: 'h', giftId: locked.id, idempotencyKey: 'l', senderLifetimeCoins: 0 });
  eq(r.ok, false, 'blocked'); eq(r.code, 'GIFT_LOCKED', 'reason');
});

test('self-gift forbidden', () => {
  const L = new Ledger(); L.openAccount('s');
  const g = cheapGift();
  const r = sendGift({ ledger: L }, { senderId: 's', recipientId: 's', giftId: g.id, idempotencyKey: 'z', senderLifetimeCoins: 0 });
  eq(r.code, 'SELF_GIFT_FORBIDDEN', 'blocked');
});
