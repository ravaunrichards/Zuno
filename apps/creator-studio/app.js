import { mountProductLinks } from '../web/src/components/product-links.js';
import { requestJson } from '../web/src/services/api-client.js';
import { getSession } from '../web/src/features/auth/session.js';
import { mountAuth } from '../web/src/features/auth/auth-ui.js';
import { uploadAndProcess } from '../web/src/features/creation/media-upload.js';
import * as THREE from '../web/node_modules/three/build/three.module.js';

mountProductLinks();
const fileInput=document.getElementById('media-file');
const chooseButton=document.getElementById('choose-file');
const fileStatus=document.getElementById('file-status');
const saveButton=document.getElementById('save-draft');
const publishButton=document.getElementById('publish-post');
const caption=document.getElementById('caption');
const draftStatus=document.getElementById('draft-status');
const mediaLibrary=document.getElementById('media-library');
const publishedPosts=document.getElementById('published-posts');
const analyticsMetrics=document.getElementById('analytics-metrics');
let selectedFile=null;
let busy=false;

function el(tag,cls,text){
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(text!==undefined)node.textContent=String(text);
 return node;
}
function status(message,isError=false){
 if(draftStatus){draftStatus.textContent=message;draftStatus.classList.toggle('is-error',isError);}
}
function requireSignedIn(){
 if(getSession())return true;
 status('Sign in before uploading or publishing.',true);
 document.getElementById('auth-state-button')?.click();
 return false;
}
function mediaType(file){
 if(file?.type.startsWith('image/'))return 'image';
 if(file?.type.startsWith('video/'))return 'video';
 if(file?.type.startsWith('audio/'))return 'audio';
 return null;
}
function formatSize(value){
 const n=Number(value);
 if(!Number.isFinite(n)||n<0)return 'Size unavailable';
 if(n<1024*1024)return Math.round(n/1024)+' KB';
 return (n/1024/1024).toFixed(1)+' MB';
}
function assetCard(asset){
 const card=el('article','studio-list-item');
 const info=el('div','studio-list-copy');
 info.append(el('strong','',asset.mediaType+' · '+formatSize(asset.byteSize)));
 info.append(el('span','',asset.state+' · '+new Date(asset.createdAt).toLocaleString()));
 if(asset.state==='ready'&&asset.url){
  if(asset.mediaType==='image'){
   const img=el('img','studio-asset-image');img.src=asset.url;img.alt='Uploaded ZUNO media';img.loading='lazy';card.append(img);
  }else if(asset.mediaType==='video'){
   const video=el('video','studio-asset-video');video.src=asset.url;video.controls=true;video.preload='metadata';card.append(video);
  }else if(asset.mediaType==='audio'){
   const audio=el('audio','studio-asset-audio');audio.src=asset.url;audio.controls=true;card.append(audio);
  }
 }else if(asset.state!=='ready')info.append(el('span','',asset.metadata?.lastProcessingError||'This asset is not available for publishing.'));
 card.append(info);
 if(asset.state==='ready'){
  const use=el('button','secondary studio-use-asset','Use this media');
  use.type='button';use.addEventListener('click',()=>{selectedFile=null;if(fileInput)fileInput.value='';fileStatus.textContent='Selected previously processed media '+asset.id;fileStatus.dataset.assetId=asset.id;});
  card.append(use);
 }
 return card;
}
async function loadLibrary(){
 if(!mediaLibrary)return;
 if(!getSession()){mediaLibrary.replaceChildren(el('div','empty-state','Sign in to load media.'));return;}
 mediaLibrary.replaceChildren(el('div','empty-state','Loading your media…'));
 try{
  const result=await requestJson('/api/media/mine');
  mediaLibrary.replaceChildren();
  if(!result.assets?.length){mediaLibrary.append(el('div','empty-state','No uploaded media yet. Add a file to create a media asset.'));return;}
  result.assets.forEach(item=>mediaLibrary.append(assetCard(item)));
 }catch(error){mediaLibrary.replaceChildren(el('div','empty-state',error.message||'Media library unavailable.'));}
}
function postCard(post){
 const card=el('article','studio-list-item');
 card.append(el('strong','',post.kind+' · '+post.audience));
 card.append(el('span','',new Date(post.createdAt).toLocaleString()));
 if(post.caption)card.append(el('p','',post.caption));
 for(const item of (post.media||[])){
  if(!item.url)continue;
  if(item.mediaType==='image'){const img=el('img','studio-asset-image');img.src=item.url;img.alt=post.caption||'Published media';img.loading='lazy';card.append(img);}
  if(item.mediaType==='video'){const video=el('video','studio-asset-video');video.src=item.url;video.controls=true;video.preload='metadata';card.append(video);}
  if(item.mediaType==='audio'){const audio=el('audio','studio-asset-audio');audio.src=item.url;audio.controls=true;card.append(audio);}
 }
 return card;
}
async function loadPosts(){
 if(!publishedPosts)return;
 if(!getSession()){publishedPosts.replaceChildren(el('div','empty-state','Sign in to load posts.'));return;}
 publishedPosts.replaceChildren(el('div','empty-state','Loading your posts…'));
 try{
  const result=await requestJson('/api/posts/mine');
  publishedPosts.replaceChildren();
  if(!result.posts?.length){publishedPosts.append(el('div','empty-state','You have not published any posts yet.'));return;}
  result.posts.forEach(post=>publishedPosts.append(postCard(post)));
 }catch(error){publishedPosts.replaceChildren(el('div','empty-state',error.message||'Post history is unavailable.'));}
}
async function loadAnalytics(){
 if(!analyticsMetrics)return;
 if(!getSession()){analyticsMetrics.replaceChildren(el('div','empty-state','Sign in to load analytics.'));return;}
 analyticsMetrics.replaceChildren(el('div','empty-state','Loading persisted creator analytics…'));
 try{
  const result=await requestJson('/api/creator/analytics');
  const data=result.analytics||{};
  const entries=[
   ['Published posts',data.totalPosts],['Views',data.views],['Completed views',data.completedViews],
   ['Watch time',(Number(data.watchTimeMs||0)/60000).toFixed(1)+' min'],['Followers',data.followers],
   ['Comments',data.comments],['Reactions',data.reactions]
  ];
  analyticsMetrics.replaceChildren();
  for(const [label,value] of entries){const card=el('div','studio-metric');card.append(el('span','',label),el('strong','',new Intl.NumberFormat().format(Number(value)||0)+(label==='Watch time'?'':' ')));analyticsMetrics.append(card);}
  const numberFormat=new Intl.NumberFormat();
  const setMetric=(id,value)=>{const target=document.getElementById(id);if(target)target.textContent=value;};
  setMetric('home-kpi-posts',numberFormat.format(Number(data.totalPosts)||0));
  setMetric('home-kpi-views',numberFormat.format(Number(data.views)||0));
  setMetric('home-kpi-followers',numberFormat.format(Number(data.followers)||0));
  const watchMinutes=Number(data.watchTimeMs||0)/60000;
  setMetric('home-kpi-watch',watchMinutes>=60?(watchMinutes/60).toFixed(1)+' hr':watchMinutes.toFixed(1)+' min');
  setMetric('audience-follower-count',numberFormat.format(Number(data.followers)||0));
  setMetric('audience-post-count',numberFormat.format(Number(data.totalPosts)||0));

 }catch(error){analyticsMetrics.replaceChildren(el('div','empty-state',error.message||'Analytics are unavailable.'));}
}
function persistLocalDraft(){
 const value=caption?.value||'';
 try{localStorage.setItem('zuno:studio-draft',JSON.stringify({caption:value,filename:selectedFile?selectedFile.name:null,savedAt:new Date().toISOString()}));status('Draft saved on this device. Nothing was published.');}
 catch(_){status('Draft could not be saved in this browser.',true);}
}
async function publish(){
 if(busy||!requireSignedIn())return;
 const text=caption?.value.trim()||'';
 const selectedAssetId=fileStatus?.dataset.assetId||null;
 if(!text&&!selectedFile&&!selectedAssetId){status('Add a caption or choose media before publishing.',true);return;}
 busy=true;if(publishButton)publishButton.disabled=true;if(saveButton)saveButton.disabled=true;
 try{
  let assetId=selectedAssetId;
  let type=selectedAssetId?null:null;
  if(selectedFile){
   const processed=await uploadAndProcess(selectedFile,fileStatus);
   assetId=processed.assetId;type=processed.mediaType;
  }else if(assetId){
   const assetResult=await requestJson('/api/media/'+encodeURIComponent(assetId));
   type=assetResult.asset?.mediaType;
  }
  let kind='text';
  if(assetId){kind=type==='image'?'photo':type==='video'?'short_video':type==='audio'?'audio':'text';}
  if(kind==='text'&&!text)throw new Error('Text posts need a caption.');
  status('Publishing to ZUNO…');
  const body={kind,caption:text,audience:document.getElementById('post-audience')?.value||'public',...(assetId?{mediaAssetIds:[assetId]}:{})};
  const result=await requestJson('/api/posts',{method:'POST',body});
  if(!result.post?.id)throw new Error('The API did not confirm a published post.');
  if(fileStatus){fileStatus.dataset.assetId='';fileStatus.textContent='Published media. You can select another file.';}
  if(fileInput)fileInput.value='';
  selectedFile=null;if(caption)caption.value='';
  status('Published successfully. Post ID: '+result.post.id);
  await Promise.all([loadLibrary(),loadPosts(),loadAnalytics()]);
 }catch(error){status(error.message||'Publishing failed. The post was not confirmed.',true);}
 finally{busy=false;if(publishButton)publishButton.disabled=false;if(saveButton)saveButton.disabled=false;}
}
if(chooseButton&&fileInput)chooseButton.addEventListener('click',()=>fileInput.click());
if(fileInput)fileInput.addEventListener('change',()=>{
 selectedFile=fileInput.files&&fileInput.files[0]?fileInput.files[0]:null;
 if(fileStatus){fileStatus.dataset.assetId='';fileStatus.textContent=selectedFile?selectedFile.name+' · '+formatSize(selectedFile.size)+' · selected locally; not uploaded.':'No media selected.';}
});
if(saveButton&&caption){
 try{const saved=JSON.parse(localStorage.getItem('zuno:studio-draft')||'null');if(saved&&typeof saved.caption==='string')caption.value=saved.caption;}catch(_){}
 saveButton.addEventListener('click',persistLocalDraft);
}
publishButton?.addEventListener('click',publish);

