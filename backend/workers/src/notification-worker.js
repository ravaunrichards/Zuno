'use strict';

const crypto=require('node:crypto');
const { validateNotification }=require('../../notifications/src/payload');

const ALLOWED=new Set(['follow','reaction','comment','message','live_started','gift_received','subscription','system','moderation','live_guest_request']);
const TEXT={
 follow:{title:'New follower',body:'Someone followed you on ZUNO.'},
 reaction:{title:'A post got a reaction',body:'Someone reacted to your post.'},
 comment:{title:'New comment',body:'Someone commented on your post.'},
 message:{title:'New message',body:'You received a new message.'},
 live_started:{title:'A creator is LIVE',body:'Someone you follow started a live room.'},
 live_guest_request:{title:'LIVE guest request',body:'Someone requested to join your LIVE room.'},
 gift_received:{title:'You received a gift',body:'Someone sent you a ZUNO gift.'},
 subscription:{title:'New creator subscription',body:'Someone subscribed to your creator membership.'},
 system:{title:'ZUNO update',body:'There is an update in your ZUNO account.'},
 moderation:{title:'Account update',body:'There is an update about a moderation or safety request.'}
};

function safeCode(error) {
 const value=String(error&&error.code||error&&error.message||'NOTIFICATION_WORKER_FAILED');
 return /^[A-Z0-9_:-]{2,100}$/.test(value)?value:'NOTIFICATION_WORKER_FAILED';
}
function isUuid(value) {
 return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function describe(kind){return TEXT[kind]||TEXT.system;}
function target(recipient,kind,payload){
 if(!isUuid(recipient)||!ALLOWED.has(kind))return null;
 return {recipient,kind,payload:payload&&typeof payload==='object'?payload:{}};
}

function createNotificationWorker(options={}) {
 const env=options.env||process.env;
 const fetcher=options.fetcher||globalThis.fetch;
 const logger=options.logger||console;
 const sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const workerId=options.workerId||('zuno-notifications-'+process.pid+'-'+crypto.randomBytes(4).toString('hex'));
 const base=String(env.SUPABASE_URL||'').replace(/\/+$/,'');
 const key=env.SUPABASE_SERVICE_ROLE_KEY||'';
 let stopped=false;
 async function request(path,method='GET',body=null,prefer='return=representation') {
  if(!base||!key)throw Object.assign(new Error('NOTIFICATION_WORKER_NOT_CONFIGURED'),{code:'NOTIFICATION_WORKER_NOT_CONFIGURED'});
  const url=new URL('/rest/v1/'+path,base);
  const headers={apikey:key,Authorization:'Bearer '+key,Accept:'application/json'};
  const init={method,headers,signal:AbortSignal.timeout(12000)};
  if(body!==null){headers['Content-Type']='application/json';headers.Prefer=prefer;init.body=JSON.stringify(body);}
  let response;
  try{response=await fetcher(url,init);}catch(_){throw Object.assign(new Error('SUPABASE_NETWORK_UNAVAILABLE'),{code:'SUPABASE_NETWORK_UNAVAILABLE'});}
  const raw=await response.text();
  let data=null;try{data=raw?JSON.parse(raw):null;}catch(_){data=null;}
  if(!response.ok){
   const msg=data&&typeof data.message==='string'?data.message:'SUPABASE_REST_FAILED';
   const code=/^[A-Z0-9_:-]{2,100}$/.test(msg)?msg:'SUPABASE_REST_FAILED';
   throw Object.assign(new Error(code),{code,status:response.status});
  }
  return data;
 }
 async function rows(table,params={}){return request(table+'?'+new URLSearchParams(params).toString());}
 async function rpc(name,body){return request('rpc/'+name,'POST',body);}
 async function writeNotification(recipient,kind,payload,eventKey){
  if(!isUuid(recipient)||!ALLOWED.has(kind))return null;
  const safePayload=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{};
  const check=validateNotification({kind,recipientProfileId:recipient,payload:safePayload});
  if(!check.ok)throw Object.assign(new Error('NOTIFICATION_PAYLOAD_REJECTED'),{code:'NOTIFICATION_PAYLOAD_REJECTED'});
  const sourceKey=String(eventKey)+':'+recipient;
  const inserted=await request('notifications?on_conflict=source_event_key','POST',{
   profile_id:recipient,kind,payload:safePayload,source_event_key:sourceKey
  },'resolution=ignore-duplicates,return=representation');
  if(Array.isArray(inserted)&&inserted[0])return inserted[0];
  const prior=await rows('notifications',{select:'id,profile_id,kind,payload,created_at,source_event_key',source_event_key:'eq.'+sourceKey,limit:'1'});
  if(prior[0])return prior[0];
  throw Object.assign(new Error('NOTIFICATION_PERSIST_FAILED'),{code:'NOTIFICATION_PERSIST_FAILED'});
 }
 async function targetsForEvent(event){
  const p=event&&event.payload&&typeof event.payload==='object'?event.payload:{};
  const type=String(event&&event.event_type||'');
  if(type==='social.comment.created')return [target(p.recipientProfileId,'comment',{postId:p.postId,commentId:p.commentId,actorProfileId:p.actorProfileId})].filter(Boolean);
  if(type==='social.reaction.created')return [target(p.recipientProfileId,'reaction',{postId:p.postId,reactionId:p.reactionId,actorProfileId:p.actorProfileId,reactionKind:p.reactionKind})].filter(Boolean);
  if(type==='social.follow.created')return [target(p.recipientProfileId,'follow',{actorProfileId:p.actorProfileId})].filter(Boolean);
  if(type==='social.message.created')return [target(p.recipientProfileId,'message',{conversationId:p.conversationId,messageId:p.messageId,actorProfileId:p.actorProfileId})].filter(Boolean);
  if(type==='creator.subscription.created')return [target(p.recipientProfileId,'subscription',{subscriptionId:p.subscriptionId,actorProfileId:p.actorProfileId})].filter(Boolean);
  if(type==='gift.delivered')return [target(p.recipientProfileId,'gift_received',{deliveryId:p.deliveryId,giftId:p.giftId,senderProfileId:p.senderProfileId,priceCoins:p.priceCoins})].filter(Boolean);
  if(type==='live.guest.requested'){
   const rooms=await rows('live_rooms',{select:'id,host_id,state',id:'eq.'+String(p.roomId||''),limit:'1'});
   if(!rooms[0])return [];
   return [target(rooms[0].host_id,'live_guest_request',{roomId:rooms[0].id,requestId:event.aggregate_id,requesterProfileId:p.requesterProfileId})].filter(Boolean);
  }
  if(type==='live.room.started'){
   const rooms=await rows('live_rooms',{select:'id,host_id,is_private,state',id:'eq.'+String(p.roomId||''),limit:'1'});
   if(!rooms[0]||rooms[0].is_private||rooms[0].state!=='live')return [];
   const followers=await rows('follows',{select:'follower_id',followee_id:'eq.'+rooms[0].host_id,limit:'500'});
   return followers.map(item=>target(item.follower_id,'live_started',{roomId:rooms[0].id,hostProfileId:rooms[0].host_id})).filter(Boolean);
  }
  return [];
 }
 async function processEvent(event){
  const targets=await targetsForEvent(event);
  for(const item of targets)await writeNotification(item.recipient,item.kind,item.payload,event.event_key);
  return {createdOrExisting:targets.length};
 }
 async function runOne(){
  const data=await rpc('claim_event_outbox',{p_worker:workerId});
  const event=Array.isArray(data)?data[0]:data;
  if(!event||!event.id)return {worked:false};
  try{
   const result=await processEvent(event);
   await rpc('finish_event_outbox',{p_event_id:event.id,p_worker:workerId,p_succeeded:true,p_error_code:null});
   return {worked:true,ok:true,eventId:event.id,notifications:result.createdOrExisting};
  }catch(error){
   const code=safeCode(error);
   await rpc('finish_event_outbox',{p_event_id:event.id,p_worker:workerId,p_succeeded:false,p_error_code:code}).catch(()=>{});
   logger.error('[zuno-notifications] event failed',event.id,code);
   return {worked:true,ok:false,eventId:event.id,code};
  }
 }
 async function run(){
  if(!base||!key)throw Object.assign(new Error('NOTIFICATION_WORKER_NOT_CONFIGURED'),{code:'NOTIFICATION_WORKER_NOT_CONFIGURED'});
  while(!stopped){
   let result;
   try{result=await runOne();}catch(error){logger.error('[zuno-notifications] worker loop error',safeCode(error));result={worked:false};}
   if(!result||!result.worked)await sleep(Number(env.NOTIFICATION_WORKER_POLL_MS||1500));
  }
 }
 function stop(){stopped=true;}
 return {workerId,runOne,run,stop,processEvent,targetsForEvent,writeNotification};
}
if(require.main===module){
 const worker=createNotificationWorker();
 const shutdown=()=>worker.stop();
 process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 worker.run().catch(error=>{console.error('[zuno-notifications] startup failed',safeCode(error));process.exitCode=1;});
}
module.exports={createNotificationWorker,notificationText:describe,safeErrorCode:safeCode,isUuid,target};
