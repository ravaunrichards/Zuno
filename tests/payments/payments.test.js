'use strict';
const { test, eq, ok, throws } = require('../../tools/test-harness');
const { Ledger } = require('../../packages/shared/src/ledger');
const coins = require('../../packages/payments/src/coins');
const sm = require('../../packages/payments/src/state-machine');
const rev = require('../../packages/payments/src/revenue');

test('>= 7 recharge packages defined', () => {
  ok(coins.RECHARGE_PACKAGES.length >= 7, 'package count');
});

test('custom quote respects min/max bounds', () => {
  ok(coins.customQuote(0.5) === null, 'below min rejected');
  ok(coins.customQuote(5000) === null, 'above max rejected');
  const q = coins.customQuote(10);
  eq(q.coins, 600, 'coins from usd');
});

test('coins credited only once per capture (idempotent)', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('user1');
  const deps = { ledger: L, mintAccountId: 'mint' };
  const ev = { userId: 'user1', coins: 980, captureId: 'CAP-123', status: 'captured' };
  coins.creditCoinsFromCapture(deps, ev);
  coins.creditCoinsFromCapture(deps, ev); // duplicate webhook
  eq(L.balance('user1', 'coins'), 980, 'credited exactly once');
});

test('uncaptured payment never credits coins', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('user1');
  const r = coins.creditCoinsFromCapture({ ledger: L, mintAccountId: 'mint' },
    { userId: 'user1', coins: 100, captureId: 'X', status: 'approved' });
  eq(r.ok, false, 'rejected');
  eq(L.balance('user1', 'coins'), 0, 'no credit');
});

test('payment state machine enforces legal transitions', () => {
  eq(sm.transition('created', 'pending_approval'), 'pending_approval');
  eq(sm.transition('approved', 'captured'), 'captured');
  throws(() => sm.transition('created', 'captured'), 'ILLEGAL_TRANSITION', 'no skip to captured');
  throws(() => sm.transition('captured', 'approved'), 'ILLEGAL_TRANSITION', 'no reverse');
  ok(sm.isTerminal('refunded'), 'refunded terminal');
});

test('revenue split is 50/50 and conserves money', () => {
  const s = rev.splitRevenue(10000, 350); // $100 gross, $3.50 fee
  eq(s.eligibleMinor, 9650, 'eligible after fee');
  eq(s.creatorShare + s.platformShare, s.eligibleMinor, 'no money lost');
  eq(s.creatorShare, 4825, 'creator half');
});