async function loadCreatorTiers(){
 const box=document.getElementById('creator-tier-list');
 if(!box)return;
 if(!getSession()){box.replaceChildren(el('div','empty-state','Sign in to manage membership tiers.'));return;}
 box.replaceChildren(el('div','empty-state','Loading tiers from ZUNO…'));
 try{
  const result=await requestJson('/api/creator/subscription-tiers');
  box.replaceChildren();
  if(!result.tiers?.length){box.append(el('div','empty-state','No membership tiers yet. Create one to start memberships.'));return;}
  result.tiers.forEach(tier=>{
   const card=el('article','studio-list-item');
   const info=el('div','studio-list-copy');
   const price=new Intl.NumberFormat('en-US',{style:'currency',currency:tier.currency||'USD'}).format(Number(tier.monthlyPriceMinor)/100);
   info.append(el('strong','',tier.title+' · '+price+'/month'));
   info.append(el('span','',tier.enabled?'PayPal plan connected':'Disabled draft · provider plan needs reconciliation'));
   info.append(el('small','',(tier.benefits||[]).map(item=>typeof item==='string'?item:(item.label||item.key)).join(' · ')||'No listed benefits'));
   card.append(info,el('span',tier.enabled?'tier-ready':'tier-pending',tier.enabled?'ENABLED':'DRAFT'));
   box.append(card);
  });
 }catch(error){box.replaceChildren(el('div','empty-state',error.message||'Membership tiers unavailable.'));}
}
async function loadCreatorSubscribers(){
 const box=document.getElementById('creator-subscriber-list');
 if(!box)return;
 if(!getSession()){box.replaceChildren(el('div','empty-state','Sign in to see membership status.'));return;}
 box.replaceChildren(el('div','empty-state','Loading subscriber status…'));
 try{
  const result=await requestJson('/api/creator/subscriptions');
  box.replaceChildren();
  if(!result.subscriptions?.length){box.append(el('div','empty-state','No subscribers yet. Provider-confirmed memberships appear here.'));return;}
  const subscriberCount=document.getElementById('audience-subscriber-count');if(subscriberCount)subscriberCount.textContent=new Intl.NumberFormat().format(result.subscriptions.filter(item=>item.state==='active').length);
  result.subscriptions.forEach(sub=>{
   const row=el('article','studio-list-item');
   const info=el('div','studio-list-copy');
   info.append(el('strong','',sub.subscriber?.displayName||sub.subscriber?.username||'ZUNO subscriber'));
   info.append(el('span','',sub.tier+' · '+sub.state));
   info.append(el('small','',sub.currentPeriodEnd?'Current period ends '+new Date(sub.currentPeriodEnd).toLocaleDateString():'Period end not provided yet'));
   row.append(info,el('span',sub.state==='active'?'tier-ready':'tier-pending',sub.state.toUpperCase()));
   box.append(row);
  });
 }catch(error){box.replaceChildren(el('div','empty-state',error.message||'Subscriber list unavailable.'));}
}
function mountCreatorSubscriptions(){
 const form=document.getElementById('creator-tier-form');
 const title=document.getElementById('creator-tier-title');
 const price=document.getElementById('creator-tier-price');
 const benefits=document.getElementById('creator-tier-benefits');
 const note=document.getElementById('creator-tier-status');
 const submit=document.getElementById('creator-tier-submit');
 function report(message,isError=false){if(note){note.textContent=message;note.classList.toggle('is-error',isError);}}
 form?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!requireSignedIn())return;
  const name=title?.value.trim()||'';
  const amount=Number(price?.value);
  const benefitLines=(benefits?.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(name.length<2||name.length>80||!Number.isFinite(amount)||Math.round(amount*100)!==amount*100||amount<1||amount>999.99){
    report('Use a tier name and monthly USD price between 1.00 and 999.99.',true);return;
  }
  if(benefitLines.length>10||benefitLines.some(x=>x.length>160)){
    report('Limit benefits to 10 lines and 160 characters each.',true);return;
  }
  let key=null;
  try{key=localStorage.getItem('zuno:creator-tier-idempotency-key');}catch(_){}
  if(!key){key=window.crypto?.randomUUID?.()||null;try{if(key)localStorage.setItem('zuno:creator-tier-idempotency-key',key);}catch(_){} }
  if(!key){report('Secure request IDs require a modern browser over HTTPS.',true);return;}
  if(submit)submit.disabled=true;
  report('Creating PayPal product and monthly billing plan…');
  try{
   const result=await requestJson('/api/creator/subscription-tiers',{
    method:'POST',headers:{'Idempotency-Key':key},
    body:{title:name,monthlyPriceMinor:Math.round(amount*100),benefits:benefitLines}
   });
   report('Membership tier '+result.tier.title+' is enabled with a provider-backed monthly plan.');
   try{localStorage.removeItem('zuno:creator-tier-idempotency-key');}catch(_){}
   if(title)title.value='';
   if(benefits)benefits.value='';
   await Promise.all([loadCreatorTiers(),loadCreatorSubscribers()]);
  }catch(error){report(error.message||'The membership tier could not be enabled.',true);}
  finally{if(submit)submit.disabled=false;}
 });
 document.getElementById('creator-tiers-refresh')?.addEventListener('click',loadCreatorTiers);
 document.getElementById('creator-subscribers-refresh')?.addEventListener('click',loadCreatorSubscribers);
 window.addEventListener('zuno:session-change',()=>{loadCreatorTiers();loadCreatorSubscribers();});
 loadCreatorTiers();
 loadCreatorSubscribers();
}


