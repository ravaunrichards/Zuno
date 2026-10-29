'use strict';
const ALLOWED_TYPES=new Set(['follow','reaction','comment','message','live_started','gift_received','subscription','system','moderation']);
function validateNotification(input) {
  const errors=[];
  if(!input||typeof input!=='object') return {ok:false,errors:['INVALID_INPUT']};
  if(!ALLOWED_TYPES.has(input.kind)) errors.push('INVALID_NOTIFICATION_KIND');
  if(typeof input.recipientProfileId!=='string'||!input.recipientProfileId) errors.push('INVALID_RECIPIENT');
  const payload=input.payload||{};
  if(JSON.stringify(payload).length>8000) errors.push('PAYLOAD_TOO_LARGE');
  if(Object.keys(payload).some((key)=>/token|secret|password|payment_method|card_number/i.test(key))) errors.push('SENSITIVE_PAYLOAD_FIELD');
  return {ok:errors.length===0,errors};
}
module.exports={validateNotification,ALLOWED_TYPES};
