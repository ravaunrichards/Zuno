'use strict';
const { test, eq, ok } = require('../../tools/test-harness');
const R = require('../../packages/gift-engine/src/rankings');

test('monthly period start is deterministic in America/Jamaica', () => {
  const now = new Date('2026-03-15T08:00:00Z');
  const start = R.monthlyPeriodStart(now);
  // Jamaica is UTC-5, so month start 2026-03-01 00:00 Jamaica == 05:00 UTC
  eq(start.toISOString(), '2026-03-01T05:00:00.000Z', 'month boundary');
});

test('leaderboard sums only eligible events and ranks desc', () => {
  const events = [
    { actorId: 'a', coins: 100, at: '2026-03-02T00:00:00Z', eligible: true },
    { actorId: 'b', coins: 300, at: '2026-03-03T00:00:00Z', eligible: true },
    { actorId: 'a', coins: 50, at: '2026-03-04T00:00:00Z', eligible: true },
    { actorId: 'b', coins: 999, at: '2026-03-05T00:00:00Z', eligible: false }, // refunded
  ];
  const lb = R.leaderboard(events);
  eq(lb[0], { rank: 1, actorId: 'b', coins: 300 }, 'top');
  eq(lb[1], { rank: 2, actorId: 'a', coins: 150 }, 'second');
});

test('period reset does not mutate the source ledger events', () => {
  const events = [{ actorId: 'a', coins: 10, at: '2026-01-01T00:00:00Z', eligible: true }];
  R.leaderboard(events, { since: new Date('2026-03-01T05:00:00Z') });
  eq(events.length, 1, 'events untouched by windowing');
});