const payoutBalance=document.getElementById('creator-payout-balance');
const payoutEligibility=document.getElementById('creator-payout-eligibility');
const payoutHistory=document.getElementById('creator-payout-history');
const payoutRequestButton=document.getElementById('creator-payout-request');
function payoutText(message,isError=false){
 const target=document.getElementById('creator-payout-request-status');
 if(target){target.textContent=message;target.classList.toggle('is-error',Boolean(isError));}
}
function moneyMinor(value,currency='USD'){
 return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(Number(value||0)/100);
}
function payoutLabel(code){
 return String(code||'').replace(/^PAYOUTS?_?/,'').replace(/_/g,' ').toLowerCase();
}
function getPayoutRequestKey(){
 try{
  const old=JSON.parse(localStorage.getItem('zuno:payout-request')||'null');
  if(old&&typeof old.key==='string'&&old.key.length>=16)return old;
 }catch(_){}
 const key=window.crypto?.randomUUID?.()||null;
 if(!key)throw new Error('Secure request IDs require an updated browser over HTTPS.');
 const saved={key,payoutId:null};
 try{localStorage.setItem('zuno:payout-request',JSON.stringify(saved));}catch(_){}
 return saved;
}
function payoutHistoryCard(payout){
 const card=el('article','studio-list-item');
 card.append(el('strong','',moneyMinor(payout.amountMinor,payout.currency)+' · '+payout.state));
 card.append(el('span','',new Date(payout.createdAt).toLocaleString()));
 if(payout.providerBatchId)card.append(el('code','', 'PayPal batch '+payout.providerBatchId));
 if(payout.failureCode)card.append(el('p','micro','Provider failure: '+payoutLabel(payout.failureCode)));
 return card;
}
async function loadCreatorPayouts(){
 if(!payoutBalance)return;
 if(!getSession()){
  payoutBalance.textContent='Sign in to load earnings and payout eligibility.';
  if(payoutEligibility)payoutEligibility.textContent='Only authenticated creators can submit payout details.';
  if(payoutRequestButton)payoutRequestButton.disabled=true;
  if(payoutHistory)payoutHistory.replaceChildren(el('div','empty-state','Sign in to load payout history.'));
  return;
 }
 try{
  const result=await requestJson('/api/payouts/mine');
  payoutBalance.textContent='Available earnings: '+moneyMinor(result.available?.amountMinor||0,result.available?.currency||'USD')+
   ' · Minimum: '+moneyMinor(result.minimum?.amountMinor||0,result.minimum?.currency||'USD');
  const destination=result.destination;
  const lines=[];
  if(destination)lines.push('Recipient: '+destination.maskedEmail+' · '+destination.countryCode);
  else lines.push('No PayPal destination saved.');
  if(destination)lines.push('Recipient readiness: '+(destination.providerRecipientReady?'ready':'review required'));
  if(result.eligibility?.reasons?.length)lines.push('Not ready: '+result.eligibility.reasons.map(payoutLabel).join(', '));
  else lines.push('Payout eligibility gates are cleared.');
  if(payoutEligibility)payoutEligibility.textContent=lines.join(' · ');
  if(payoutRequestButton)payoutRequestButton.disabled=!Boolean(result.eligibility?.eligible);
  if(payoutHistory){
   payoutHistory.replaceChildren();
   const payouts=Array.isArray(result.payouts)?result.payouts:[];
   if(!payouts.length)payoutHistory.append(el('div','empty-state','No payout requests yet.'));
   payouts.forEach(p=>payoutHistory.append(payoutHistoryCard(p)));
   try{
    const saved=JSON.parse(localStorage.getItem('zuno:payout-request')||'null');
    const previous=saved&&payouts.find(p=>p.id===saved.payoutId);
    if(previous&&['paid','failed'].includes(previous.state))localStorage.removeItem('zuno:payout-request');
   }catch(_){}
  }
 }catch(error){
  payoutBalance.textContent=error.message||'Payout readiness unavailable.';
  if(payoutRequestButton)payoutRequestButton.disabled=true;
 }
}
function mountCreatorPayouts(){
 const form=document.getElementById('creator-payout-destination-form');
 const email=document.getElementById('creator-payout-email');
 const country=document.getElementById('creator-payout-country');
 form?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!getSession()){payoutText('Sign in as a creator first.',true);return;}
  const countryCode=country?.value.trim().toUpperCase()||'';
  if(!/^[A-Z]{2}$/.test(countryCode)){payoutText('Enter a two-letter country code.',true);return;}
  const button=document.getElementById('creator-payout-save');if(button)button.disabled=true;
  payoutText('Encrypting and saving recipient securely…');
  try{
   const result=await requestJson('/api/payouts/destination',{method:'POST',body:{paypalEmail:email?.value||'',countryCode}});
   if(email)email.value='';
   payoutText(result.message||'Recipient saved. Review is still required.');
   await loadCreatorPayouts();
  }catch(error){payoutText(error.message||'Payout destination could not be saved.',true);}
  finally{if(button)button.disabled=false;}
 });
 payoutRequestButton?.addEventListener('click',async()=>{
  if(!getSession()){payoutText('Sign in before requesting a payout.',true);return;}
  payoutRequestButton.disabled=true;
  try{
   const key=getPayoutRequestKey();
   payoutText('Reserving available creator earnings and submitting a PayPal payout…');
   const result=await requestJson('/api/payouts/request',{method:'POST',headers:{'Idempotency-Key':key.key},body:{}});
   if(result.payout?.id){
    try{localStorage.setItem('zuno:payout-request',JSON.stringify({key:key.key,payoutId:result.payout.id}));}catch(_){}
   }
   payoutText(result.message||('Payout '+(result.payout?.state||'submitted')+'.'));
   await loadCreatorPayouts();
  }catch(error){
   if(error.code==='PAYOUT_PREVIOUS_ATTEMPT_FAILED'){try{localStorage.removeItem('zuno:payout-request');}catch(_){}}
   payoutText(error.message||'Payout was not submitted. Check the saved status before retrying.',true);
   await loadCreatorPayouts();
  }
 });
 document.getElementById('creator-payout-refresh')?.addEventListener('click',loadCreatorPayouts);
 window.addEventListener('zuno:session-change',loadCreatorPayouts);
 loadCreatorPayouts();
}

