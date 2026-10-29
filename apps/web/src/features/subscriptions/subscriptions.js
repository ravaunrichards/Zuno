import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

let currentCreator=null;
let loading=false;
function id(name){return document.getElementById(name);}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=String(text);return n;}
function report(message,isError=false){const box=id('subscriptions-status');if(box){box.textContent=message;box.classList.toggle('is-error',isError);}}
function openDialog(){
 const dialog=id('subscriptions-dialog');if(!dialog)return;
 if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else dialog.setAttribute('open','');
}
function closeDialog(){const dialog=id('subscriptions-dialog');if(typeof dialog?.close==='function'&&dialog.open)dialog.close();else dialog?.removeAttribute('open');}
function authRequired(){if(getSession())return true;report('Sign in to view tiers or manage memberships.');id('auth-state-button')?.click();return false;}
function priceLabel(minor,currency='USD'){return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(Number(minor)/100);}
function randomKey(){return window.crypto?.randomUUID?.()||null;}
function cleanReturn(){
 const url=new URL(window.location.href);url.searchParams.delete('subscription');url.searchParams.delete('subscriptionId');
 window.history.replaceState({},'',url.pathname+url.search+url.hash);
}
function setView(view){
 document.querySelectorAll('[data-subscription-view]').forEach(button=>button.classList.toggle('is-active',button.dataset.subscriptionView===view));
 const creatorBox=id('creator-tier-results'), mineBox=id('my-subscription-results');
 if(creatorBox)creatorBox.hidden=view!=='creator';if(mineBox)mineBox.hidden=view!=='mine';
}
function showCreatorHeader(creator){
 if(id('subscription-modal-intro'))id('subscription-modal-intro').textContent=creator
  ?'Membership tiers offered by '+(creator.displayName||creator.username||'this creator')+'.'
  :'Choose a creator from search to see their recurring membership tiers.';
}
async function showCreatorTiers(creator){
 if(!authRequired())return;
 if(!creator||!creator.id){report('Creator profile reference is missing.',true);return;}
 currentCreator=creator;setView('creator');showCreatorHeader(creator);openDialog();
 const box=id('creator-tier-results');if(!box)return;
 box.replaceChildren(el('p','subscription-empty','Loading recurring tiers…'));
 try{
  const result=await requestJson('/api/creators/'+encodeURIComponent(creator.id)+'/subscription-tiers');
  box.replaceChildren();
  const tiers=Array.isArray(result.tiers)?result.tiers:[];
  if(!tiers.length){box.append(el('p','subscription-empty','This creator has no enabled membership tiers yet.'));report('No active tiers were returned by the database.');return;}
  tiers.forEach(tier=>{
   const card=el('article','creator-tier-card');
   card.append(el('span','section-kicker','MONTHLY MEMBERSHIP'),el('h3','',tier.title));
   card.append(el('strong','creator-tier-price',priceLabel(tier.monthlyPriceMinor,tier.currency)+' / month'));
   const benefits=el('ul','creator-tier-benefits');
   (tier.benefits||[]).forEach(item=>{
    const label=typeof item==='string'?item:(item.label||item.key||'Membership benefit');
    benefits.append(el('li','',label));
   });
   if(benefits.childElementCount)card.append(benefits);
   const button=el('button','button button-primary button-small','Subscribe with PayPal');button.type='button';
   button.addEventListener('click',()=>startSubscription(tier,button));
   card.append(button);box.append(card);
  });
  report('Tier details are loaded. A membership activates only after PayPal confirms subscription status.');
 }catch(error){box.replaceChildren(el('p','subscription-empty',error.message||'Creator tiers unavailable.'));report(error.message||'Creator tiers unavailable.',true);}
}
async function startSubscription(tier,button){
 if(!authRequired()||loading)return;
 const key=randomKey();if(!key){report('Secure request IDs require a modern browser over HTTPS.',true);return;}
 loading=true;if(button)button.disabled=true;
 report('Creating a PayPal recurring subscription…');
 try{
  const result=await requestJson('/api/creator-subscriptions',{method:'POST',headers:{'Idempotency-Key':key},body:{tierId:tier.id}});
  const subscription=result.subscription||{};
  if(subscription.state==='active'){
   report('This membership is already active.');setView('mine');await loadMine();return;
  }
  if(typeof subscription.approvalUrl!=='string'||!subscription.approvalUrl){
   throw new Error('The server did not return a provider approval URL. No membership has been activated.');
  }
  const target=new URL(subscription.approvalUrl);
  if(target.protocol!=='https:'||!(target.hostname==='paypal.com'||target.hostname.endsWith('.paypal.com'))){
   throw new Error('The subscription provider returned an untrusted approval URL. No redirect was started.');
  }
  report('PayPal recurring approval is required. Membership remains pending until provider confirmation.');
  window.location.assign(target.toString());
 }catch(error){report(error.message||'Subscription checkout could not start.',true);}
 finally{loading=false;if(button)button.disabled=false;}
}
async function loadMine(){
 if(!authRequired())return;
 const box=id('my-subscription-results');if(!box)return;
 box.replaceChildren(el('p','subscription-empty','Loading your memberships…'));
 try{
  const result=await requestJson('/api/creator-subscriptions/mine');box.replaceChildren();
  const items=Array.isArray(result.subscriptions)?result.subscriptions:[];
  if(!items.length){box.append(el('p','subscription-empty','You have no memberships yet. Search for a creator and view their available tiers.'));report('No memberships found.');return;}
  items.forEach(item=>{
   const row=el('article','my-subscription-card');
   row.append(el('strong','',item.tier||'Creator membership'));
   row.append(el('span','',item.state));
   if(item.monthlyPriceMinor!==null)row.append(el('small','',priceLabel(item.monthlyPriceMinor,item.currency)+' / month'));
   if(item.currentPeriodEnd)row.append(el('small','','Current period ends '+new Date(item.currentPeriodEnd).toLocaleDateString()));
   const controls=el('div','my-subscription-actions');
   if(['active','pending','grace'].includes(item.state)){
    const cancel=el('button','button button-secondary button-small','Cancel membership');cancel.type='button';
    cancel.addEventListener('click',async()=>{
     cancel.disabled=true;report('Requesting provider cancellation…');
     try{
      await requestJson('/api/creator-subscriptions/'+encodeURIComponent(item.id)+'/cancel',{method:'POST',body:{}});
      report('Cancellation was accepted by the service. Provider events/status lookup determine final entitlement state.');
      await loadMine();
     }catch(error){report(error.message||'Cancellation needs reconciliation.',true);}
     finally{cancel.disabled=false;}
    });
    controls.append(cancel);
   }
   row.append(controls);box.append(row);
  });
  report('Membership statuses are from the ZUNO database and provider reconciliation.');
 }catch(error){box.replaceChildren(el('p','subscription-empty',error.message||'Membership list unavailable.'));report(error.message||'Membership list unavailable.',true);}
}
async function handleReturn(){
 const url=new URL(window.location.href),mode=url.searchParams.get('subscription'),subscriptionId=url.searchParams.get('subscriptionId');
 if(!mode)return;
 if(!getSession()){report('Sign in to verify your PayPal membership. No browser return is treated as activation.');openDialog();return;}
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subscriptionId||'')){
  report('The return URL did not include a valid ZUNO subscription reference.',true);cleanReturn();return;
 }
 if(mode==='cancel'){
  try{
   await requestJson('/api/creator-subscriptions/'+encodeURIComponent(subscriptionId)+'/cancel',{method:'POST',body:{}});
   report('The subscription cancellation request was sent.');cleanReturn();setView('mine');openDialog();await loadMine();
  }catch(error){report(error.message||'The cancelled checkout needs reconciliation.',true);openDialog();}
  return;
 }
 if(mode!=='return')return;
 try{
  report('Checking PayPal subscription status…');
  const result=await requestJson('/api/creator-subscriptions/'+encodeURIComponent(subscriptionId)+'/refresh');
  const state=result.subscription?.state||'pending';
  report(state==='active'?'PayPal confirmed the membership is active.':'Provider status is '+state+'. Entitlements will not be enabled until activation is confirmed.');
  cleanReturn();setView('mine');openDialog();await loadMine();
 }catch(error){report(error.message||'Provider status could not be verified. The membership is not being claimed active.',true);openDialog();}
}
export function mountSubscriptions(){
 document.querySelectorAll('[data-action="my-subscriptions"]').forEach(button=>button.addEventListener('click',()=>{setView('mine');showCreatorHeader(null);openDialog();loadMine();}));
 document.querySelectorAll('[data-action="subscribe-to-creator"]').forEach(button=>button.addEventListener('click',()=>showCreatorTiers({
  id:button.dataset.creatorId,username:button.dataset.creatorUsername,displayName:button.dataset.creatorName
 })));
 document.querySelectorAll('[data-subscription-view]').forEach(button=>button.addEventListener('click',()=>{
  const view=button.dataset.subscriptionView;setView(view);
  if(view==='mine')loadMine();else if(currentCreator)showCreatorTiers(currentCreator);
 }));
 id('close-subscriptions-dialog')?.addEventListener('click',closeDialog);
 window.addEventListener('zuno:view-creator-tiers',event=>showCreatorTiers(event.detail));
 window.addEventListener('zuno:session-change',()=>{handleReturn();});
 handleReturn();
}
