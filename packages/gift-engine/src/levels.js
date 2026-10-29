'use strict';
/**
 * ZUNO gifter progression — data-driven, monotonic, server-authoritative.
 *
 * Rules (from the ZUNO brief, Section 7.2 / 7.3):
 *  - Level 0 is the starting level.
 *  - 50 progression levels: Level 0 .. Level 50 (51 entries).
 *  - Level 50 requires 100,000,000 eligible lifetime gifting coins.
 *  - Thresholds strictly increase; no missing levels, no duplicates, none
 *    unreachable.
 *  - Eligible progression is computed from authoritative ledger events only
 *    (refunds/reversals/fraud are excluded before this is called).
 *  - The Ultimate Universe milestone (1,000,000 eligible coins) is a SEPARATE
 *    achievement, not the Level 50 threshold — modelled distinctly below.
 *
 * Threshold curve: level 0 = 0, then a smooth power curve scaled so the final
 * level lands exactly on 100,000,000. Rounded to stable integers; a dedup pass
 * guarantees strict monotonicity even after rounding.
 */

const MAX_LEVEL = 50;
const LEVEL_50_THRESHOLD = 100000000; // 100,000,000 eligible lifetime coins
const ULTIMATE_UNIVERSE_MILESTONE = 1000000; // 1,000,000 eligible coins (distinct)

function buildThresholds() {
  const exp = 2.6; // steepening curve
  const raw = [];
  for (let l = 0; l <= MAX_LEVEL; l++) {
    if (l === 0) { raw.push(0); continue; }
    const frac = Math.pow(l / MAX_LEVEL, exp);
    raw.push(Math.round(frac * LEVEL_50_THRESHOLD));
  }
  raw[MAX_LEVEL] = LEVEL_50_THRESHOLD; // pin exact top
  // Enforce strict monotonicity after rounding.
  for (let l = 1; l <= MAX_LEVEL; l++) {
    if (raw[l] <= raw[l - 1]) raw[l] = raw[l - 1] + 1;
  }
  raw[MAX_LEVEL] = Math.max(raw[MAX_LEVEL], LEVEL_50_THRESHOLD);
  return raw;
}

const THRESHOLDS = Object.freeze(buildThresholds());

function badgeFor(level) {
  if (level >= 45) return 'cosmic';
  if (level >= 35) return 'diamond';
  if (level >= 25) return 'platinum';
  if (level >= 15) return 'gold';
  if (level >= 7) return 'silver';
  if (level >= 1) return 'bronze';
  return 'none';
}

/** Resolve level + progress from eligible lifetime coins. */
function levelFor(eligibleLifetimeCoins) {
  const coins = Math.max(0, Math.floor(eligibleLifetimeCoins || 0));
  let level = 0;
  for (let l = 0; l <= MAX_LEVEL; l++) {
    if (coins >= THRESHOLDS[l]) level = l; else break;
  }
  const current = THRESHOLDS[level];
  const next = level < MAX_LEVEL ? THRESHOLDS[level + 1] : null;
  const progress = next === null ? 1 : (coins - current) / (next - current);
  return {
    level,
    badge: badgeFor(level),
    eligibleLifetimeCoins: coins,
    currentThreshold: current,
    nextThreshold: next,
    coinsToNext: next === null ? 0 : next - coins,
    progressToNext: Math.min(1, Math.max(0, progress)),
  };
}

function thresholdTable() {
  return THRESHOLDS.map((t, level) => ({ level, threshold: t, badge: badgeFor(level) }));
}

/** Ultimate Universe milestone — per-user lifetime achievement, enforced server-side. */
function ultimateUniverseReached(eligibleLifetimeCoins) {
  return Math.floor(eligibleLifetimeCoins || 0) >= ULTIMATE_UNIVERSE_MILESTONE;
}

module.exports = {
  MAX_LEVEL,
  LEVEL_50_THRESHOLD,
  ULTIMATE_UNIVERSE_MILESTONE,
  THRESHOLDS,
  levelFor,
  thresholdTable,
  badgeFor,
  ultimateUniverseReached,
};
