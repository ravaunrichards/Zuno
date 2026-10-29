import { Room, RoomEvent, Track } from 'livekit-client';
import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

const POLL_MS = 4500;
const roomsById = new Map();
let active = null;
let roomLoadBusy = false;
let uiMounted = false;
let closeBusy = false;

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}
function byId(id) { return document.getElementById(id); }
function say(message, isError = false) {
  const el = byId('live-room-status');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-error', Boolean(isError));
}
function setSectionStatus(message) {
  const el = byId('live-status');
  if (el) el.textContent = message;
  const note = byId('live-note');
  if (note) note.textContent = message;
}
function dialogOpen() {
  const dlg = byId('live-room-dialog');
  if (!dlg) return;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else dlg.setAttribute('open', '');
}
function dialogClose() {
  const dlg = byId('live-room-dialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
}
function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function displayTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'LIVE now';
  return new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(date);
}
function safeLiveKitUrl(value) {
  try {
    const url = new URL(value);
    if (!['wss:','https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch (_) { return null; }
}
function mustBeSignedIn() {
  if (getSession()) return true;
  setSectionStatus('Sign in to create a LIVE room, join the audience or use guest/chat controls.');
  byId('auth-state-button')?.click();
  return false;
}
async function requestTokenJoin(roomId) {
  const result = await requestJson('/api/live/rooms/' + encodeURIComponent(roomId) + '/join', {method:'POST',body:{}});
  if (!result.livekit || !result.livekit.token || !result.livekit.url) throw new Error('The LIVE join response did not contain a LiveKit token.');
  return result;
}
function videoTile(room, participant, local = false) {
  const stage = byId('live-video-grid');
  if (!stage) return null;
  if (!active || active.room !== room) return null;
  const identity = participant.identity || 'participant';
  const key = (local ? 'local:' : 'remote:') + identity;
  if (active.tiles.has(key)) return active.tiles.get(key);
  const tile = node('div','live-video-tile');
  tile.dataset.participant = key;
  const label = node('span','live-video-tile-name',(local ? 'You' : (participant.name || identity)));
  tile.append(label);
  const placeholder = node('span','live-video-placeholder',local ? 'Your camera will appear here' : 'Waiting for participant media…');
  placeholder.style.minHeight = '80px';
  placeholder.style.gridColumn = 'auto';
  tile.prepend(placeholder);
  stage.querySelector('.live-video-placeholder')?.remove();
  stage.append(tile);
  active.tiles.set(key,tile);
  return tile;
}
function mediaElFromTrack(track) {
  let el = track.attach();
  if (!el) return null;
  if (track.kind === Track.Kind.Video) {
    el.className = 'live-track-video';
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('aria-label','Live video');
  } else if (track.kind === Track.Kind.Audio) {
    el.className = 'live-audio-track';
    el.autoplay = true;
    el.setAttribute('aria-label','Live participant audio');
  }
  return el;
}
function attachTrack(room, track, participant, local = false) {
  if (!active || active.room !== room) return;
  const tile = videoTile(room,participant,local);
  if (!tile) return;
  const el = mediaElFromTrack(track);
  if (!el) return;
  if (track.kind === Track.Kind.Video) {
    tile.querySelectorAll('video').forEach(old => {
      if (old !== el) {
        const publication = [...room.localParticipant.videoTrackPublications.values()].find(p => p.track && p.track.mediaStreamTrack === old.srcObject?.getVideoTracks?.()[0]);
        if (!publication) old.remove();
      }
    });
    tile.querySelector('.live-video-placeholder')?.remove();
    const firstChild = tile.querySelector('.live-video-tile-name');
    if (firstChild) tile.insertBefore(el,firstChild); else tile.append(el);
  } else {
    tile.append(el);
  }
  el.play?.().catch(() => {
    say('Media is connected. Tap the stage or check browser media playback permissions if audio/video stays muted.');
  });
}
function detachTrack(room, track, participant, local = false) {
  const key = (local ? 'local:' : 'remote:') + (participant.identity || 'participant');
  const tile = active && active.tiles.get(key);
  if (!tile) return;
  track.detach().forEach(el => el.remove());
  if (!tile.querySelector('video') && !tile.querySelector('audio')) {
    tile.append(node('span','live-video-placeholder','Waiting for participant media…'));
  }
}
function removeParticipant(room, participant) {
  if (!active || active.room !== room) return;
  const key = 'remote:' + (participant.identity || 'participant');
  const tile = active.tiles.get(key);
  if (tile) tile.remove();
  active.tiles.delete(key);
  if (byId('live-video-grid') && !byId('live-video-grid').querySelector('.live-video-tile')) {
    byId('live-video-grid').append(node('div','live-video-placeholder','Waiting for video tracks…'));
  }
}
function setRoomTitle(title, subtitle) {
  if (byId('live-active-title')) byId('live-active-title').textContent = title || 'LIVE room';
  if (byId('live-room-subtitle')) byId('live-room-subtitle').textContent = subtitle || '';
}
function resetStage() {
  const grid = byId('live-video-grid');
  if (!grid) return;
  grid.replaceChildren(node('div','live-video-placeholder','Waiting for video tracks…'));
}
function updateLocalControls() {
  if (!active) return;
  const mic = byId('live-mic-toggle');
  const camera = byId('live-camera-toggle');
  const guest = byId('live-guest-request');
  if (mic) { mic.hidden = active.role === 'viewer'; mic.disabled = !['connected','live'].includes(active.state); mic.textContent = active.micEnabled ? 'Mute microphone' : 'Turn microphone on'; }
  if (camera) { camera.hidden = active.role === 'viewer'; camera.disabled = !['connected','live'].includes(active.state); camera.textContent = active.cameraEnabled ? 'Turn camera off' : 'Turn camera on'; }
  if (guest) {
    guest.hidden = active.isHost;
    if (active.role === 'guest') {
      guest.textContent = 'Guest seat active';
      guest.disabled = true;
    } else if (active.guestRequestState === 'pending') {
      guest.textContent = 'Guest request pending';
      guest.disabled = true;
    } else if (active.guestRequestState === 'accepted') {
      guest.textContent = 'Join as guest';
      guest.disabled = false;
    } else {
      guest.textContent = 'Request guest seat';
      guest.disabled = !['connected','live'].includes(active.state);
    }
  }
  const hostPanel = byId('live-host-panel');
  if (hostPanel) hostPanel.hidden = !active.isHost;
  if (byId('live-leave-button')) byId('live-leave-button').textContent = active.isHost ? 'End LIVE' : 'Leave room';
}
function bindRoomEvents(room) {
  room.on(RoomEvent.TrackSubscribed,(track,publication,participant)=>attachTrack(room,track,participant,false));
  room.on(RoomEvent.TrackUnsubscribed,(track,publication,participant)=>detachTrack(room,track,participant,false));
  room.on(RoomEvent.LocalTrackPublished,(publication,participant)=>{
    if (publication.track) attachTrack(room,publication.track,participant,true);
  });
  room.on(RoomEvent.LocalTrackUnpublished,(publication,participant)=>{
    if (publication.track) detachTrack(room,publication.track,participant,true);
  });
  room.on(RoomEvent.ParticipantConnected,participant=>say((participant.name||participant.identity)+' connected.'));
  room.on(RoomEvent.ParticipantDisconnected,participant=>{
    removeParticipant(room,participant);
    say((participant.name||participant.identity)+' left the room.');
  });
  room.on(RoomEvent.Disconnected,()=>{
    if (active && active.room === room && active.state !== 'leaving') {
      active.state = 'disconnected';
      say('LiveKit disconnected. Rejoin the room to continue.',true);
      updateLocalControls();
    }
  });
  room.on(RoomEvent.ConnectionStateChanged,state=>{
    if (active && active.room === room && state === 'reconnecting') say('Reconnecting to LIVE…');
    if (active && active.room === room && state === 'connected') say('Connected to the LIVE room.');
  });
}
async function connectRoom({roomId,title,token,url,role,isHost,privateRoom=false,startAfterConnect=false}) {
  const safeUrl = safeLiveKitUrl(url);
  if (!safeUrl) throw new Error('The LiveKit service URL is missing or not a trusted secure URL.');
  if (active) {
    if (active.roomId === roomId) {
      // Guest role upgrade: disconnect the viewer transport without marking the
      // persisted participant as left; the accepted request already changed the
      // server-side role to guest and the replacement token is for this identity.
      const previous = active;
      previous.state = 'reconnecting';
      stopPolling(previous);
      try { await previous.room.disconnect(); } catch (_) {}
      active = null;
      resetStage();
    } else {
      await leaveActive({closeDialog:false,refresh:false});
    }
  }
  const room = new Room({adaptiveStream:true,dynacast:true,stopLocalTrackOnUnpublish:true});
  active = {
    room, roomId, title, role:role||'viewer', isHost:Boolean(isHost), privateRoom,
    state:'connecting', micEnabled:false, cameraEnabled:false,
    tiles:new Map(), pollTimer:null, guestRequestState:null
  };
  resetStage();
  setRoomTitle(title,role==='host'?'You are the host':'Connected as '+(role||'viewer'));
  dialogOpen();
  updateLocalControls();
  bindRoomEvents(room);
  try {
    say('Connecting to LiveKit…');
    await room.connect(safeUrl,token,{autoSubscribe:true});
    if (!active || active.room !== room) { await room.disconnect(); return; }
    active.state='connected';
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) attachTrack(room,publication.track,participant,false);
      }
    }
    if (role==='host' || role==='guest') {
      say('Requesting microphone and camera permissions…');
      try { await room.localParticipant.setMicrophoneEnabled(true); active.micEnabled=true; } catch (_) { active.micEnabled=false; say('Microphone permission was not granted. Camera may still be available.',true); }
      try { await room.localParticipant.setCameraEnabled(true); active.cameraEnabled=true; } catch (_) { active.cameraEnabled=false; }
      for (const publication of room.localParticipant.trackPublications.values()) {
        if (publication.track) attachTrack(room,publication.track,room.localParticipant,true);
      }
      if (startAfterConnect) {
        if (!active.micEnabled && !active.cameraEnabled) {
          throw new Error('No microphone or camera track was published. Enable a media device before starting LIVE.');
        }
        await requestJson('/api/live/rooms/'+encodeURIComponent(roomId)+'/start',{method:'POST',body:{}});
        active.state='live';
        say('You are LIVE. Your participant state and room status were recorded by the server.');
        await loadRoomList();
      } else {
        say(active.micEnabled || active.cameraEnabled ? 'Guest media is connected.' : 'Joined as guest. Turn on microphone or camera to publish.');
      }
    } else {
      say('Connected to LIVE as a viewer. Chat and audience interactions are available.');
    }
    updateLocalControls();
    startPolling();
    await Promise.all([refreshChat(),refreshPolls(),refreshQuestions(),refreshGuestRequests()]);
  } catch (error) {
    say(error.message||'Could not connect to LIVE.',true);
    if (active && active.room === room) await leaveActive({closeDialog:false,refresh:true,skipServer:true});
    throw error;
  }
}
async function createHostRoom(form) {
  if (!mustBeSignedIn()) return;
  const title = byId('live-host-title')?.value.trim() || '';
  const category = byId('live-host-category')?.value.trim() || 'General';
  const isPrivate = Boolean(byId('live-host-private')?.checked);
  if (title.length<2) { setSectionStatus('Give your LIVE room a title (at least 2 characters).'); return; }
  const button=byId('live-host-start');
  if(button)button.disabled=true;
  try {
    setSectionStatus('Creating room and requesting a secure host token…');
    const result=await requestJson('/api/live/rooms',{method:'POST',body:{title,category,isPrivate}});
    if(!result.room||!result.livekit)throw new Error('The API did not return a created room and host token.');
    if(form)form.reset();
    await connectRoom({
      roomId:result.room.id,title:result.room.title,token:result.livekit.token,url:result.livekit.url,
      role:'host',isHost:true,privateRoom:isPrivate,startAfterConnect:true
    });
  } catch(error) {
    setSectionStatus(error.message||'Could not start LIVE.');
  } finally { if(button)button.disabled=false; }
}
async function joinRoom(roomData) {
  if (!mustBeSignedIn()) return;
  try {
    const joined=await requestJson('/api/live/rooms/'+encodeURIComponent(roomData.id)+'/join',{method:'POST',body:{}});
    if(!joined.livekit||!joined.livekit.token||!joined.livekit.url)throw new Error('The API did not issue a LiveKit viewer token.');
    await connectRoom({
      roomId:roomData.id,title:roomData.title,token:joined.livekit.token,url:joined.livekit.url,
      role:joined.role||'viewer',isHost:joined.role==='host',privateRoom:Boolean(roomData.isPrivate)
    });
  } catch(error) {
    setSectionStatus(error.message||'Could not join this LIVE room.');
  }
}
async function loadRoomList() {
  if(roomLoadBusy)return;
  roomLoadBusy=true;
  const list=byId('live-room-list');
  try {
    const result=await requestJson('/api/live/rooms');
    const rooms=Array.isArray(result.rooms)?result.rooms:[];
    roomsById.clear();
    rooms.forEach(room=>roomsById.set(room.id,room));
    if(list){
      list.replaceChildren();
      if(!rooms.length){
        const empty=node('div','live-room-empty',result.unavailable
          ?'The LIVE service is temporarily unavailable. No sample rooms are shown.'
          :'No public LIVE rooms are active right now. Create a room to go live.');
        list.append(empty);
      } else {
        rooms.forEach(room=>{
          const card=node('article','live-room-card');
          const header=node('div','live-room-card-header');
          header.append(node('span','live-room-live-dot'),node('span','tiny-label','LIVE NOW'));
          const title=node('h3','',room.title||'LIVE room');
          const host=node('p','',room.host?'@'+room.host.username+' · '+room.host.displayName:'Host profile unavailable');
          const meta=node('div','live-room-meta');
          meta.append(node('span','',room.category||'General'),node('span','',Number(room.viewerCount||0)+' viewers'),node('span','',Number(room.speakerCount||0)+' speakers'));
          const join=node('button','button button-primary button-small','Join LIVE');
          join.type='button';join.addEventListener('click',()=>joinRoom(room));
          card.append(header,title,host,meta,join);
          list.append(card);
        });
      }
    }
    setSectionStatus(rooms.length?rooms.length+' live public room(s) returned from the database.':'No public LIVE rooms are active. Room list is database-backed.');
  } catch(error) {
    if(list){list.replaceChildren(node('div','live-room-empty',error.message||'LIVE rooms are unavailable.'));}
    setSectionStatus('LIVE service unavailable. No fake rooms are shown.');
  } finally {roomLoadBusy=false;}
}
function showChat(messages) {
  const box=byId('live-chat-messages');
  if(!box)return;
  box.replaceChildren();
  if(!messages.length){box.append(node('p','live-room-empty','No chat messages yet. Start the conversation.'));return;}
  messages.forEach(message=>{
    const row=node('div','live-chat-message');
    const name=node('strong','',message.author?.displayName||message.author?.username||'ZUNO member');
    const time=node('time','',displayTime(message.createdAt));
    const body=node('span','',message.body||'');
    row.append(name,time,node('br',''),body);
    box.append(row);
  });
  box.scrollTop=box.scrollHeight;
}
async function refreshChat() {
  if(!active)return;
  const snapshot=active;
  try {
    const result=await requestJson('/api/live/rooms/'+encodeURIComponent(snapshot.roomId)+'/chat');
    if(active!==snapshot)return;
    showChat(Array.isArray(result.messages)?result.messages:[]);
  } catch(error) {
    if(active===snapshot && error.status!==401) say(error.message||'Chat could not be refreshed.',true);
  }
}
async function sendChat(event) {
  event?.preventDefault();
  if(!active || !mustBeSignedIn())return;
  const input=byId('live-chat-input'); const body=input?.value.trim()||'';
  if(!body)return;
  if(input)input.value='';
  try {
    await requestJson('/api/live/rooms/'+encodeURIComponent(active.roomId)+'/chat',{method:'POST',body:{body}});
    await refreshChat();
  } catch(error) {
    if(input && !input.value)input.value=body;
    say(error.message||'Could not send chat message.',true);
  }
}
async function refreshGuestRequests() {
  if(!active)return;
  const snapshot=active;
  try {
    const result=await requestJson('/api/live/rooms/'+encodeURIComponent(snapshot.roomId)+'/guest-requests');
    if(active!==snapshot)return;
    if(!snapshot.isHost){
      const request=result.request||null;
      snapshot.guestRequestState=request?.state||null;
      if(request?.state==='accepted' && snapshot.role==='viewer'){
        say('The host accepted your guest request. Tap “Join as guest” to reconnect with publishing privileges.');
      } else if(request?.state==='rejected' || request?.state==='expired'){
        say('Your guest request was '+request.state+'.');
      }
      updateLocalControls();
      return;
    }
    const list=byId('live-guest-request-list'); if(!list)return;
    list.replaceChildren();
    const requests=Array.isArray(result.requests)?result.requests:[];
    if(!requests.length){list.append(node('div','live-room-empty','No pending guest requests.'));return;}
    requests.forEach(request=>{
      const row=node('div','live-guest-request-row');
      row.append(node('strong','',request.requester?.displayName||request.requester?.username||'Guest'),node('p','',request.requester?.username?'@'+request.requester.username:'Guest account'));
      const actions=node('div','live-guest-request-row-actions');
      const accept=node('button','button button-primary button-small','Accept');
      const reject=node('button','button button-secondary button-small','Reject');
      accept.type='button';reject.type='button';
      accept.addEventListener('click',()=>resolveGuest(request,'accept',accept));
      reject.addEventListener('click',()=>resolveGuest(request,'reject',reject));
      actions.append(accept,reject);row.append(actions);list.append(row);
    });
  } catch(error) {
    if(active===snapshot && snapshot.isHost && error.status!==401) {
      const list=byId('live-guest-request-list');
      if(list){list.replaceChildren(node('p','live-room-empty',error.message||'Guest requests are unavailable.'));}
    }
  }
}
async function resolveGuest(request, action, button) {
  if(!active || !active.isHost)return;
  button.disabled=true;
  try {
    await requestJson('/api/live/rooms/'+encodeURIComponent(active.roomId)+'/guest-requests/'+encodeURIComponent(request.id)+'/'+action,{method:'POST',body:{}});
    say(action==='accept'?'Guest accepted. They will connect using their own authenticated session.':'Guest request rejected.');
    await refreshGuestRequests();
  } catch(error) {
    say(error.message||'Guest request could not be resolved.',true);
  } finally {button.disabled=false;}
}
async function joinAsGuest() {
  if(!active || active.role!=='viewer' || active.guestRequestState!=='accepted')return;
  const roomData={id:active.roomId,title:active.title,isPrivate:active.privateRoom};
  await joinRoom(roomData);
}
function showPolls(polls) {
  const box=byId('live-poll-list'); if(!box)return;
  box.replaceChildren();
  if(!polls.length){box.append(node('p','live-room-empty','No polls have been created in this room.'));return;}
  polls.forEach(poll=>{
    const card=node('article','live-poll-card');
    card.append(node('div','live-poll-question',poll.question));
    const options=node('div','live-poll-options');
    (poll.options||[]).forEach(option=>{
      const button=node('button','live-poll-option');
      button.type='button';
      const label=node('span','',option.label);
      const count=node('strong','',Number(option.votes||0)+' votes');
      button.append(label,count);
      button.disabled=poll.state!=='open'||(poll.closes_at&&new Date(poll.closes_at)<=new Date());
      button.addEventListener('click',()=>votePoll(poll,option,button));
      options.append(button);
    });
    card.append(options);
    card.append(node('small','',poll.state==='open'?'Poll is open':'Poll closed'));
    box.append(card);
  });
}
async function refreshPolls() {
  if(!active)return;
  const snapshot=active;
  try {
    const result=await requestJson('/api/live/rooms/'+encodeURIComponent(snapshot.roomId)+'/polls');
    if(active===snapshot)showPolls(Array.isArray(result.polls)?result.polls:[]);
  } catch(error) {
    if(active===snapshot && error.status!==401) say(error.message||'Polls could not be refreshed.',true);
  }
}
async function votePoll(poll,option,button) {
  if(!active || !getSession())return;
  button.disabled=true;
  try {
    await requestJson('/api/live/polls/'+encodeURIComponent(poll.id)+'/votes',{method:'POST',body:{optionId:option.id}});
    await refreshPolls();say('Vote recorded.');
  } catch(error) {say(error.message||'Vote could not be recorded. You may already have voted.',true);}
  finally {button.disabled=false;}
}
async function createPoll(event) {
  event.preventDefault();
  if(!active || !active.isHost || !mustBeSignedIn())return;
  const question=byId('live-poll-question')?.value.trim()||'';
  const options=(byId('live-poll-options')?.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(question.length<1 || options.length<2 || options.length>8){say('Enter a question and between 2 and 8 options, one per line.',true);return;}
  const button=byId('live-poll-submit');if(button)button.disabled=true;
  try {
    await requestJson('/api/live/rooms/'+encodeURIComponent(active.roomId)+'/polls',{method:'POST',body:{question,options}});
    byId('live-poll-form')?.reset();await refreshPolls();say('Poll published to the room.');
  } catch(error) {say(error.message||'Poll could not be created.',true);}
  finally {if(button)button.disabled=false;}
}
function showQuestions(questions) {
  const list=byId('live-question-list');if(!list)return;
  list.replaceChildren();
  if(!questions.length){list.append(node('p','live-room-empty','No questions yet.'));return;}
  questions.forEach(question=>{
    const row=node('article','live-question-row');
    row.append(node('strong','',question.asker?.displayName||question.asker?.username||'Audience member'));
    row.append(node('p','',question.body));
    row.append(node('small','',question.state||'submitted'));
    if(active?.isHost && ['submitted','selected'].includes(question.state)){
      const actions=node('div','live-question-actions');
      for(const [state,label] of [['selected','Select'],['answered','Answered'],['dismissed','Dismiss']]){
        const button=node('button','button button-secondary button-small',label);button.type='button';
        button.addEventListener('click',()=>resolveQuestion(question,state,button));actions.append(button);
      }
      row.append(actions);
    }
    list.append(row);
  });
}
async function refreshQuestions() {
  if(!active)return;
  const snapshot=active;
  try {
    const result=await requestJson('/api/live/rooms/'+encodeURIComponent(snapshot.roomId)+'/questions');
    if(active===snapshot)showQuestions(Array.isArray(result.questions)?result.questions:[]);
  } catch(error) {
    if(active===snapshot&&error.status!==401)say(error.message||'Questions could not be refreshed.',true);
  }
}
async function askQuestion(event) {
  event.preventDefault();
  if(!active || !mustBeSignedIn())return;
  const input=byId('live-question-input');const body=input?.value.trim()||'';
  if(!body)return;
  try {
    await requestJson('/api/live/rooms/'+encodeURIComponent(active.roomId)+'/questions',{method:'POST',body:{body}});
    if(input)input.value='';
    await refreshQuestions();say('Question sent to the host.');
  } catch(error) {say(error.message||'Question could not be sent.',true);}
}
async function resolveQuestion(question,state,button) {
  if(!active || !active.isHost)return;
  button.disabled=true;
  try {
    await requestJson('/api/live/questions/'+encodeURIComponent(question.id)+'/resolve',{method:'POST',body:{state}});
    await refreshQuestions();say('Question updated to '+state+'.');
  } catch(error) {say(error.message||'Question could not be updated.',true);}
  finally {button.disabled=false;}
}
function startPolling() {
  stopPolling();
  if(!active)return;
  const roomId=active.roomId;
  active.pollTimer=window.setInterval(()=>{
    if(!active||active.roomId!==roomId)return;
    refreshChat();refreshPolls();refreshQuestions();refreshGuestRequests();
  },POLL_MS);
}
function stopPolling(record=active) {
  if(record && record.pollTimer){window.clearInterval(record.pollTimer);record.pollTimer=null;}
}
async function leaveActive({closeDialog=true,refresh=true,skipServer=false}={}) {
  if(!active || closeBusy)return;
  closeBusy=true;
  const record=active;
  record.state='leaving';
  stopPolling(record);
  try {
    if(!skipServer) {
      if(record.isHost) {
        await requestJson('/api/live/rooms/'+encodeURIComponent(record.roomId)+'/end',{method:'POST',body:{}});
      } else {
        await requestJson('/api/live/rooms/'+encodeURIComponent(record.roomId)+'/leave',{method:'POST',body:{}});
      }
    }
  } catch(error) {
    if(!skipServer)say(error.message||'Could not update room state. The client will disconnect.',true);
  } finally {
    try { await record.room.disconnect(); } catch (_) {}
    active=null;
    resetStage();
    if(closeDialog)dialogClose();
    closeBusy=false;
    if(refresh)loadRoomList();
  }
}
async function toggleMic() {
  if(!active || active.role==='viewer')return;
  try {
    active.micEnabled=!active.micEnabled;
    await active.room.localParticipant.setMicrophoneEnabled(active.micEnabled);
    say(active.micEnabled?'Microphone is on.':'Microphone is muted.');
  } catch(error) {
    active.micEnabled=!active.micEnabled;
    say(error.message||'Microphone control failed.',true);
  }
  updateLocalControls();
}
async function toggleCamera() {
  if(!active || active.role==='viewer')return;
  try {
    active.cameraEnabled=!active.cameraEnabled;
    await active.room.localParticipant.setCameraEnabled(active.cameraEnabled);
    say(active.cameraEnabled?'Camera is on.':'Camera is off.');
  } catch(error) {
    active.cameraEnabled=!active.cameraEnabled;
    say(error.message||'Camera control failed.',true);
  }
  updateLocalControls();
}
async function guestButtonClick() {
  if(!active || active.isHost)return;
  if(active.guestRequestState==='accepted'){await joinAsGuest();return;}
  if(!mustBeSignedIn())return;
  try {
    await requestJson('/api/live/rooms/'+encodeURIComponent(active.roomId)+'/guest-requests',{method:'POST',body:{}});
    active.guestRequestState='pending';
    say('Guest request sent to the host. This room does not grant publishing rights until the host accepts.');
    updateLocalControls();
  } catch(error) {say(error.message||'Guest request failed.',true);}
}
function mountDialogControls() {
  if(uiMounted)return;
  uiMounted=true;
  byId('live-host-form')?.addEventListener('submit',event=>{event.preventDefault();createHostRoom(event.currentTarget);});
  byId('live-refresh-rooms')?.addEventListener('click',loadRoomList);
  byId('live-chat-form')?.addEventListener('submit',sendChat);
  byId('live-refresh-chat')?.addEventListener('click',refreshChat);
  byId('live-guest-request')?.addEventListener('click',guestButtonClick);
  byId('live-leave-button')?.addEventListener('click',()=>leaveActive());
  byId('live-room-close')?.addEventListener('click',()=>leaveActive());
  byId('live-mic-toggle')?.addEventListener('click',toggleMic);
  byId('live-camera-toggle')?.addEventListener('click',toggleCamera);
  byId('live-refresh-requests')?.addEventListener('click',refreshGuestRequests);
  byId('live-poll-form')?.addEventListener('submit',createPoll);
  byId('live-refresh-polls')?.addEventListener('click',refreshPolls);
  byId('live-question-form')?.addEventListener('submit',askQuestion);
  byId('live-refresh-questions')?.addEventListener('click',refreshQuestions);
  byId('live-room-dialog')?.addEventListener('cancel',event=>{event.preventDefault();leaveActive();});
  window.addEventListener('zuno:session-change',()=>{if(!getSession()&&active)leaveActive();});
}
export function mountLiveRooms() {
  mountDialogControls();
  loadRoomList();
}