mountAuth();
mountCreatorSubscriptions();
mountCreatorPayouts();
async function refreshAll(){await Promise.all([loadLibrary(),loadPosts(),loadAnalytics()]);}
window.addEventListener('zuno:session-change',refreshAll);
refreshAll();


/* Creator Studio application shell, real account settings and 3D stage. */
const studioRoutes=['overview','content','publish','analytics','audience','monetization','live','settings'];
const studioTitles={overview:'Overview',content:'Content library',publish:'Publishing desk',analytics:'Creator analytics',audience:'Audience',monetization:'Monetization',live:'LIVE producer',settings:'Studio settings'};
function studioRoute(){
 const route=String(location.hash||'#overview').slice(1).split('?')[0];
 return studioRoutes.includes(route)?route:'overview';
}
function renderStudioRoute(){
 const route=studioRoute();
 document.querySelectorAll('.studio-page').forEach(page=>page.classList.toggle('is-active',page.dataset.page===route));
 document.querySelectorAll('.nav-link[data-route]').forEach(link=>{
  const active=link.dataset.route===route;
  link.classList.toggle('is-active',active);
  if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
 });
 const label=document.getElementById('page-current');
 if(label)label.textContent=studioTitles[route]||'Overview';
 if(route==='content'){loadLibrary();loadPosts();}
 if(route==='analytics')loadAnalytics();
 if(route==='audience')loadCreatorSubscribers();
 if(route==='monetization'){loadCreatorTiers();loadCreatorSubscribers();loadCreatorPayouts();}
 if(route==='live')loadStudioLiveRooms();
 if(route==='settings')loadStudioSettings();
}
function goStudioRoute(route){
 if(!studioRoutes.includes(route))return;
 if(location.hash==='#'+route){renderStudioRoute();return;}
 location.hash=route;
}
document.querySelectorAll('[data-route]').forEach(link=>link.addEventListener('click',event=>{
 const route=link.dataset.route;
 if(studioRoutes.includes(route)){event.preventDefault();goStudioRoute(route);}
}));
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>goStudioRoute(button.dataset.go)));
document.getElementById('top-create-button')?.addEventListener('click',()=>goStudioRoute('publish'));
document.getElementById('notifications-shortcut')?.addEventListener('click',()=>goStudioRoute('settings'));
document.getElementById('sidebar-auth-button')?.addEventListener('click',()=>document.getElementById('auth-state-button')?.click());
window.addEventListener('hashchange',renderStudioRoute);
const dateTarget=document.getElementById('studio-date');
if(dateTarget)dateTarget.textContent=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date());

