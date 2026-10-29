'use strict';
const { test, eq, ok, throws } = require('../../tools/test-harness');
const { Ledger } = require('../../packages/shared/src/ledger');

test('balanced transaction debits and credits', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint');
  L.openAccount('alice');
  L.post({ idempotencyKey: 'k1', unit: 'coins', type: 'recharge',
    postings: [{ account: 'mint', delta: -100 }, { account: 'alice', delta: 100 }] });
  eq(L.balance('alice', 'coins'), 100, 'alice balance');
  eq(L.balance('mint', 'coins'), -100, 'mint may go negative');
  ok(L.isBalanced(), 'closed system balances to zero');
});

test('user account cannot go negative', () => {
  const L = new Ledger();
  L.openAccount('alice'); L.openAccount('bob');
  throws(() => L.post({ idempotencyKey: 'k', unit: 'coins',
    postings: [{ account: 'alice', delta: -50 }, { account: 'bob', delta: 50 }] }),
    'INSUFFICIENT_FUNDS', 'overdraft blocked');
});

test('system mint/sink accounts ARE allowed to go negative', () => {
  const L = new Ledger();
  L.openAccount('sink', 'sink'); L.openAccount('alice');
  L.post({ idempotencyKey: 'k', unit: 'coins',
    postings: [{ account: 'sink', delta: -1000000 }, { account: 'alice', delta: 1000000 }] });
  eq(L.balance('sink', 'coins'), -1000000, 'sink negative allowed');
});

test('unbalanced postings are rejected', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('alice');
  throws(() => L.post({ idempotencyKey: 'k', unit: 'coins',
    postings: [{ account: 'mint', delta: -100 }, { account: 'alice', delta: 99 }] }),
    'UNBALANCED', 'must balance');
});

test('idempotency key prevents double-apply', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('alice');
  const a = L.post({ idempotencyKey: 'dup', unit: 'coins',
    postings: [{ account: 'mint', delta: -100 }, { account: 'alice', delta: 100 }] });
  const b = L.post({ idempotencyKey: 'dup', unit: 'coins',
    postings: [{ account: 'mint', delta: -100 }, { account: 'alice', delta: 100 }] });
  eq(a.id, b.id, 'replay returns original record');
  eq(L.balance('alice', 'coins'), 100, 'balance credited once');
});

test('unit types never silently convert', () => {
  const L = new Ledger();
  L.openAccount('mint', 'mint'); L.openAccount('alice');
  L.post({ idempotencyKey: 'c', unit: 'coins',
    postings: [{ account: 'mint', delta: -100 }, { account: 'alice', delta: 100 }] });
  L.post({ idempotencyKey: 'd', unit: 'diamonds',
    postings: [{ account: 'mint', delta: -5 }, { account: 'alice', delta: 5 }] });
  eq(L.balance('alice', 'coins'), 100, 'coins untouched');
  eq(L.balance('alice', 'diamonds'), 5, 'diamonds separate');
});
