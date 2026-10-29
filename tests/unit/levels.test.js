'use strict';
const { test, eq, ok, throws } = require('../../tools/test-harness');
const L = require('../../packages/gift-engine/src/levels');

test('exactly 51 entries (Level 0..50)', () => {
  eq(L.THRESHOLDS.length, 51, 'threshold count');
  eq(L.MAX_LEVEL, 50, 'max level');
});

test('level 0 threshold is 0, level 50 is 100,000,000', () => {
  eq(L.THRESHOLDS[0], 0, 'start');
  eq(L.THRESHOLDS[50], 100000000, 'top');
});

test('thresholds strictly monotonic (no gaps/dupes/unreachable)', () => {
  for (let i = 1; i <= 50; i++) ok(L.THRESHOLDS[i] > L.THRESHOLDS[i - 1], `level ${i} increases`);
});

test('levelFor resolves boundaries', () => {
  eq(L.levelFor(0).level, 0, 'zero coins -> level 0');
  eq(L.levelFor(100000000).level, 50, 'top coins -> level 50');
  eq(L.levelFor(99999999).level, 49, 'just below top');
  const info = L.levelFor(L.THRESHOLDS[10]);
  eq(info.level, 10, 'exact threshold lands on level');
});

test('Ultimate Universe milestone is distinct from Level 50', () => {
  eq(L.ULTIMATE_UNIVERSE_MILESTONE, 1000000, 'milestone value');
  ok(L.ULTIMATE_UNIVERSE_MILESTONE !== L.LEVEL_50_THRESHOLD, 'not merged with level 50');
  ok(L.ultimateUniverseReached(1000000), 'reached at exactly 1M');
  ok(!L.ultimateUniverseReached(999999), 'not reached below 1M');
});

test('progress fields are coherent', () => {
  const info = L.levelFor(L.THRESHOLDS[5] + 1);
  eq(info.level, 5, 'level');
  ok(info.progressToNext > 0 && info.progressToNext < 1, 'mid progress');
  ok(info.coinsToNext > 0, 'coins remaining');
});
