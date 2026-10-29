import { Room, RoomEvent, Track } from 'livekit-client';
import { requestJson } from '../services/api-client.js';
import { getSession } from './auth/session.js';

let conversations=[];
let currentConversation=null;
let currentConversationMembers=[];
let busy=false;
let incomingPoller=null;
let call=null;

function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function id(name){return document.getElementById(name);}
function uuid(){return window.crypto?.randomUUID?.()||null;}
function setStatus(message,isError=false){const status=id('messaging-status');if(status){status.textContent=message;status.classList.toggle('is-error',isError);}const card=id('messages-card-status');if(card)card.textContent=message;}
function requireAuth(){if(getSession())return true;setStatus('Sign in to use messaging and calls.');id('auth-state-button')?.click();return false;}
function fmt(value){const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(d):'';}
function conversationTitle(c){if(c.isGroup)return 'Group conversation';const other=(c.members||[]).find(m=>m.id!==myProfileId)?.profile;return other?(other.displayName||other.username||'Direct conversation'):'Direct conversation';}
let myProfileId=null;
function openDialog(){const d=id('messaging-dialog');if(d&&typeof d.showModal==='function'&&!d.open)d.showModal();else if(d)d.setAttribute('open','');}
function clearThread(message){id('message-thread')?.replaceChildren(el('p','message-empty',message));}
function renderConversation(c){
 const button=el('button','conversation-list-item'+(currentConversation?.id===c.id?' is-active':''));
 button.type='button';const other=(c.members||[]).find(m=>m.id!==myProfileId)?.profile;
 button.append(el('strong','',conversationTitle(c)),el('span','conversation-preview',c.lastMessage?.body||'No messages yet'),el('small','',c.lastMessage?fmt(c.lastMessage.createdAt):'Conversation created'));
 button.addEventListener('click',()=>selectConversation(c));return button;
}
function renderConversations(){
 const list=id('conversation-list');if(!list)return;list.replaceChildren();
 if(!conversations.length){list.append(el('p','message-empty','No conversations yet. Start a direct chat by unique username, or open Message from a creator profile.'));return;}
 conversations.forEach(c=>list.append(renderConversation(c)));
}
async function loadConversations(){
 if(busy)return;
 if(!requireAuth()){renderConversations();return;}
 busy=true;setStatus('Loading conversations from ZUNO…');
 try{
  const [profileResult,conversationResult]=await Promise.all([requestJson('/api/profile/me'),requestJson('/api/conversations')]);
  myProfileId=profileResult.profile.id;
  conversations=Array.isArray(conversationResult.conversations)?conversationResult.conversations:[];
  renderConversations();setStatus(conversations.length+' conversation(s) loaded from the database.');
  if(currentConversation){const updated=conversations.find(c=>c.id===currentConversation.id);if(updated)currentConversation=updated;}
 }catch(error){setStatus(error.message||'Inbox unavailable.',true);const list=id('conversation-list');if(list)list.replaceChildren(el('p','message-empty',error.message||'Inbox unavailable.'));}
 finally{busy=false;}
}
function renderMessage(message){
 const card=el('article','message-bubble'+(message.mine?' mine':''));
 const header=el('div','message-bubble-header');
 header.append(el('strong','',message.mine?'You':message.sender?.displayName||message.sender?.username||'Member'),el('time','',fmt(message.created_at||message.createdAt)));
 card.append(header,el('p','',message.body||''));
 const meta=el('div','message-bubble-meta');
 (message.reactions||[]).forEach(r=>{
  const b=el('button','message-reaction'+(r.mine?' is-mine':''),r.reaction);b.type='button';b.title=r.mine?'Remove reaction':'Reaction';b.addEventListener('click',()=>toggleReaction(message,r.reaction));meta.append(b);
 });
 if(message.readReceiptCount)meta.append(el('small','','Seen by '+message.readReceiptCount));
 const actions=el('div','message-bubble-actions');
 for(const [reaction,label] of [['like','Like'],['love','Love'],['laugh','Laugh']]){
  const b=el('button','message-action',label);b.type='button';b.addEventListener('click',()=>toggleReaction(message,reaction));actions.append(b);
 }
 if(message.mine){
  const edit=el('button','message-action','Edit');edit.type='button';edit.addEventListener('click',()=>editMessage(message));
  const remove=el('button','message-action','Delete');remove.type='button';remove.addEventListener('click',()=>deleteMessage(message));actions.append(edit,remove);
 }
 card.append(meta,actions);
 return card;
}
async function loadMessages(){
 if(!currentConversation)return;
 const convo=currentConversation;
 const thread=id('message-thread');
 if(thread)thread.replaceChildren(el('p','message-empty','Loading messages…'));
 try{
  const result=await requestJson('/api/conversations/'+encodeURIComponent(convo.id)+'/messages');
  if(currentConversation?.id!==convo.id)return;
  const messages=Array.isArray(result.messages)?result.messages:[];
  if(thread){thread.replaceChildren();if(!messages.length)thread.append(el('p','message-empty','No messages yet. Send the first one.'));
   messages.forEach(message=>{thread.append(renderMessage(message));requestJson('/api/messages/'+encodeURIComponent(message.id)+'/read',{method:'POST',body:{}}).catch(()=>{});});thread.scrollTop=thread.scrollHeight;}
 }catch(error){if(thread)thread.replaceChildren(el('p','message-empty',error.message||'Messages are unavailable.'));setStatus(error.message||'Messages unavailable.',true);}
}
async function selectConversation(c){
 currentConversation=c;currentConversationMembers=Array.isArray(c.members)?c.members:[];
 id('message-thread-title').textContent=conversationTitle(c);
 id('message-thread-subtitle').textContent=(c.isGroup?'Group':'Direct')+' conversation · '+currentConversationMembers.length+' member(s)';
 id('call-audio').disabled=false;id('call-video').disabled=false;
 renderConversations();await loadMessages();
}
async function sendMessage(event){
 event.preventDefault();if(!requireAuth()||!currentConversation)return;
 const input=id('message-compose-input');const value=input?.value.trim()||'';if(!value)return;
 const button=event.submitter;if(button)button.disabled=true;
 try{await requestJson('/api/conversations/'+encodeURIComponent(currentConversation.id)+'/messages',{method:'POST',body:{body:value}});
  input.value='';await loadMessages();await loadConversations();setStatus('Message sent.');
 }catch(error){setStatus(error.message||'Message was not sent.',true);}
 finally{if(button)button.disabled=false;}
}
async function toggleReaction(message,reaction){
 if(!requireAuth())return;
 const mine=(message.reactions||[]).some(r=>r.mine&&r.reaction===reaction);
 try{await requestJson('/api/messages/'+encodeURIComponent(message.id)+'/reactions',{method:mine?'DELETE':'POST',body:{reaction}});await loadMessages();}
 catch(error){setStatus(error.message||'Reaction could not be updated.',true);}
}
async function editMessage(message){
 const value=window.prompt('Edit message:',message.body||'');if(value===null||!value.trim())return;
 try{await requestJson('/api/messages/'+encodeURIComponent(message.id),{method:'PATCH',body:{body:value.trim()}});await loadMessages();setStatus('Message edited.');}
 catch(error){setStatus(error.message||'Message could not be edited.',true);}
}
async function deleteMessage(message){
 if(!window.confirm('Delete this message for all members of the conversation?'))return;
 try{await requestJson('/api/messages/'+encodeURIComponent(message.id),{method:'DELETE',body:{}});await loadMessages();setStatus('Message deleted.');}
 catch(error){setStatus(error.message||'Message could not be deleted.',true);}
}
async function createConversation(event){
 event.preventDefault();if(!requireAuth())return;
 const input=id('conversation-recipient');const username=input?.value.trim().replace(/^@/,'').toLowerCase()||'';
 if(!/^[a-z0-9_.]{3,30}$/.test(username)){setStatus('Enter the recipient’s unique ZUNO username (3–30 letters, numbers, periods or underscores).',true);return;}
 try{
  const key=uuid();
  if(!key){setStatus('Secure request IDs require a current browser context.',true);return;}
  const result=await requestJson('/api/conversations',{method:'POST',headers:{'Idempotency-Key':key},body:{recipientUsername:username,isGroup:false}});
  input.value='';await loadConversations();const c=conversations.find(item=>item.id===result.conversation.id);
  if(c)await selectConversation(c);else setStatus('Conversation created. Refresh the inbox to load it.');
 }catch(error){setStatus(error.code==='CONVERSATION_RECIPIENT_NOT_FOUND'?'No ZUNO member uses that username.':(error.message||'Conversation could not be created.'),true);}
}
function cleanLiveRoom(){
 const stage=id('messaging-call-stage');if(stage)stage.hidden=true;
 const grid=id('message-call-video-grid');if(grid)grid.replaceChildren(el('p','message-empty','Call ended.'));
}
function attachCallTrack(room,track,participant){
 const grid=id('message-call-video-grid');if(!grid)return;
 const tile=el('div','message-call-video-tile');
 const label=el('small','',participant.identity===myProfileId?'You':participant.identity||'Participant');
 tile.append(label);
 const media=track.attach();
 if(track.kind===Track.Kind.Video){media.className='message-call-video';media.autoplay=true;media.playsInline=true;}
 else media.className='message-call-audio';
 tile.prepend(media);grid.append(tile);media.play?.().catch(()=>{});
}
async function connectCall(tokenData,callInfo){
 if(call)await endCall(false);
 if(!tokenData?.livekit?.url||!tokenData?.livekit?.token)throw new Error('Call token response is missing.');
 const room=new Room({adaptiveStream:true,dynacast:true});
 call={room,info:callInfo,mic:false,camera:false};
 const stage=id('messaging-call-stage');if(stage)stage.hidden=false;
 id('active-call-title').textContent=(callInfo.callType==='video'?'Video':'Audio')+' call · '+(callInfo.state||'connecting');
 id('message-call-video-grid').replaceChildren(el('p','message-empty','Connecting to LiveKit…'));
 room.on(RoomEvent.TrackSubscribed,(track,publication,participant)=>attachCallTrack(room,track,participant));
 room.on(RoomEvent.ParticipantConnected,participant=>setStatus((participant.name||participant.identity)+' joined the call.'));
 room.on(RoomEvent.ParticipantDisconnected,participant=>setStatus((participant.name||participant.identity)+' left the call.'));
 await room.connect(tokenData.livekit.url,tokenData.livekit.token,{autoSubscribe:true});
 if(callInfo.callType==='video'){await room.localParticipant.setCameraEnabled(true);call.camera=true;}
 await room.localParticipant.setMicrophoneEnabled(true);call.mic=true;
 for(const pub of room.localParticipant.trackPublications.values())if(pub.track)attachCallTrack(room,pub.track,room.localParticipant);
 id('message-call-video-grid').querySelectorAll('.message-empty').forEach(node=>node.remove());
 setStatus('Call connected. Microphone and camera are controlled by your device permissions.');
}
async function startCall(callType){
 if(!requireAuth()||!currentConversation)return;
 const invitees=currentConversationMembers.map(m=>m.id).filter(profileId=>profileId!==myProfileId);
 if(!invitees.length){setStatus('This conversation has no other members to call.',true);return;}
 try{const result=await requestJson('/api/calls',{method:'POST',body:{conversationId:currentConversation.id,callType,participantProfileIds:invitees.slice(0,7)}});
  await connectCall(result.call,result.call);
 }catch(error){setStatus(error.message||'Call could not be started.',true);}
}
async function endCall(notify=true){
 if(!call)return;
 const previous=call;call=null;
 try{await previous.room.disconnect();}catch(_){}
 try{if(notify)await requestJson('/api/calls/'+encodeURIComponent(previous.info.id)+'/leave',{method:'POST',body:{}});}catch(_){}
 cleanLiveRoom();setStatus('Call disconnected.');
}
async function loadIncomingCalls(){
 if(!getSession())return;
 const list=id('incoming-call-list');if(!list)return;
 try{
  const result=await requestJson('/api/calls/incoming');list.replaceChildren();
  const calls=Array.isArray(result.calls)?result.calls:[];
  if(!calls.length)return;
  list.append(el('strong','incoming-call-heading','Incoming calls'));
  calls.forEach(item=>{
   const card=el('div','incoming-call-card');
   card.append(el('span','',((item.caller?.displayName||item.caller?.username||'A member')+' is calling ('+item.callType+').')));
   const buttons=el('div','incoming-call-actions');
   const join=el('button','button button-primary button-small','Answer');join.type='button';
   join.addEventListener('click',async()=>{try{const data=await requestJson('/api/calls/'+encodeURIComponent(item.id)+'/join',{method:'POST',body:{}});await connectCall(data.call,data.call);}catch(error){setStatus(error.message||'Could not answer call.',true);}});
   const decline=el('button','button button-secondary button-small','Decline');decline.type='button';
   decline.addEventListener('click',async()=>{try{await requestJson('/api/calls/'+encodeURIComponent(item.id)+'/decline',{method:'POST',body:{}});await loadIncomingCalls();}catch(error){setStatus(error.message||'Could not decline call.',true);}});
   buttons.append(join,decline);card.append(buttons);list.append(card);
  });
 }catch(error){if(error.status!==401)setStatus(error.message||'Incoming calls unavailable.',true);}
}
async function toggleCallMic(){
 if(!call)return;call.mic=!call.mic;
 try{await call.room.localParticipant.setMicrophoneEnabled(call.mic);id('call-mic-toggle').textContent=call.mic?'Mute microphone':'Turn microphone on';}
 catch(error){call.mic=!call.mic;setStatus(error.message||'Microphone unavailable.',true);}
}
async function toggleCallCamera(){
 if(!call)return;call.camera=!call.camera;
 try{await call.room.localParticipant.setCameraEnabled(call.camera);id('call-camera-toggle').textContent=call.camera?'Turn camera off':'Turn camera on';}
 catch(error){call.camera=!call.camera;setStatus(error.message||'Camera unavailable.',true);}
}
export function mountMessaging(){
 const dialog=id('messaging-dialog');
 id('messages-launch')?.addEventListener('click',()=>{openDialog();loadConversations();loadIncomingCalls();});
 id('messaging-close')?.addEventListener('click',()=>dialog?.close());
 id('messaging-refresh')?.addEventListener('click',async()=>{await loadConversations();await loadIncomingCalls();if(currentConversation)await loadMessages();});
 id('conversation-create-form')?.addEventListener('submit',createConversation);
 id('message-compose-form')?.addEventListener('submit',sendMessage);
 id('call-audio')?.addEventListener('click',()=>startCall('audio'));
 id('call-video')?.addEventListener('click',()=>startCall('video'));
 id('call-end')?.addEventListener('click',()=>endCall());
 id('call-mic-toggle')?.addEventListener('click',toggleCallMic);
 id('call-camera-toggle')?.addEventListener('click',toggleCallCamera);
 dialog?.addEventListener('cancel',event=>{if(call){event.preventDefault();endCall();}});
 dialog?.addEventListener('close',()=>{if(call)endCall();});
 window.addEventListener('zuno:session-change',()=>{loadConversations();loadIncomingCalls();});
 if(getSession())loadIncomingCalls();
 incomingPoller=window.setInterval(()=>{if(dialog?.open){loadIncomingCalls();if(currentConversation)loadMessages();}},6000);
 window.addEventListener('zuno:profile-message',event=>{
  const profileId=event.detail?.profileId;
  if(!profileId||!getSession())return;
  id('conversation-recipient').value=profileId;openDialog();
  const form=id('conversation-create-form');if(form)form.requestSubmit();
 });
 if(getSession())loadConversations();
}
