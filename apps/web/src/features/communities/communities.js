import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function id(value){return document.getElementById(value);}
function makeKey(){return window.crypto?.randomUUID?.()||(window.crypto?.getRandomValues?Array.from(window.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''):null);}
let activeCommunity=null,activeChannel=null,loading=false;
function setStatus(message,isError=false){
 const status=id('community-status');if(status){status.textContent=message;status.classList.toggle('is-error',isError);}
 const summary=id('community-service-status');if(summary)summary.textContent=isError?'Community service needs attention':'Connected to the ZUNO community API';
}
function requireAuth(){if(getSession())return true;setStatus('Sign in to create, join or post in a community.');id('auth-state-button')?.click();return false;}
async function loadCommunities(){
 const list=id('community-list');if(!list||loading)return;
 if(!getSession()){list.replaceChildren(el('p','community-inline-status','Sign in to load communities.'));setStatus('Sign in to load community membership.');return;}
 loading=true;list.replaceChildren(el('p','community-inline-status','Loading communities…'));
 try{
  const result=await requestJson('/api/communities');list.replaceChildren();
  const items=Array.isArray(result.communities)?result.communities:[];
  if(!items.length)list.append(el('p','community-inline-status','No communities were returned for this account yet. Create one to get started.'));
  else items.forEach(item=>{
   const card=el('article','community-item-card'),head=el('div','community-item-heading');
   head.append(el('strong','',item.name),el('span','community-access-pill',item.access));
   card.append(head,el('p','',item.owner_id===getSession()?.user?.id?'Owned by you':'Community space'));
   const actions=el('div','community-item-actions'),open=el('button','button button-secondary button-small','Open channels');open.type='button';open.addEventListener('click',()=>openCommunity(item));actions.append(open);
   if(item.access==='public'){const join=el('button','button button-primary button-small','Join');join.type='button';join.addEventListener('click',async()=>{join.disabled=true;try{const answer=await requestJson('/api/communities/'+encodeURIComponent(item.id)+'/join',{method:'POST',body:{}});setStatus(answer.idempotent?'Already a member of '+item.name+'.':'Joined '+item.name+'.');await loadCommunities();}catch(error){setStatus(error.message||'Could not join community.',true);}finally{join.disabled=false;}});actions.append(join);}
   card.append(actions);list.append(card);
  });
  setStatus(items.length+' community space(s) loaded from the database.');
 }catch(error){list.replaceChildren(el('p','community-inline-status',error.message||'Community list unavailable.'));setStatus(error.message||'Community list unavailable.',true);}
 finally{loading=false;}
}
function renderChannels(channels){
 const list=id('community-channel-list');if(!list)return;list.replaceChildren();
 if(!channels.length){list.append(el('p','community-inline-status','This community has no available channels.'));activeChannel=null;return;}
 channels.forEach(channel=>{
  const button=el('button','community-channel-button'+(activeChannel?.id===channel.id?' is-active':''),'# '+channel.name);
  button.type='button';button.title=channel.description||channel.channelType;
  button.addEventListener('click',()=>selectChannel(channel));list.append(button);
 });
}
async function loadChannelPosts(){
 if(!activeCommunity||!activeChannel)return;
 const list=id('community-post-list');if(!list)return;
 list.replaceChildren(el('p','community-inline-status','Loading channel posts…'));
 try{
  const result=await requestJson('/api/communities/'+encodeURIComponent(activeCommunity.id)+'/channels/'+encodeURIComponent(activeChannel.id)+'/posts');
  if(!list)return;list.replaceChildren();
  const posts=Array.isArray(result.posts)?result.posts:[];
  if(!posts.length)list.append(el('p','community-inline-status','No posts in #'+activeChannel.name+' yet.'));
  posts.forEach(post=>{
   const card=el('article','community-post-card');
   card.append(el('strong','',post.author?.displayName||post.author?.username||'Member'),el('time','',new Date(post.createdAt).toLocaleString()),el('p','',post.body));
   list.append(card);
  });
 }catch(error){list.replaceChildren(el('p','community-inline-status',error.message||'Channel posts are unavailable.'));}
}
async function selectChannel(channel){
 activeChannel=channel;
 if(id('community-current-title'))id('community-current-title').textContent=activeCommunity.name+' · #'+channel.name;
 renderChannels([...(window.__zunoCommunityChannels||[])]);await loadChannelPosts();
}
async function loadChannels(){
 if(!activeCommunity)return;
 const list=id('community-channel-list');if(list)list.replaceChildren(el('p','community-inline-status','Loading channels…'));
 try{
  const result=await requestJson('/api/communities/'+encodeURIComponent(activeCommunity.id)+'/channels');
  const channels=Array.isArray(result.channels)?result.channels:[];
  window.__zunoCommunityChannels=channels;
  renderChannels(channels);
  if(!activeChannel||!channels.some(ch=>ch.id===activeChannel.id))activeChannel=channels[0]||null;
  if(activeChannel){renderChannels(channels);await selectChannel(activeChannel);}
  else {if(id('community-post-list'))id('community-post-list').replaceChildren(el('p','community-inline-status','Create a channel or ask a moderator to add one.'));if(id('community-post-form'))id('community-post-form').hidden=true;}
 }catch(error){if(list)list.replaceChildren(el('p','community-inline-status',error.message||'Channels are unavailable.'));setStatus(error.message||'Channels unavailable.',true);}
}
async function openCommunity(item){
 if(!requireAuth())return;
 activeCommunity=item;activeChannel=null;
 const area=id('community-post-area');if(area)area.hidden=false;
 if(id('community-current-title'))id('community-current-title').textContent=item.name;
 if(id('community-post-form'))id('community-post-form').hidden=false;
 await loadChannels();
 area?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
export function mountCommunities(){
 id('community-refresh')?.addEventListener('click',loadCommunities);
 id('community-channels-refresh')?.addEventListener('click',loadChannels);
 id('community-close-posts')?.addEventListener('click',()=>{activeCommunity=null;activeChannel=null;if(id('community-post-area'))id('community-post-area').hidden=true;});
 id('community-create-form')?.addEventListener('submit',async event=>{
  event.preventDefault();if(!requireAuth())return;
  const name=id('community-name')?.value.trim()||'',access=id('community-access')?.value||'public',submit=id('community-create-submit');
  if(name.length<2)return;if(submit)submit.disabled=true;setStatus('Creating community, owner membership and General channel…');
  try{
   const result=await requestJson('/api/communities',{method:'POST',headers:{'Idempotency-Key':makeKey()},body:{name,access}});
   event.currentTarget.reset();setStatus('Community created: '+result.community.name+'. General channel created.');await loadCommunities();await openCommunity(result.community);
  }catch(error){setStatus(error.message||'Community creation failed.',true);}
  finally{if(submit)submit.disabled=false;}
 });
 id('community-channel-create-form')?.addEventListener('submit',async event=>{
  event.preventDefault();if(!requireAuth()||!activeCommunity)return;
  const name=id('community-channel-name')?.value.trim()||'',channelType=id('community-channel-type')?.value||'chat';
  if(name.length<2){setStatus('Channel name must contain at least two characters.',true);return;}
  const submit=id('community-channel-create-submit');if(submit)submit.disabled=true;
  try{const result=await requestJson('/api/communities/'+encodeURIComponent(activeCommunity.id)+'/channels',{method:'POST',body:{name,channelType}});
   event.currentTarget.reset();setStatus('Created #'+result.channel.name+'.');await loadChannels();if(result.channel)await selectChannel(result.channel);
  }catch(error){setStatus(error.message||'Channel creation failed. Only community owners or moderators can create channels.',true);}
  finally{if(submit)submit.disabled=false;}
 });
 id('community-post-form')?.addEventListener('submit',async event=>{
  event.preventDefault();if(!requireAuth()||!activeCommunity||!activeChannel)return;
  const body=id('community-post-body')?.value.trim()||'';if(!body)return;
  const submit=id('community-post-submit');if(submit)submit.disabled=true;
  try{await requestJson('/api/communities/'+encodeURIComponent(activeCommunity.id)+'/channels/'+encodeURIComponent(activeChannel.id)+'/posts',{method:'POST',body:{body}});
   id('community-post-form')?.reset();await loadChannelPosts();setStatus('Post published to #'+activeChannel.name+'.');
  }catch(error){setStatus(error.message||'Channel post was not published.',true);}
  finally{if(submit)submit.disabled=false;}
 });
 window.addEventListener('zuno:session-change',loadCommunities);
 loadCommunities();
}
