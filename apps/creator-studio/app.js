import { requestJson } from '../web/src/services/api-client.js';
import { getSession } from '../web/src/features/auth/session.js';
import { mountAuth } from '../web/src/features/auth/auth-ui.js';
import { uploadAndProcess } from '../web/src/features/creation/media-upload.js';

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
  const key=window.crypto?.randomUUID?.();
  if(!key){report('Secure request IDs require a modern browser over HTTPS.',true);return;}
  if(submit)submit.disabled=true;
  report('Creating PayPal product and monthly billing plan…');
  try{
   const result=await requestJson('/api/creator/subscription-tiers',{
    method:'POST',headers:{'Idempotency-Key':key},
    body:{title:name,monthlyPriceMinor:Math.round(amount*100),benefits:benefitLines}
   });
   report('Membership tier '+result.tier.title+' is enabled with a provider-backed monthly plan.');
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

mountAuth();
mountCreatorSubscriptions();
async function refreshAll(){await Promise.all([loadLibrary(),loadPosts(),loadAnalytics()]);}
window.addEventListener('zuno:session-change',refreshAll);
refreshAll();
