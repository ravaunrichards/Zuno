'use strict';
const REASONS = new Set(['spam','harassment','hate','violence','sexual_content','self_harm','child_safety','impersonation','copyright','scam','privacy','other']);
const STATES = {open:['reviewing','dismissed'],reviewing:['actioned','dismissed','appealed'],actioned:['appealed'],dismissed:[],appealed:['reviewing','actioned','dismissed']};
function validateReport(input) {
  const errors=[];
  if(!input||typeof input!=='object') return {ok:false,errors:['INVALID_REPORT']};
  if(!REASONS.has(input.reasonCode)) errors.push('INVALID_REASON');
  if(!['post','comment','profile','message','live_room','community','listing','ad'].includes(input.targetType)) errors.push('INVALID_TARGET_TYPE');
  if(!String(input.targetId||'').trim()||String(input.targetId).length>200) errors.push('INVALID_TARGET_ID');
  if(String(input.details||'').length>4000) errors.push('DETAILS_TOO_LONG');
  return {ok:errors.length===0,errors};
}
function canTransitionReport(from,to,actorRole) {
  if(!STATES[from]||!STATES[from].includes(to)) return false;
  if(['reviewing','actioned','dismissed'].includes(to)&&!['moderator','admin','support'].includes(actorRole)) return false;
  if(to==='appealed'&&!['user','moderator','admin'].includes(actorRole)) return false;
  return true;
}
module.exports={REASONS,STATES,validateReport,canTransitionReport};
