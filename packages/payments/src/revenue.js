'use strict';
/**
 * Creator revenue split — versioned configuration so approved future policy
 * changes never rewrite historical settlements. Initial policy: 50% platform /
 * 50% creator on eligible creator revenue.
 *
 * Gross -> provider fees -> eligible revenue -> platform share + creator share.
 * All amounts are integer minor units (e.g. USD cents) to avoid float drift.
 */
const SPLIT_POLICIES = Object.freeze({
  'v1-2026': { platformBps: 5000, creatorBps: 5000 }, // 50/50 in basis points
});
const ACTIVE_POLICY = 'v1-2026';

function splitRevenue(grossMinor, providerFeeMinor, policyId = ACTIVE_POLICY) {
  const policy = SPLIT_POLICIES[policyId];
  if (!policy) throw new Error(`unknown split policy: ${policyId}`);
  if (!Number.isInteger(grossMinor) || !Number.isInteger(providerFeeMinor)) {
    throw new Error('amounts must be integer minor units');
  }
  const eligible = Math.max(0, grossMinor - providerFeeMinor);
  const creatorShare = Math.floor((eligible * policy.creatorBps) / 10000);
  const platformShare = eligible - creatorShare; // platform absorbs rounding remainder
  return { policyId, grossMinor, providerFeeMinor, eligibleMinor: eligible, creatorShare, platformShare };
}

module.exports = { SPLIT_POLICIES, ACTIVE_POLICY, splitRevenue };