/* The 3D stage is rendered by Three.js/WebGL. No 2D artwork is substituted. */
function mountCreatorStage(){
 const canvas=document.getElementById('studio-stage');
 if(!canvas)return;
 const fallback=document.getElementById('stage-fallback');
 let renderer;
 try{
  renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'high-performance'});
 }catch(_){
  if(fallback)fallback.hidden=false;
  return;
 }
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.7));
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.toneMapping=THREE.ACESFilmicToneMapping;
 renderer.toneMappingExposure=1.15;
 const scene=new THREE.Scene();
 const camera=new THREE.PerspectiveCamera(34,1,.1,100);
 camera.position.set(5.6,3.1,7.5);
 camera.lookAt(0,.55,0);
 const rig=new THREE.Group();
 scene.add(rig);
 scene.add(new THREE.HemisphereLight(0xd9e4ff,0x101525,2.1));
 const keyLight=new THREE.DirectionalLight(0xe5ddff,3.1);keyLight.position.set(4,7,5);scene.add(keyLight);
 const violetLight=new THREE.PointLight(0x9677ff,38,11);violetLight.position.set(-2.8,2.2,-1.2);scene.add(violetLight);
 const cyanLight=new THREE.PointLight(0x4ce3d0,24,10);cyanLight.position.set(3,1.6,2);scene.add(cyanLight);
 const metal=new THREE.MeshPhysicalMaterial({color:0x343a67,metalness:.78,roughness:.24,clearcoat:.9,clearcoatRoughness:.18});
 const darkMetal=new THREE.MeshStandardMaterial({color:0x151c31,metalness:.8,roughness:.3});
 const violet=new THREE.MeshPhysicalMaterial({color:0x8c70fa,metalness:.35,roughness:.2,emissive:0x2e1d7a,emissiveIntensity:.55});
 const cyan=new THREE.MeshStandardMaterial({color:0x57e3d1,metalness:.3,roughness:.22,emissive:0x12665d,emissiveIntensity:.6});
 const screenMat=new THREE.MeshStandardMaterial({color:0x1a2140,metalness:.25,roughness:.32,emissive:0x2d2864,emissiveIntensity:.55});
 const ground=new THREE.Mesh(new THREE.CircleGeometry(3.9,72),new THREE.MeshStandardMaterial({color:0x11182b,metalness:.48,roughness:.58,transparent:true,opacity:.78}));
 ground.rotation.x=-Math.PI/2;ground.position.y=-.08;rig.add(ground);
 const base=new THREE.Mesh(new THREE.CylinderGeometry(2.1,2.35,.22,64),darkMetal);base.position.y=.05;rig.add(base);
 const baseRim=new THREE.Mesh(new THREE.TorusGeometry(2.2,.027,12,80),cyan);baseRim.rotation.x=Math.PI/2;baseRim.position.y=.17;rig.add(baseRim);
 const centralDesk=new THREE.Mesh(new THREE.BoxGeometry(2.45,.22,1.05),metal);centralDesk.position.set(0,.62,.05);rig.add(centralDesk);
 const deskFront=new THREE.Mesh(new THREE.BoxGeometry(2.36,.1,.035),violet);deskFront.position.set(0,.58,.59);rig.add(deskFront);
 const monitorStand=new THREE.Mesh(new THREE.BoxGeometry(.16,.62,.16),darkMetal);monitorStand.position.set(0,1.02,-.08);rig.add(monitorStand);
 const monitor=new THREE.Mesh(new THREE.BoxGeometry(1.72,1.08,.11),darkMetal);monitor.position.set(0,1.63,-.16);rig.add(monitor);
 const monitorFace=new THREE.Mesh(new THREE.PlaneGeometry(1.57,.92),screenMat);monitorFace.position.set(0,1.63,-.098);rig.add(monitorFace);
 const monitorGlow=new THREE.Mesh(new THREE.PlaneGeometry(.95,.05),new THREE.MeshBasicMaterial({color:0x9d87ff}));monitorGlow.position.set(-.19,1.78,-.091);rig.add(monitorGlow);
 const monitorGlow2=new THREE.Mesh(new THREE.PlaneGeometry(.64,.035),new THREE.MeshBasicMaterial({color:0x57e3d1}));monitorGlow2.position.set(-.34,1.62,-.091);rig.add(monitorGlow2);
 const cameraBody=new THREE.Mesh(new THREE.BoxGeometry(.52,.36,.42),darkMetal);cameraBody.position.set(-1.55,1.02,.2);rig.add(cameraBody);
 const lens=new THREE.Mesh(new THREE.CylinderGeometry(.14,.18,.3,32),metal);lens.rotation.x=Math.PI/2;lens.position.set(-1.55,1.02,.58);rig.add(lens);
 const lensGlass=new THREE.Mesh(new THREE.CircleGeometry(.125,32),violet);lensGlass.position.set(-1.55,1.02,.74);rig.add(lensGlass);
 const cameraTop=new THREE.Mesh(new THREE.BoxGeometry(.2,.09,.17),violet);cameraTop.position.set(-1.55,1.25,.18);rig.add(cameraTop);
 const ringStand=new THREE.Mesh(new THREE.CylinderGeometry(.035,.05,.76,20),darkMetal);ringStand.position.set(1.45,.57,-.55);rig.add(ringStand);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(.57,.055,16,64),violet);ring.position.set(1.45,1.46,-.55);ring.rotation.y=-.2;rig.add(ring);
 const ringInner=new THREE.Mesh(new THREE.TorusGeometry(.45,.012,8,64),cyan);ringInner.position.copy(ring.position);ringInner.rotation.copy(ring.rotation);rig.add(ringInner);
 const lightPods=new THREE.Group();rig.add(lightPods);
 for(let n=0;n<3;n++){
  const pod=new THREE.Mesh(new THREE.BoxGeometry(.18,.34,.18),n===1?cyan:violet);
  pod.position.set(-.82+n*.82,.98,.72);lightPods.add(pod);
 }
 const floating=new THREE.Group();rig.add(floating);
 for(let n=0;n<3;n++){
  const orbit=new THREE.Mesh(new THREE.TorusGeometry(.17+n*.055,.018,8,32),n===1?cyan:violet);
  orbit.position.set(-1.5+n*1.45,2.45-(n%2)*.3,-.5-(n%2)*.65);orbit.rotation.set(.7+n*.28,.4+n*.4,.2);floating.add(orbit);
 }
 const grid=new THREE.GridHelper(8,32,0x47406e,0x28304b);grid.position.y=-.075;
 if(Array.isArray(grid.material)){grid.material.forEach(m=>{m.transparent=true;m.opacity=.22;});}else{grid.material.transparent=true;grid.material.opacity=.22;}
 rig.add(grid);
 let paused=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 let dragging=false,lastX=0,lastY=0,frame=0,disposed=false;
 const resize=()=>{
  const rect=canvas.getBoundingClientRect();
  const width=Math.max(1,rect.width),height=Math.max(1,rect.height);
  renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
 };
 const resizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null;
 resizeObserver?.observe(canvas.parentElement||canvas);resize();
 const animate=()=>{
  if(disposed)return;
  frame=requestAnimationFrame(animate);
  if(!paused){rig.rotation.y+=.0028;floating.rotation.y-=.004;lightPods.rotation.y+=.0012;}
  renderer.render(scene,camera);
 };
 animate();
 canvas.addEventListener('pointerdown',event=>{dragging=true;lastX=event.clientX;lastY=event.clientY;canvas.setPointerCapture?.(event.pointerId);});
 canvas.addEventListener('pointermove',event=>{
  if(!dragging)return;
  rig.rotation.y+=(event.clientX-lastX)*.006;
  rig.rotation.x=Math.max(-.22,Math.min(.22,rig.rotation.x+(event.clientY-lastY)*.002));
  lastX=event.clientX;lastY=event.clientY;
 });
 const stopDrag=()=>{dragging=false;};
 canvas.addEventListener('pointerup',stopDrag);canvas.addEventListener('pointercancel',stopDrag);canvas.addEventListener('lostpointercapture',stopDrag);
 document.getElementById('stage-reset')?.addEventListener('click',()=>{rig.rotation.set(0,0,0);camera.position.set(5.6,3.1,7.5);camera.lookAt(0,.55,0);});
 const pauseButton=document.getElementById('stage-pause');
 pauseButton?.addEventListener('click',()=>{paused=!paused;pauseButton.textContent=paused?'▶':'Ⅱ';pauseButton.setAttribute('aria-label',paused?'Resume 3D animation':'Pause 3D animation');});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)paused=true;});
 window.addEventListener('pagehide',()=>{disposed=true;resizeObserver?.disconnect();cancelAnimationFrame(frame);renderer.dispose();});
}
mountCreatorStage();

