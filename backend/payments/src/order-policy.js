'use strict';
const ALLOWED={created:['approved','failed','cancelled'],approved:['captured','failed','cancelled'],captured:['credited','refunded','partially_refunded'],credited:['refunded','partially_refunded'],failed:[],cancelled:[],refunded:[],partially_refunded:['refunded']};
function canTransition(from,to){return Boolean(ALLOWED[from]&&ALLOWED[from].includes(to));}
function validateOrderRequest(input) {
  const errors=[];
  if(!input||typeof input!=='object') return {ok:false,errors:['INVALID_REQUEST']};
  if(typeof input.profileId!=='string'||!input.profileId) errors.push('PROFILE_REQUIRED');
  const packageMode=typeof input.packageId==='string'&&input.packageId.length>0;
  const customMode=Number.isSafeInteger(input.customCoins)&&input.customCoins>0;
  if(packageMode===customMode) errors.push('CHOOSE_ONE_RECHARGE_MODE');
  const key=String(input.idempotencyKey||'');
  if(key.length<16||key.length>180) errors.push('INVALID_IDEMPOTENCY_KEY');
  return {ok:errors.length===0,errors};
}
module.exports={ALLOWED,canTransition,validateOrderRequest};
