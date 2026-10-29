'use strict';
/**
 * ZUNO double-entry ledger (authoritative, server-side only).
 *
 * Invariants enforced here (unit-tested in tests/unit/ledger.test.js):
 *  - Every transaction balances: sum(debits) === sum(credits).
 *  - Unit types never silently convert (coins/diamonds/league_points/ad_credits/cash
 *    are separate ledgers; a transaction may only move ONE unit type).
 *  - User accounts may never go negative.
 *  - System accounts (mint/sink) ARE allowed to go negative — they are the
 *    counterparty that creates/destroys supply. Applying the non-negative guard
 *    to system accounts wrongly rejects legitimate mint/sink debits.
 *  - Idempotency: a transaction with an already-seen idempotency key is a no-op
 *    that returns the original result (never double-applies).
 *
 * This is pure, dependency-free JS so the invariants have at least one real,
 * runnable green signal in a sandbox with no database. Production wraps the
 * same logic in a Postgres transaction (see database/functions/).
 */

const UNIT_TYPES = Object.freeze(['coins', 'diamonds', 'league_points', 'ad_credits', 'cash']);
const SYSTEM_ACCOUNT_TYPES = Object.freeze(['mint', 'sink']);

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

class Ledger {
  constructor() {
    /** @type {Map<string, {id:string, kind:string, balances:Object}>} */
    this.accounts = new Map();
    /** @type {Array} */
    this.entries = [];
    /** @type {Map<string, object>} */
    this.idempotency = new Map();
  }

  openAccount(id, kind = 'user') {
    if (this.accounts.has(id)) return this.accounts.get(id);
    if (kind !== 'user' && !SYSTEM_ACCOUNT_TYPES.includes(kind)) {
      throw new LedgerError('BAD_ACCOUNT_KIND', `unknown account kind: ${kind}`);
    }
    const acct = { id, kind, balances: Object.create(null) };
    this.accounts.set(id, acct);
    return acct;
  }

  balance(id, unit) {
    const a = this.accounts.get(id);
    if (!a) throw new LedgerError('NO_ACCOUNT', `no account: ${id}`);
    return a.balances[unit] || 0;
  }

  /**
   * Post a balanced transaction.
   * @param {object} tx
   * @param {string} tx.idempotencyKey required, unique per logical operation
   * @param {string} tx.unit one of UNIT_TYPES
   * @param {string} tx.type free-form transaction type (e.g. 'gift', 'recharge')
   * @param {Array<{account:string, delta:number}>} tx.postings must sum to 0
   */
  post(tx) {
    const { idempotencyKey, unit, type, postings } = tx;
    if (!idempotencyKey) throw new LedgerError('NO_IDEMPOTENCY_KEY', 'idempotencyKey required');
    if (this.idempotency.has(idempotencyKey)) {
      return this.idempotency.get(idempotencyKey); // replay-safe no-op
    }
    if (!UNIT_TYPES.includes(unit)) throw new LedgerError('BAD_UNIT', `bad unit: ${unit}`);
    if (!Array.isArray(postings) || postings.length < 2) {
      throw new LedgerError('BAD_POSTINGS', 'need >= 2 postings');
    }
    let sum = 0;
    for (const p of postings) {
      if (!Number.isInteger(p.delta)) throw new LedgerError('NON_INTEGER', 'deltas must be integers');
      sum += p.delta;
    }
    if (sum !== 0) throw new LedgerError('UNBALANCED', `postings sum to ${sum}, expected 0`);

    // Validate resulting balances before committing anything.
    const staged = [];
    for (const p of postings) {
      const a = this.accounts.get(p.account);
      if (!a) throw new LedgerError('NO_ACCOUNT', `no account: ${p.account}`);
      const next = (a.balances[unit] || 0) + p.delta;
      if (a.kind === 'user' && next < 0) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `account ${a.id} would go negative in ${unit}`);
      }
      staged.push([a, next]);
    }
    for (const [a, next] of staged) a.balances[unit] = next;

    const record = {
      id: `txn_${this.entries.length + 1}`,
      idempotencyKey,
      unit,
      type: type || 'generic',
      postings: postings.map((p) => ({ ...p })),
      createdAt: new Date().toISOString(),
    };
    this.entries.push(record);
    this.idempotency.set(idempotencyKey, record);
    return record;
  }

  /** Global invariant: total of all balances per unit must be 0 (closed system). */
  isBalanced() {
    const totals = Object.create(null);
    for (const a of this.accounts.values()) {
      for (const u of Object.keys(a.balances)) totals[u] = (totals[u] || 0) + a.balances[u];
    }
    return Object.values(totals).every((v) => v === 0);
  }
}

module.exports = { Ledger, LedgerError, UNIT_TYPES, SYSTEM_ACCOUNT_TYPES };
