import { requestJson } from '../../services/api-client.js';
import { getSession } from './auth/session.js';

const PAGE_SIZE=25;
let items=[];
let busy=false;
let offset=0;
let exhausted=false;

function id(name){return document.getElementById(name);}
function el(tag,cls,text){
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(text!==undefined&&text!==null)node.textContent=String(text);
 return node;
}
function showStatus(message,isError=false){
 const box=id('notification-summary');
 if(box){box.textContent=message;box.classList.toggle('is-error',Boolean(isError));}
}
function dateLabel(value){
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))return 'Date unavailable';
 return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);
}
function safeInternalTarget(value){
 if(typeof value!=='string'||!value)return null;
 try{
  const url=new URL(value,window.location.origin);
  if(url.origin!==window.location.origin)return null;
  return url.pathname+url.search+url.hash;
 }catch(_){return null;}
}
function renderNotification(item){
 const card=el('article','notification-item'+(item.read_at?' is-read':' is-unread'));
 const header=el('div','notification-item-header');
 header.append(el('span','notification-kind',String(item.kind||'update').replace(/[_-]/g,' ')),el('time','',dateLabel(item.created_at)));
 const payload=item.payload&&typeof item.payload==='object'?item.payload:{};
 const title=typeof payload.title==='string'?payload.title:'ZUNO update';
 const body=typeof payload.body==='string'?payload.body:(typeof payload.message==='string'?payload.message:'There is an update in your ZUNO account.');
 card.append(header,el('h4','',title),el('p','notification-item-body',body));
 const actions=el('div','notification-item-actions');
 if(!item.read_at){
  const read=el('button','button button-secondary button-small','Mark as read');
  read.type='button';read.addEventListener('click',()=>markRead(item,read));actions.append(read);
 }
 const target=safeInternalTarget(payload.url);
 if(target){
  const open=el('button','button button-secondary button-small','Open update');
  open.type='button';open.addEventListener('click',()=>{
   if(!item.read_at)markRead(item,null,false).finally(()=>window.location.assign(target));
   else window.location.assign(target);
  });actions.append(open);
 }
 if(actions.childElementCount)card.append(actions);
 return card;
}
function render(){
 const feed=id('notification-feed');
 const more=id('notification-load-more');
 if(!feed)return;
 feed.replaceChildren();
 if(!getSession()){
  feed.append(el('p','notification-empty','Sign in to load notifications scoped to your account.'));
  showStatus('Authentication required. No public or sample notification data is shown.');
  if(more)more.hidden=true;
  return;
 }
 if(!items.length){
  feed.append(el('p','notification-empty','You are all caught up. New account activity will appear here after ZUNO records it.'));
 }else items.forEach(item=>feed.append(renderNotification(item)));
 const unread=items.filter(item=>!item.read_at).length;
 showStatus(unread?unread+' unread update(s) in the loaded '+items.length+'.':'All '+items.length+' loaded update(s) are read.');
 if(more){more.hidden=exhausted;more.disabled=busy;more.textContent='Load earlier updates';}
}
async function load(reset=true){
 if(busy)return;
 if(!getSession()){items=[];offset=0;exhausted=true;render();return;}
 busy=true;
 const refresh=id('notification-refresh');
 if(refresh)refresh.disabled=true;
 if(reset){items=[];offset=0;exhausted=false;showStatus('Loading notifications from ZUNO…');}
 try{
  const result=await requestJson('/api/notifications?limit='+PAGE_SIZE+'&offset='+offset);
  const batch=Array.isArray(result.notifications)?result.notifications:[];
  const existing=new Set(items.map(item=>item.id));
  items.push(...batch.filter(item=>!existing.has(item.id)));
  offset+=batch.length;
  exhausted=batch.length<PAGE_SIZE;
  render();
 }catch(error){
  showStatus(error.status===401?'Sign in to load your notifications.':(error.message||'Notifications are unavailable.'),true);
  const feed=id('notification-feed');
  if(feed&&!items.length)feed.replaceChildren(el('p','notification-empty',error.message||'Notifications are unavailable.'));
 }finally{
  busy=false;
  if(refresh)refresh.disabled=false;
  if(!exhausted&&id('notification-load-more'))id('notification-load-more').hidden=false;
 }
}
async function markRead(item,button,rerender=true){
 if(!getSession())return;
 if(!item||item.read_at)return;
 if(button)button.disabled=true;
 try{
  await requestJson('/api/notifications/'+encodeURIComponent(item.id)+'/read',{method:'POST',body:{}});
  item.read_at=new Date().toISOString();
  if(rerender)render();
 }catch(error){
  showStatus(error.message||'Could not mark this notification as read.',true);
  if(button)button.disabled=false;
  throw error;
 }
}
export function mountNotifications(){
 id('notification-refresh')?.addEventListener('click',()=>load(true));
 id('notification-load-more')?.addEventListener('click',()=>load(false));
 window.addEventListener('zuno:session-change',()=>load(true));
 load(true);
}
