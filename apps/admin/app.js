import { mountProductLinks } from '../web/src/components/product-links.js';
import { requestJson } from '../web/src/services/api-client.js';
import { getSession } from '../web/src/features/auth/session.js';
import { mountAuth } from '../web/src/features/auth/auth-ui.js';

mountProductLinks();
const healthButton=document.getElementById('check-health');
const healthOutput=document.getElementById('health-output');
const moderationList=document.getElementById('moderation-list');
const auditList=document.getElementById('audit-list');
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el;}
function number(value){return new Intl.NumberFormat().format(Number(value)||0);}
function setText(id,value){const el=document.getElementById(id);if(el)el.textContent=String(value);}
function setOverviewStatus(message,isError=false){const el=document.getElementById('overview-status');if(el){el.textContent=message;el.classList.toggle('is-error',isError);}}
function setHealthStatus(message,isError=false){if(healthOutput){healthOutput.textContent=message;healthOutput.classList.toggle('is-error',isError);}}
function placeholder(target,message){if(target)target.replaceChildren(node('p','admin-inline-message',message));}
async function loadOverview(){
 if(!getSession()){setOverviewStatus('Sign in with an authorized account to load operations overview.');return;}
 try{const result=await requestJson('/api/admin/overview');const stats=result.overview||{};
  setText('metric-profiles',number(stats.profiles));setText('metric-posts',number(stats.posts));setText('metric-live',number(stats.liveRooms));setText('metric-reports',number(stats.openReports));setText('metric-payment-events',number(stats.failedPaymentEvents));setText('metric-money',number(stats.pendingRefunds)+' refunds · '+number(stats.pendingPayouts)+' payouts');setOverviewStatus('Updated from the protected operations API.');
 }catch(error){setOverviewStatus(error.status===403?'This account does not have an allowed operations role.':(error.message||'Operations overview unavailable.'),true);}
}
function reportCard(report){
 const card=node('article','admin-report-card');const heading=node('div','admin-report-heading');heading.append(node('strong','',report.targetType+' · '+report.state),node('time','',new Date(report.createdAt).toLocaleString()));card.append(heading,node('p','',report.reason||'No report explanation provided.'),node('code','',report.targetId),node('p','admin-report-meta','Report '+report.id+' · Reporter '+report.reporterId));
 if(['open','reviewing','appealed'].includes(report.state)){
  const form=node('form','admin-report-actions');const decision=node('select','');decision.setAttribute('aria-label','Moderation decision');
  for(const [value,label] of [['mark_reviewing','Mark reviewing'],['dismiss','Dismiss report'],['remove_content','Remove content']]){const option=node('option','',label);option.value=value;decision.append(option);}
  const reason=node('input','');reason.placeholder='Required reason code';reason.required=true;reason.pattern='[A-Za-z0-9_.:-]{2,80}';reason.maxLength=80;reason.setAttribute('aria-label','Reason code');
  const note=node('input','');note.placeholder='Optional note';note.maxLength=500;note.setAttribute('aria-label','Moderator note');const submit=node('button','admin-primary','Record decision');submit.type='submit';form.append(decision,reason,note,submit);
  form.addEventListener('submit',async(event)=>{event.preventDefault();submit.disabled=true;try{const result=await requestJson('/api/admin/reports/'+encodeURIComponent(report.id)+'/resolve',{method:'POST',body:{decision:decision.value,reasonCode:reason.value.trim(),note:note.value.trim()||null}});card.append(node('p','admin-success','Decision recorded: '+result.report.state+'. Audit action '+result.moderationActionId+'.'));await Promise.all([loadReports(),loadOverview()]);}catch(error){card.append(node('p','admin-error',error.message||'Moderation action failed.'));}finally{submit.disabled=false;}});
  card.append(form);
 }return card;
}
async function loadReports(){
 if(!moderationList)return;if(!getSession()){placeholder(moderationList,'Sign in with a moderator or administrator account.');return;}placeholder(moderationList,'Loading database moderation queue…');
 try{const state=document.getElementById('report-state-filter')?.value||'open';const result=await requestJson('/api/admin/reports?state='+encodeURIComponent(state)+'&limit=100');moderationList.replaceChildren();if(!result.reports?.length){placeholder(moderationList,'No reports in this state. The database returned an empty queue.');return;}result.reports.forEach(report=>moderationList.append(reportCard(report)));}
 catch(error){placeholder(moderationList,error.status===403?'This account lacks moderator or administrator role.':(error.message||'Moderation queue unavailable.'));}
}
async function loadAudit(){
 if(!auditList)return;if(!getSession()){placeholder(auditList,'Sign in as an administrator to load audit events.');return;}placeholder(auditList,'Loading append-only audit records…');
 try{const result=await requestJson('/api/admin/audit?limit=100');auditList.replaceChildren();if(!result.events?.length){placeholder(auditList,'No audit records were returned.');return;}result.events.forEach(event=>{const card=node('article','admin-audit-row');card.append(node('strong','',event.action),node('time','',new Date(event.createdAt).toLocaleString()),node('code','',event.id),node('pre','',JSON.stringify(event.detail||{},null,2)));auditList.append(card);});}
 catch(error){placeholder(auditList,error.status===403?'Audit access is limited to administrators.':(error.message||'Audit records unavailable.'));}
}
async function loadIntegrations(){
 if(healthButton){healthButton.disabled=true;healthButton.textContent='Checking…';}
 try{if(!getSession()){setHealthStatus('Sign in with an authorized operator account.');return;}const result=await requestJson('/api/admin/integrations');const items=result.integrations||{};setHealthStatus(Object.entries(items).map(([name,value])=>name+': '+(value.status||'unknown')+(value.environment?' ('+value.environment+')':'')).join(' · '));setText('integration-state','Provider configuration flags only. Credentials are never returned.');}
 catch(error){setHealthStatus(error.status===403?'This account is not authorized to inspect integrations.':(error.message||'Integration readiness unavailable.'),true);}
 finally{if(healthButton){healthButton.disabled=false;healthButton.textContent='Refresh status';}}
}