/* Real creator account and settings APIs. */
function setStatus(id,message,isError=false){
 const node=document.getElementById(id);
 if(!node)return;
 node.textContent=message;
 node.classList.toggle('is-error',Boolean(isError));
}
function signedInGate(id){
 if(getSession())return true;
 setStatus(id,'Sign in to manage these account settings.',true);
 document.getElementById('auth-state-button')?.click();
 return false;
}
async function loadStudioProfile(){
 const form=document.getElementById('studio-profile-form');
 if(!form)return;
 if(!getSession()){setStatus('studio-profile-status','Sign in to load your creator profile.');return;}
 try{
  const result=await requestJson('/api/profile/me');
  const profile=result.profile||{};
  const name=document.getElementById('studio-display-name');if(name)name.value=profile.displayName||'';
  const bio=document.getElementById('studio-bio');if(bio)bio.value=profile.bio||'';
  const visibility=document.getElementById('studio-visibility');if(visibility)visibility.value=profile.visibility||'public';
  const userName=profile.displayName||profile.username||'Creator account';
  const handle=document.getElementById('studio-user-name');if(handle)handle.textContent=userName;
  const userHandle=document.getElementById('studio-user-handle');if(userHandle)userHandle.textContent=profile.username?'@'+profile.username:'ZUNO creator';
  const avatar=document.getElementById('studio-avatar');if(avatar)avatar.textContent=String(userName).trim().charAt(0).toUpperCase()||'Z';
  const headerAvatar=document.getElementById('auth-state-button');if(headerAvatar)headerAvatar.textContent=String(userName).trim().charAt(0).toUpperCase()||'Z';
  setStatus('studio-profile-status','Profile loaded from your ZUNO account.');
 }catch(error){setStatus('studio-profile-status',error.message||'Creator profile could not be loaded.',true);}
}
document.getElementById('studio-profile-form')?.addEventListener('submit',async event=>{
 event.preventDefault();if(!signedInGate('studio-profile-status'))return;
 const button=document.getElementById('save-studio-profile');if(button)button.disabled=true;
 try{
  const body={
   display_name:document.getElementById('studio-display-name')?.value.trim()||'',
   bio:document.getElementById('studio-bio')?.value||'',
   visibility:document.getElementById('studio-visibility')?.value||'public'
  };
  await requestJson('/api/profile/me',{method:'PATCH',body});
  setStatus('studio-profile-status','Your ZUNO creator profile was saved.');
  await loadStudioProfile();
 }catch(error){setStatus('studio-profile-status',error.message||'Profile changes were not saved.',true);}
 finally{if(button)button.disabled=false;}
});
async function loadFeedSettings(){
 if(!getSession()){setStatus('feed-prefs-status','Sign in to load account preferences.');return;}
 try{
  const result=await requestJson('/api/feed/preferences');const prefs=result.preferences||{};
  const autoplay=document.getElementById('pref-autoplay');if(autoplay)autoplay.checked=Boolean(prefs.autoplayVideo);
  const motion=document.getElementById('pref-reduced-motion');if(motion)motion.checked=Boolean(prefs.reducedMotion);
  const saver=document.getElementById('pref-data-saver');if(saver)saver.checked=Boolean(prefs.dataSaver);
  setStatus('feed-prefs-status','Loaded from your ZUNO account.');
 }catch(error){setStatus('feed-prefs-status',error.message||'Account preferences are unavailable.',true);}
}
document.getElementById('save-feed-prefs')?.addEventListener('click',async()=>{
 if(!signedInGate('feed-prefs-status'))return;
 const button=document.getElementById('save-feed-prefs');if(button)button.disabled=true;
 try{
  const body={
   autoplayVideo:Boolean(document.getElementById('pref-autoplay')?.checked),
   reducedMotion:Boolean(document.getElementById('pref-reduced-motion')?.checked),
   dataSaver:Boolean(document.getElementById('pref-data-saver')?.checked)
  };
  await requestJson('/api/feed/preferences',{method:'PATCH',body});
  setStatus('feed-prefs-status','Preferences saved to your account.');
 }catch(error){setStatus('feed-prefs-status',error.message||'Preferences were not saved.',true);}
 finally{if(button)button.disabled=false;}
});
const notificationKeys=['comments','follows','messages','live','gifts'];
let studioNotificationTimezone='America/Jamaica';
async function loadNotificationSettings(){
 if(!getSession()){setStatus('notification-prefs-status','Sign in to load notification preferences.');return;}
 try{
  const result=await requestJson('/api/notifications/preferences');const prefs=result.preferences||{};const values=prefs.values||{};studioNotificationTimezone=prefs.timezone||studioNotificationTimezone;
  notificationKeys.forEach(key=>{const control=document.getElementById('notify-'+key);if(control)control.checked=Boolean(values[key]);});
  const start=document.getElementById('quiet-start');if(start)start.value=prefs.quietHoursStart||'';
  const end=document.getElementById('quiet-end');if(end)end.value=prefs.quietHoursEnd||'';
  setStatus('notification-prefs-status','Loaded from your ZUNO account.');
 }catch(error){setStatus('notification-prefs-status',error.message||'Notification preferences are unavailable.',true);}
}
document.getElementById('save-notification-prefs')?.addEventListener('click',async()=>{
 if(!signedInGate('notification-prefs-status'))return;
 const button=document.getElementById('save-notification-prefs');if(button)button.disabled=true;
 try{
  const values={};notificationKeys.forEach(key=>{values[key]=Boolean(document.getElementById('notify-'+key)?.checked);});
  const start=document.getElementById('quiet-start')?.value||null;
  const end=document.getElementById('quiet-end')?.value||null;
  if(Boolean(start)!==Boolean(end))throw new Error('Set both quiet-hours times or clear both fields.');
  const body={values,quietHoursStart:start,quietHoursEnd:end,timezone:studioNotificationTimezone};
  await requestJson('/api/notifications/preferences',{method:'PATCH',body});
  setStatus('notification-prefs-status','Notification preferences saved to your account.');
 }catch(error){setStatus('notification-prefs-status',error.message||'Notification preferences were not saved.',true);}
 finally{if(button)button.disabled=false;}
});
const themeToggle=document.getElementById('theme-toggle');
function applyStudioTheme(light){
 document.body.classList.toggle('theme-light',Boolean(light));
 if(themeToggle)themeToggle.checked=Boolean(light);
 try{localStorage.setItem('zuno:creator-studio-theme',light?'light':'dark');}catch(_){}
}
try{applyStudioTheme(localStorage.getItem('zuno:creator-studio-theme')==='light');}catch(_){}
themeToggle?.addEventListener('change',()=>applyStudioTheme(themeToggle.checked));
async function loadStudioSettings(){
 await Promise.all([loadStudioProfile(),loadFeedSettings(),loadNotificationSettings()]);
}
async function loadStudioLiveRooms(){
 const box=document.getElementById('live-room-list');if(!box)return;
 if(!getSession()){box.replaceChildren(el('div','empty-state','Sign in to load your LIVE room records.'));return;}
 box.replaceChildren(el('div','empty-state','Loading real room records…'));
 try{
  const result=await requestJson('/api/live/rooms/mine');
  const rooms=Array.isArray(result.rooms)?result.rooms:[];
  const homeBox=document.getElementById('home-live-preview');
  const renderRoom=(room)=>{
   const row=el('article','live-room-row');
   const copy=el('div','live-room-main');
   copy.append(el('strong','',room.title||'Untitled LIVE room'));
   copy.append(el('small','',String(room.category||'General')+' · '+(room.startedAt?'Started '+new Date(room.startedAt).toLocaleString():room.createdAt?'Created '+new Date(room.createdAt).toLocaleString():'No start time recorded')));
   const state=el('span','live-room-state'+(room.state==='ended'?' is-ended':''),room.state||'unknown');
   row.append(copy,state);return row;
  };
  box.replaceChildren();
  if(homeBox)homeBox.replaceChildren();
  if(!rooms.length){
   box.append(el('div','empty-state','No LIVE rooms have been recorded for this account yet.'));
   if(homeBox)homeBox.append(el('div','empty-state','No LIVE rooms have been recorded for this account.'));
   return;
  }
  rooms.forEach(room=>{box.append(renderRoom(room));if(homeBox&&homeBox.childElementCount<2)homeBox.append(renderRoom(room));});
 }catch(error){
  box.replaceChildren(el('div','empty-state',error.message||'LIVE room records are unavailable.'));
  const homeBox=document.getElementById('home-live-preview');if(homeBox)homeBox.replaceChildren(el('div','empty-state','LIVE room records are unavailable.'));
 }
}
document.getElementById('refresh-live-rooms')?.addEventListener('click',loadStudioLiveRooms);
document.getElementById('refresh-library')?.addEventListener('click',()=>{loadLibrary();loadPosts();});
document.getElementById('refresh-analytics')?.addEventListener('click',loadAnalytics);
document.querySelectorAll('[data-content-tab]').forEach(button=>button.addEventListener('click',()=>{
 document.querySelectorAll('[data-content-tab]').forEach(item=>item.classList.toggle('is-active',item===button));
 const media=button.dataset.contentTab==='media';
 const mediaPanel=document.getElementById('library-panel');if(mediaPanel)mediaPanel.hidden=!media;
 const postsPanel=document.getElementById('posts-panel');if(postsPanel)postsPanel.hidden=media;
 if(media)loadLibrary();else loadPosts();
}));
const uploadDropzone=document.getElementById('upload-dropzone');
if(uploadDropzone&&fileInput){
 uploadDropzone.addEventListener('click',event=>{if(event.target.closest('button'))return;fileInput.click();});
 ['dragenter','dragover'].forEach(type=>uploadDropzone.addEventListener(type,event=>{event.preventDefault();uploadDropzone.classList.add('is-dragging');}));
 ['dragleave','drop'].forEach(type=>uploadDropzone.addEventListener(type,event=>{event.preventDefault();uploadDropzone.classList.remove('is-dragging');}));
 uploadDropzone.addEventListener('drop',event=>{
  const file=event.dataTransfer?.files?.[0];if(!file)return;
  const transfer=new DataTransfer();transfer.items.add(file);fileInput.files=transfer.files;
  fileInput.dispatchEvent(new Event('change',{bubbles:true}));
 });
}
const captionInput=document.getElementById('caption'),captionCount=document.getElementById('caption-count');
function updateCaptionCount(){if(captionInput&&captionCount)captionCount.textContent=String(captionInput.value.length);}
captionInput?.addEventListener('input',updateCaptionCount);updateCaptionCount();
async function loadHomePosts(){
 const box=document.getElementById('home-recent-content');if(!box)return;
 if(!getSession()){box.replaceChildren(el('div','empty-state','Sign in to load your published content.'));return;}
 try{
  const result=await requestJson('/api/posts/mine');const posts=Array.isArray(result.posts)?result.posts:[];
  const count=document.getElementById('nav-content-count');if(count)count.textContent=String(posts.length);
  box.replaceChildren();
  if(!posts.length){box.append(el('div','empty-state','You have not published any posts yet. Your real posts will appear here.'));return;}
  posts.slice(0,4).forEach(post=>{
   const row=el('article','studio-list-item');
   const copy=el('div','studio-list-copy');
   copy.append(el('strong','',String(post.kind||'post').replace(/_/g,' ').toUpperCase()));
   copy.append(el('span','',new Date(post.createdAt).toLocaleString()+' · '+(post.audience||'Audience not supplied')));
   if(post.caption)copy.append(el('p','',post.caption));
   row.append(copy);box.append(row);
  });
 }catch(error){box.replaceChildren(el('div','empty-state',error.message||'Published content is unavailable.'));}
}
async function loadIntegrationReadiness(){
 const target=document.getElementById('integration-status');if(!target)return;
 try{
  const result=await requestJson('/api/meta/readiness');const systems=result.integrations||{};
  const configured=Object.entries(systems).filter(([,value])=>value==='configured').map(([key])=>key);
  const missing=Object.entries(systems).filter(([,value])=>value!=='configured').map(([key])=>key);
  target.classList.toggle('is-ready',missing.length===0);
  target.title='Configured integrations: '+(configured.join(', ')||'none')+'. Not configured: '+(missing.join(', ')||'none')+'. Configuration does not prove full provider verification.';
  target.innerHTML='<i></i> '+(missing.length?'Services need setup':'Services configured');
 }catch(_){target.classList.remove('is-ready');target.innerHTML='<i></i> Service status unavailable';}
}
function refreshStudioShell(){
 const signed=Boolean(getSession());
 const avatar=document.getElementById('auth-state-button');if(avatar&&!signed)avatar.textContent='Z';
 if(!signed){
  const name=document.getElementById('studio-user-name');if(name)name.textContent='Your account';
  const handle=document.getElementById('studio-user-handle');if(handle)handle.textContent='Sign in to continue';
 }
 Promise.all([loadHomePosts(),loadStudioLiveRooms(),loadIntegrationReadiness()]);
 if(studioRoute()==='settings')loadStudioSettings();
}
document.getElementById('creator-subscribers-refresh')?.addEventListener('click',loadCreatorSubscribers);
document.getElementById('creator-tiers-refresh')?.addEventListener('click',loadCreatorTiers);
document.getElementById('creator-payout-refresh')?.addEventListener('click',loadCreatorPayouts);
window.addEventListener('zuno:session-change',refreshStudioShell);
refreshStudioShell();
renderStudioRoute();
