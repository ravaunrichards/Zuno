'use strict';
function evaluatePayoutEligibility(input) {
  const reasons=[];
  if(!input||input.identityVerified!==true) reasons.push('IDENTITY_NOT_VERIFIED');
  if(!input||input.providerRecipientReady!==true) reasons.push('PAYOUT_RECIPIENT_NOT_READY');
  if(!input||input.countryEligible!==true) reasons.push('COUNTRY_OR_PROVIDER_ELIGIBILITY_UNKNOWN');
  if(!input||input.kycAndComplianceClear!==true) reasons.push('COMPLIANCE_CHECK_REQUIRED');
  if(input&&input.riskHold===true) reasons.push('RISK_HOLD');
  if(!input||!Number.isSafeInteger(input.availableMinor)||input.availableMinor<=0) reasons.push('NO_AVAILABLE_EARNINGS');
  if(!input||!Number.isSafeInteger(input.minimumMinor)||input.minimumMinor<=0) reasons.push('MINIMUM_PAYOUT_NOT_CONFIGURED');
  if(input&&Number.isSafeInteger(input.availableMinor)&&Number.isSafeInteger(input.minimumMinor)&&input.availableMinor<input.minimumMinor) reasons.push('BELOW_MINIMUM_PAYOUT');
  return {eligible:reasons.length===0,reasons};
}
module.exports={evaluatePayoutEligibility};
