'use strict';
function evaluatePayoutEligibility(input) {
  const reasons=[];
  if(!input||input.identityVerified!==true) reasons.push('PAYOUT_IDENTITY_NOT_VERIFIED');
  if(!input||input.providerRecipientReady!==true) reasons.push('PAYOUT_RECIPIENT_NOT_READY');
  if(!input||input.countryEligible!==true) reasons.push(input&&input.countryEligible===false?'PAYOUT_COUNTRY_NOT_ELIGIBLE':'PAYOUT_COUNTRY_ELIGIBILITY_PENDING');
  if(!input||input.kycAndComplianceClear!==true) reasons.push('PAYOUT_COMPLIANCE_NOT_CLEARED');
  if(input&&input.riskHold===true) reasons.push('PAYOUT_RISK_HOLD');
  if(!input||!Number.isSafeInteger(input.availableMinor)||input.availableMinor<=0) reasons.push('NO_AVAILABLE_EARNINGS');
  if(!input||!Number.isSafeInteger(input.minimumMinor)||input.minimumMinor<=0) reasons.push('PAYOUT_MINIMUM_NOT_CONFIGURED');
  if(input&&Number.isSafeInteger(input.availableMinor)&&Number.isSafeInteger(input.minimumMinor)&&input.availableMinor<input.minimumMinor) reasons.push('PAYOUT_BELOW_MINIMUM');
  return {eligible:reasons.length===0,reasons};
}
module.exports={evaluatePayoutEligibility};
