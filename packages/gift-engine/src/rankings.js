'use strict';
/**
 * Ranking aggregation + deterministic period boundaries.
 *
 * Reference zone for monthly reset is America/Jamaica (UTC-05:00, no DST).
 * A ranking-period reset NEVER erases the transaction ledger — it only scopes
 * which eligible events are summed for the leaderboard window.
 */
const JAMAICA_OFFSET_MIN = -5 * 60; // America/Jamaica has no DST

function toJamaica(date) {
  return new Date(date.getTime() + JAMAICA_OFFSET_MIN * 60000);
}

/** First instant of the current monthly window, as a UTC Date. */
function monthlyPeriodStart(nowUtc) {
  const j = toJamaica(nowUtc);
  const startJ = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), 1, 0, 0, 0, 0);
  return new Date(startJ - JAMAICA_OFFSET_MIN * 60000);
}

function weeklyPeriodStart(nowUtc) {
  const j = toJamaica(nowUtc);
  const dow = j.getUTCDay(); // 0 = Sunday
  const startJ = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - dow, 0, 0, 0, 0);
  return new Date(startJ - JAMAICA_OFFSET_MIN * 60000);
}

/**
 * Aggregate eligible gifting events into a leaderboard.
 * @param {Array<{actorId:string, coins:number, at:string, eligible:boolean}>} events
 * @param {object} opts { since?: Date, scopeKey?: fn }
 */
function leaderboard(events, opts = {}) {
  const since = opts.since ? opts.since.getTime() : 0;
  const totals = new Map();
  for (const e of events) {
    if (!e.eligible) continue; // refunds/reversals/fraud excluded upstream
    if (new Date(e.at).getTime() < since) continue;
    totals.set(e.actorId, (totals.get(e.actorId) || 0) + e.coins);
  }
  return [...totals.entries()]
    .map(([actorId, coins]) => ({ actorId, coins }))
    .sort((a, b) => b.coins - a.coins || a.actorId.localeCompare(b.actorId))
    .map((row, i) => ({ rank: i + 1, ...row }));
}

module.exports = { JAMAICA_OFFSET_MIN, toJamaica, monthlyPeriodStart, weeklyPeriodStart, leaderboard };
