import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function id(value){return document.getElementById(value);}
function makeKey(){return window.crypto?.randomUUID?.() || (window.crypto?.getRandomValues ? Array.from(window.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('') : null);}
let activeCommunity=null;
let loading=false;
function setStatus(message,isError=false){
 const status=id('community-status');if(status){status.textContent=message;status.classList.toggle('is-error',isError);}
 const summary=id('community-service-status');if(summary)summary.textContent=isError?'Community service needs attention':'Connected to the ZUNO community API';
}
function requireAuth(){if(getSession())return true;setStatus('Sign in to create, join or post in a community.');id('auth-state-button')?.click();return false;}
function renderCommunity(item){
 const card=el('article','community-item-card');
 const head=el('div','community-item-heading');head.append(el('strong','',item.name),el('span','community-access-pill',item.access));
 card.append(head,el('p','',item.owner_id===getSession()?.user?.id?'Owned by you':'Community space'));
 const actions=el('div','community-item-actions');
 const open=el('button','button button-secondary button-small','Open posts');open.type='button';open.addEventListener('click',()=>openCommunity(item));
 actions.append(open);
 if(item.access==='public') {const join=el('button','button button-primary button-small','Join');join.type='button';join.addEventListener('click',async()=>{join.disabled=true;try{const result=await requestJson('/api/communities/'+encodeURIComponent(item.id)+'/join',{method:'POST',body:{}});setStatus(result.idempotent?'You are already a member of '+item.name+'.':'Joined '+item.name+'.');await loadCommunities();}catch(error){setStatus(error.message||'Could not join community.',true);}finally{join.disabled=false;}});actions.append(join);}
 card.append(actions);return card;
}
async function loadCommunities(){
 const list=id('community-list');if(!list||loading)return;
 if(!getSession()){list.replaceChildren(el('p','community-inline-status','Sign in to load communities.'));setStatus('Sign in to load community membership.');return;}
 loading=true;list.replaceChildren(el('p','community-inline-status','Loading communities…'));
 try{
  const result=await requestJson('/api/communities');
  list.replaceChildren();
  const items=Array.isArray(result.communities)?result.communities:[];
  if(!items.length)list.append(el('p','community-inline-status','No communities were returned for this account yet. Create one to get started.'));
  else items.forEach(item=>list.append(renderCommunity(item)));
  setStatus(items.length+' community space(s) loaded from the database.');
 }catch(error){list.replaceChildren(el('p','community-inline-status',error.message||'Community list unavailable.'));setStatus(error.message||'Community list unavailable.',true);}
 finally{loading=false;}
}
async function openCommunity(item){
 if(!requireAuth())return;
 activeCommunity=item;
 const area=id('community-post-area');if(area)area.hidden=false;
 if(id('community-current-title'))id('community-current-title').textContent=item.name;
 const list=id('community-post-list');if(list)list.replaceChildren(el('p','community-inline-status','Loading community posts…'));
 try{
  const result=await requestJson('/api/communities/'+encodeURIComponent(item.id)+'/posts');
  if(!list)return;list.replaceChildren();
  if(!result.posts?.length)list.append(el('p','community-inline-status','No posts in this community yet.'));
  result.posts.forEach(post=>{const card=el('article','community-post-card');card.append(el('strong','',post.author?.displayName||post.author?.username||'Member'),el('time','',new Date(post.createdAt).toLocaleString()),el('p','',post.body));list.append(card);});
  area?.scrollIntoView({behavior:'smooth',block:'nearest'});
 }catch(error){if(list)list.replaceChildren(el('p','community-inline-status',error.message||'Posts are unavailable.'));}
}
export function mountCommunities(){
 id('community-refresh')?.addEventListener('click',loadCommunities);
 id('community-close-posts')?.addEventListener('click',()=>{activeCommunity=null;if(id('community-post-area'))id('community-post-area').hidden=true;});
 id('community-create-form')?.addEventListener('submit',async event=>{
  event.preventDefault();if(!requireAuth())return;
  const name=id('community-name')?.value.trim()||'';const access=id('community-access')?.value||'public';const submit=id('community-create-submit');
  if(name.length<2)return;submit.disabled=true;setStatus('Creating community, owner membership and General channel…');
  try{
   const result=await requestJson('/api/communities',{method:'POST',headers:{'Idempotency-Key':makeKey()},body:{name,access}});
   event.currentTarget.reset();setStatus('Community created: '+result.community.name+'. Owner membership and General channel are ready.');await loadCommunities();await openCommunity(result.community);
  }catch(error){setStatus(error.message||'Community creation failed.',true);}
  finally{submit.disabled=false;}
 });
 id('community-post-form')?.addEventListener('submit',async event=>{
  event.preventDefault();if(!requireAuth()||!activeCommunity)return;
  const body=id('community-post-body')?.value.trim()||'';if(!body)return;
  const submit=id('community-post-submit');submit.disabled=true;
  try{await requestJson('/api/communities/'+encodeURIComponent(activeCommunity.id)+'/posts',{method:'POST',body:{body}});id('community-post-form')?.reset();await openCommunity(activeCommunity);setStatus('Community post published.');}
  catch(error){setStatus(error.message||'Post was not published.',true);}
  finally{submit.disabled=false;}
 });
 window.addEventListener('zuno:session-change',loadCommunities);
 loadCommunities();
}