const payoutProfilesList=document.getElementById('payout-profiles-list');
function payoutProfileCard(profile){
 const card=node('article','admin-payout-card');
 const heading=node('div','admin-report-heading');
 heading.append(node('strong','',profile.recipientMasked+' · '+profile.countryCode),
   node('time','',profile.reviewedAt?'Reviewed '+new Date(profile.reviewedAt).toLocaleString():'Awaiting review'));
 card.append(heading,node('code','',profile.creatorId));
 card.append(node('p','admin-payout-meta','Country: '+profile.countryEligibility+' · Identity: '+(profile.identityVerified?'verified':'not verified')+
  ' · Compliance: '+profile.complianceState+' · Recipient: '+(profile.providerRecipientReady?'ready':'not ready')+
  ' · Risk hold: '+(profile.riskHold?'active':'clear')));
 const form=node('form','admin-payout-review-form');
 function addCheck(name,labelText,checked){
  const label=node('label','admin-payout-check');
  const input=node('input','');input.type='checkbox';input.name=name;input.checked=Boolean(checked);
  const textNode=node('span','',labelText);
  label.append(input,textNode);form.append(label);
 }
 addCheck('identityVerified','Identity verified',profile.identityVerified);
 addCheck('countryEligible','Country/provider eligibility confirmed',profile.countryEligibility==='eligible');
 addCheck('complianceClear','Compliance checks cleared',profile.complianceState==='cleared');
 addCheck('providerRecipientReady','PayPal recipient ready',profile.providerRecipientReady);
 addCheck('riskHold','Risk hold',profile.riskHold);
 const note=node('input','admin-payout-review-note');note.type='text';note.name='reviewNote';note.maxLength=500;note.placeholder='Review reason / audit note';note.value=profile.reviewNote||'';note.setAttribute('aria-label','Review reason or audit note');
 const submit=node('button','admin-primary','Save review');submit.type='submit';form.append(note,submit);
 form.addEventListener('submit',async event=>{
  event.preventDefault();submit.disabled=true;
  const value=name=>Boolean(form.elements.namedItem(name)?.checked);
  try{
   await requestJson('/api/admin/payout-profiles/'+encodeURIComponent(profile.creatorId)+'/review',{
    method:'PATCH',body:{
     identityVerified:value('identityVerified'),countryEligible:value('countryEligible'),
     complianceClear:value('complianceClear'),providerRecipientReady:value('providerRecipientReady'),
     riskHold:value('riskHold'),reviewNote:note.value.trim()||null
    }
   });
   card.append(node('p','admin-success','Payout review saved and audit-recorded.'));
   await loadPayoutProfiles();
  }catch(error){card.append(node('p','admin-error',error.message||'Payout review could not be saved.'));}
  finally{submit.disabled=false;}
 });
 card.append(form);
 return card;
}
async function loadPayoutProfiles(){
 if(!payoutProfilesList)return;
 if(!getSession()){placeholder(payoutProfilesList,'Sign in with a finance or administrator role.');return;}
 placeholder(payoutProfilesList,'Loading encrypted payout profiles and review state…');
 try{
  const result=await requestJson('/api/admin/payout-profiles');
  payoutProfilesList.replaceChildren();
  if(!result.profiles?.length){placeholder(payoutProfilesList,'No creator payout destinations are waiting in the database.');return;}
  result.profiles.forEach(profile=>payoutProfilesList.append(payoutProfileCard(profile)));
 }catch(error){placeholder(payoutProfilesList,error.status===403?'This account needs the finance or administrator role.':(error.message||'Payout review queue unavailable.'));}
}

document.getElementById('load-payout-profiles')?.addEventListener('click',loadPayoutProfiles);
document.getElementById('load-reports')?.addEventListener('click',loadReports);
document.getElementById('report-state-filter')?.addEventListener('change',loadReports);
document.getElementById('load-audit')?.addEventListener('click',loadAudit);
healthButton?.addEventListener('click',loadIntegrations);
window.addEventListener('zuno:session-change',()=>{loadOverview();loadReports();loadAudit();loadIntegrations();loadPayoutProfiles();});
mountAuth();loadOverview();loadReports();loadPayoutProfiles();
