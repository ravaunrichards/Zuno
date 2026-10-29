import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';
import { uploadAndProcess } from '../creation/media-upload.js';

const $ = (id) => document.getElementById(id);
const el = (tag,cls,text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
let stories = [];
let currentStory = null;
let loading = false;
function status(message,isError=false) {
  for (const id of ['story-status','story-viewer-status','story-create-status']) {
    const box=$(id);
    if(box && ((id==='story-viewer-status'&&$('story-viewer-dialog')?.open)||(id==='story-create-status'&&$('story-create-dialog')?.open)||id==='story-status')) {
      box.textContent=message||'';
      box.classList.toggle('is-error',Boolean(isError));
    }
  }
}
function requireAuth() {
  if(getSession())return true;
  status('Sign in to create or view stories.',true);
  $('auth-state-button')?.click();
  return false;
}
function openDialog(id) {
  const dialog=$(id);
  if(!dialog)return;
  if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}
  else dialog.setAttribute('open','');
}
function closeDialog(id) {
  const dialog=$(id);
  if(typeof dialog?.close==='function'&&dialog.open)dialog.close();
  else dialog?.removeAttribute('open');
}
function trustedMediaUrl(raw) {
  if(typeof raw!=='string'||!raw)return null;
  try {
    const url=new URL(raw,window.location.href);
    if(url.protocol!=='https:' && url.origin!==window.location.origin)return null;
    if(url.username||url.password)return null;
    return url.toString();
  } catch (_) { return null; }
}
function relativeTime(value) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return 'Just now';
  const minutes=Math.max(0,Math.round((Date.now()-date.getTime())/60000));
  if(minutes<1)return 'Just now';
  if(minutes<60)return minutes+'m ago';
  return Math.floor(minutes/60)+'h ago';
}
function renderStories() {
  const rail=$('story-rail');
  if(!rail)return;
  rail.replaceChildren();
  const mine=el('button','story-bubble story-bubble-create');
  mine.type='button';
  mine.append(el('span','story-bubble-art','＋'),el('strong','','Add story'));
  mine.addEventListener('click',openCreator);
  rail.append(mine);
  if(!stories.length) {
    rail.append(el('p','story-inline-status','No active stories returned by the API. Create one to get started.'));
    return;
  }
  const authorSeen=new Set();
  stories.forEach(story=>{
    if(!story.author || !story.author.id || authorSeen.has(story.id))return;
    authorSeen.add(story.id);
    const card=el('button','story-bubble'+(story.viewedByMe?' is-viewed':''));
    card.type='button';
    const art=el('span','story-bubble-art',story.author.username?.slice(0,1)?.toUpperCase()||'Z');
    if(story.author.avatarUrl) {
      const image=el('img','story-author-avatar');
      image.src=story.author.avatarUrl;image.alt='';image.loading='lazy';
      art.replaceChildren(image);
    }
    card.append(art,el('strong','',story.isMine?'Your story':(story.author.displayName||story.author.username||'ZUNO member')));
    card.title=(story.caption||'Story')+' · expires '+relativeTime(story.expiresAt);
    card.addEventListener('click',()=>openStory(story));
    rail.append(card);
  });
}
async function loadStories() {
  if(loading)return;
  const rail=$('story-rail');
  if(!getSession()) {
    if(rail)rail.replaceChildren(el('p','story-inline-status','Sign in to see stories shared with you.'));
    return;
  }
  loading=true;
  try {
    const result=await requestJson('/api/stories');
    stories=Array.isArray(result.stories)?result.stories:[];
    renderStories();
    status(stories.length?stories.length+' active stories loaded from the server.':'No active stories right now.');
  } catch(error) {
    if(rail)rail.replaceChildren(el('p','story-inline-status',error.message||'Stories could not be loaded.'));
    status(error.status===401?'Sign in to view stories.':(error.message||'Stories are unavailable.'),true);
  } finally {loading=false;}
}
function openCreator() {
  if(!requireAuth())return;
  $('story-create-form')?.reset();
  status('');
  openDialog('story-create-dialog');
}
function createClientKey() {
  if(window.crypto&&typeof window.crypto.randomUUID==='function')return window.crypto.randomUUID();
  if(window.crypto&&typeof window.crypto.getRandomValues==='function') {
    return Array.from(window.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  }
  throw new Error('Secure upload request IDs are unavailable in this browser.');
}
async function submitStory(event) {
  event.preventDefault();
  if(!requireAuth())return;
  const file=$('story-media-file')?.files?.[0];
  if(!file){status('Choose a media file first.',true);return;}
  const button=$('story-create-submit');
  if(button)button.disabled=true;
  try {
    status('Uploading and processing story media…');
    const processed=await uploadAndProcess(file,$('story-create-status'));
    await requestJson('/api/stories',{method:'POST',headers:{'Idempotency-Key':createClientKey()},body:{
      mediaAssetId:processed.assetId,
      caption:$('story-caption').value.trim(),
      audience:$('story-audience').value
    }});
    closeDialog('story-create-dialog');
    status('Story published. It will expire in 24 hours.');
    await loadStories();
  } catch(error) {
    status(error.message||'Story could not be published.',true);
  } finally {if(button)button.disabled=false;}
}
function renderStoryMedia(story) {
  const box=$('story-viewer-media');
  if(!box)return;
  box.replaceChildren();
  const media=story.media||{};
  const url=trustedMediaUrl(media.url);
  if(!url || media.state!=='ready') {
    box.append(el('div','story-media-unavailable','This story’s media is not available as a verified, processed asset.'));
    return;
  }
  let item;
  if(media.mediaType==='video') {
    item=el('video','story-media-video');item.controls=true;item.playsInline=true;item.autoplay=true;item.preload='metadata';item.src=url;
  } else if(media.mediaType==='audio') {
    item=el('audio','story-media-audio');item.controls=true;item.autoplay=true;item.preload='metadata';item.src=url;
  } else {
    item=el('img','story-media-image');item.src=url;item.alt=story.caption||'ZUNO story';item.loading='eager';
  }
  box.append(item);
  if(!story.viewedByMe && !story.isMine) {
    requestJson('/api/stories/'+encodeURIComponent(story.id)+'/view',{method:'POST',body:{completed:true}})
      .then(()=>{story.viewedByMe=true;renderStories();})
      .catch(()=>{});
  }
}
async function openStory(story) {
  if(!requireAuth())return;
  currentStory=story;
  $('story-viewer-title').textContent=story.caption||'Story';
  $('story-viewer-author').textContent=(story.author?.displayName||story.author?.username||'ZUNO member')+' · '+relativeTime(story.createdAt);
  $('story-viewer-caption').textContent=story.caption||'';
  $('story-reply-form').hidden=Boolean(story.isMine);
  $('story-delete-button').hidden=!story.isMine;
  $('story-reply-input').value='';
  status('');
  renderStoryMedia(story);
  openDialog('story-viewer-dialog');
}
async function replyToStory(event) {
  event.preventDefault();
  if(!currentStory||!requireAuth())return;
  const input=$('story-reply-input');const body=input.value.trim();
  if(!body)return;
  const button=$('story-reply-form').querySelector('button[type="submit"]');
  button.disabled=true;
  try {
    await requestJson('/api/stories/'+encodeURIComponent(currentStory.id)+'/replies',{method:'POST',body:{body}});
    input.value='';
    status('Reply sent to the story creator.');
  } catch(error) {status(error.message||'Story reply could not be sent.',true);}
  finally {button.disabled=false;}
}
async function deleteStory() {
  if(!currentStory||!currentStory.isMine)return;
  if(!window.confirm('Delete this story for everyone who can see it?'))return;
  const button=$('story-delete-button');button.disabled=true;
  try {
    await requestJson('/api/stories/'+encodeURIComponent(currentStory.id),{method:'DELETE'});
    closeDialog('story-viewer-dialog');currentStory=null;
    status('Story deleted.');
    await loadStories();
  } catch(error) {status(error.message||'Story could not be deleted.',true);}
  finally {button.disabled=false;}
}
export function mountStories() {
  $('story-create-open')?.addEventListener('click',openCreator);
  $('story-create-cancel')?.addEventListener('click',()=>closeDialog('story-create-dialog'));
  $('story-viewer-close')?.addEventListener('click',()=>{closeDialog('story-viewer-dialog');currentStory=null;});
  $('story-create-form')?.addEventListener('submit',submitStory);
  $('story-reply-form')?.addEventListener('submit',replyToStory);
  $('story-delete-button')?.addEventListener('click',deleteStory);
  $('story-create-dialog')?.addEventListener('cancel',event=>{event.preventDefault();closeDialog('story-create-dialog');});
  $('story-viewer-dialog')?.addEventListener('cancel',event=>{event.preventDefault();closeDialog('story-viewer-dialog');currentStory=null;});
  window.addEventListener('zuno:session-change',()=>{if(!getSession()){closeDialog('story-viewer-dialog');closeDialog('story-create-dialog');}else loadStories();});
  loadStories();
}
