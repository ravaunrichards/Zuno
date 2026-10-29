'use strict';
const { test, ok, eq } = require('../../tools/test-harness');
const recipient = require('../../backend/payouts/src/recipient');
const eligibility = require('../../backend/payouts/src/eligibility');

test('payout recipient email is encrypted and can be integrity checked', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const saved = recipient.encryptRecipientEmail('Creator@example.com', key);
  ok(saved.ok);
  ok(!saved.ciphertext.includes('creator@example.com'));
  const restored = recipient.decryptRecipientEmail({
    recipient_ciphertext: saved.ciphertext, recipient_nonce: saved.nonce,
    recipient_tag: saved.tag, recipient_hash: saved.hash
  }, key);
  ok(restored.ok);
  eq(restored.email, 'creator@example.com');
  eq(saved.masked, 'c***@example.com');
});
test('payout recipient encryption refuses missing or invalid keys', () => {
  eq(recipient.encryptRecipientEmail('creator@example.com', '').code, 'PAYOUT_ENCRYPTION_KEY_NOT_CONFIGURED');
  eq(recipient.encryptRecipientEmail('not-an-email', Buffer.alloc(32, 7).toString('hex')).code, 'PAYOUT_EMAIL_INVALID');
  eq(recipient.decryptRecipientEmail({ recipient_ciphertext:'AA==',recipient_nonce:'AA==',recipient_tag:'AA==' }, Buffer.alloc(32, 8).toString('base64')).ok, false);
});
test('payout eligibility rejects a missing compliance gate and low balance', () => {
  const value=eligibility.evaluatePayoutEligibility({
    identityVerified:true,providerRecipientReady:true,countryEligible:true,kycAndComplianceClear:false,
    riskHold:false,availableMinor:500,minimumMinor:1000
  });
  ok(!value.eligible);
  ok(value.reasons.includes('PAYOUT_COMPLIANCE_NOT_CLEARED'));
  ok(value.reasons.includes('PAYOUT_BELOW_MINIMUM'));
});
test('payout eligibility accepts only reviewed ready balances', () => {
  const value=eligibility.evaluatePayoutEligibility({
    identityVerified:true,providerRecipientReady:true,countryEligible:true,kycAndComplianceClear:true,
    riskHold:false,availableMinor:1800,minimumMinor:1000
  });
  eq(value.eligible,true);
  eq(value.reasons.length,0);
});
