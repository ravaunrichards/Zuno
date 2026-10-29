'use strict';

const { notificationText } = require('./notification-worker');

const CATEGORY_PREF=Object.freeze({
 follow:'creator',reaction:'creator',comment:'creator',message:'messages',
 live_started:'live',live_guest_request:'live',gift_received:'creator',subscription:'creator'
});
function safeCode(error){
 const raw=String(error&&error.code||error&&error.message||'NOTIFICATION_PROVIDER_FAILED');
 return /^[A-Z0-9_:-]{2,100}$/.test(raw)?raw:'NOTIFICATION_PROVIDER_FAILED';
}
function parseTime(value){
 if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))return null;
 const parts=value.split(':').map(Number);return parts[0]*60+parts[1];
}
function quietNow(prefs,now=new Date()){
 const start=parseTime(prefs&&prefs.quiet_hours_start),end=parseTime(prefs&&prefs.quiet_hours_end);
 if(start===null||end===null||start===end)return false;
 const timezone=(prefs&&typeof prefs.timezone==='string'&&prefs.timezone)||'America/Jamaica';
 let parts;
 try{parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);}
 catch(_){parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Jamaica',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);}
 const hour=Number(parts.find(p=>p.type==='hour')?.value||0);
 const minute=Number(parts.find(p=>p.type==='minute')?.value||0);
 const current=hour*60+minute;
 return start<end?current>=start&&current<end:current>=start||current<end;
}
function preferenceAllows(notification,prefs,channel){
 const values=prefs&&typeof prefs.preferences==='object'&&prefs.preferences?prefs.preferences:{};
 if(values[channel]!==true)return false;
 const category=CATEGORY_PREF[notification.kind];
 return !category||values[category]!==false;
}
function createDeliveryWorker(options={}){
 const env=options.env||process.env;
 const fetcher=options.fetcher||globalThis.fetch;
 const logger=options.logger||console;
 const sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const workerId=options.workerId||('zuno-notification-delivery-'+process.pid);
 const base=String(env.SUPABASE_URL||'').replace(/\/+$/,'');
 const serviceKey=env.SUPABASE_SERVICE_ROLE_KEY||'';
 let stopped=false;
 let webPush=null;
 async function request(path,method='GET',body=null,prefer='return=representation',baseUrl=base,headers={}) {
  if(!baseUrl||!serviceKey)throw Object.assign(new Error('NOTIFICATION_WORKER_NOT_CONFIGURED'),{code:'NOTIFICATION_WORKER_NOT_CONFIGURED'});
  const url=new URL(path.startsWith('/auth/v1/')?path:'/rest/v1/'+path,baseUrl);
  const outputHeaders={apikey:serviceKey,Authorization:'Bearer '+serviceKey,Accept:'application/json',...headers};
  const init={method,headers:outputHeaders,signal:AbortSignal.timeout(15000)};
  if(body!==null){outputHeaders['Content-Type']='application/json';outputHeaders.Prefer=prefer;init.body=JSON.stringify(body);}
  let response;
  try{response=await fetcher(url,init);}catch(_){throw Object.assign(new Error('PROVIDER_NETWORK_UNAVAILABLE'),{code:'PROVIDER_NETWORK_UNAVAILABLE'});}
  const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch(_){}
  if(!response.ok){
   const msg=data&&typeof data.message==='string'?data.message:'PROVIDER_REQUEST_FAILED';
   const code=/^[A-Z0-9_:-]{2,100}$/.test(msg)?msg:'PROVIDER_REQUEST_FAILED';
   throw Object.assign(new Error(code),{code,status:response.status});
  }
  return data;
 }
 async function rows(table,params={}){
  return request(table+'?'+new URLSearchParams(params).toString());
 }
 async function rpc(name,body){return request('rpc/'+name,'POST',body);}
 async function finish(row,state,errorCode=null,providerMessageId=null,retryAfter=300){
  return rpc('finish_notification_delivery',{
   p_attempt_id:row.id,p_worker:workerId,p_result_state:state,
   p_provider_message_id:providerMessageId,p_error_code:errorCode,p_retry_after_seconds:retryAfter
  });
 }
 async function getNotification(row){
  const found=await rows('notifications',{select:'id,profile_id,kind,payload,created_at',id:'eq.'+row.notification_id,limit:'1'});
  return found[0]||null;
 }
 async function getPreferences(profileId){
  const found=await rows('notification_preferences',{select:'profile_id,preferences,quiet_hours_start,quiet_hours_end,timezone',profile_id:'eq.'+profileId,limit:'1'});
  return found[0]||{profile_id:profileId,preferences:{}};
 }
 async function getProfile(profileId){
  const found=await rows('profiles',{select:'id,auth_user_id,username,display_name',id:'eq.'+profileId,limit:'1'});
  return found[0]||null;
 }
 function pushClient(){
  if(webPush)return webPush;
  webPush=require('web-push');
  webPush.setVapidDetails(env.WEB_PUSH_VAPID_SUBJECT,env.WEB_PUSH_VAPID_PUBLIC_KEY,env.WEB_PUSH_VAPID_PRIVATE_KEY);
  return webPush;
 }
 async function emailAddress(profile){
  if(!profile||!profile.auth_user_id)return null;
  const authUrl=new URL('/auth/v1/admin/users/'+encodeURIComponent(profile.auth_user_id),base);
  let response;
  try{response=await fetcher(authUrl,{headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,Accept:'application/json'},signal:AbortSignal.timeout(10000)});}
  catch(_){throw Object.assign(new Error('AUTH_EMAIL_LOOKUP_FAILED'),{code:'AUTH_EMAIL_LOOKUP_FAILED'});}
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data)return null;
  const user=data.user||data;
  if(typeof user.email!=='string'||!user.email.includes('@')||!(user.email_confirmed_at||user.confirmed_at))return null;
  return user.email;
 }
 function sameOriginUrl(notificationId){
  try{
   const url=new URL('/',env.APP_BASE_URL||'http://localhost:3000');
   if(url.protocol!=='https:'&&url.hostname!=='localhost'&&url.hostname!=='127.0.0.1')return '/';
   url.searchParams.set('notification',notificationId);
   return url.toString();
  }catch(_){return '/';}
 }
 async function push(notification,profile){
  if(!env.WEB_PUSH_VAPID_PUBLIC_KEY||!env.WEB_PUSH_VAPID_PRIVATE_KEY||!env.WEB_PUSH_VAPID_SUBJECT)return {state:'suppressed',errorCode:'PUSH_PROVIDER_NOT_CONFIGURED'};
  const subscriptions=await rows('push_subscriptions',{select:'id,endpoint,p256dh_key,auth_key',profile_id:'eq.'+profile.id,revoked_at:'is.null',limit:'30'});
  if(!subscriptions.length)return {state:'suppressed',errorCode:'NO_ACTIVE_PUSH_SUBSCRIPTION'};
  const text=notificationText(notification.kind);
  const payload=JSON.stringify({title:text.title,body:text.body,url:sameOriginUrl(notification.id),notificationId:notification.id,kind:notification.kind});
  const client=pushClient();let successes=0;let otherFailures=0;
  for(const sub of subscriptions){
   try{
    await client.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh_key,auth:sub.auth_key}},payload,{TTL:3600,urgency:'normal'});
    successes++;
    await request('push_subscriptions?id=eq.'+sub.id,'PATCH',{last_used_at:new Date().toISOString()});
   }catch(error){
    const code=Number(error&&error.statusCode||0);
    if(code===404||code===410){
     await request('push_subscriptions?id=eq.'+sub.id,'PATCH',{revoked_at:new Date().toISOString()}).catch(()=>{});
    }else otherFailures++;
   }
  }
  if(successes>0)return {state:'sent'};
  if(!otherFailures)return {state:'suppressed',errorCode:'NO_ACTIVE_PUSH_SUBSCRIPTION'};
  throw Object.assign(new Error('PUSH_PROVIDER_UNAVAILABLE'),{code:'PUSH_PROVIDER_UNAVAILABLE'});
 }
 async function email(notification,profile){
  if(!env.RESEND_API_KEY||!env.RESEND_FROM_EMAIL)return {state:'suppressed',errorCode:'EMAIL_PROVIDER_NOT_CONFIGURED'};
  const address=await emailAddress(profile);
  if(!address)return {state:'suppressed',errorCode:'NO_VERIFIED_EMAIL'};
  const text=notificationText(notification.kind),url=sameOriginUrl(notification.id);
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let response;
  try{
   response=await fetcher('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({from:env.RESEND_FROM_EMAIL,to:[address],subject:text.title,text:text.body+' Open ZUNO: '+url,
      html:'<p>'+escape(text.body)+'</p><p><a href="'+escape(url)+'">Open ZUNO</a></p>',
      tags:[{name:'zuno-kind',value:notification.kind}]}),signal:AbortSignal.timeout(15000)
   });
  }catch(_){throw Object.assign(new Error('EMAIL_PROVIDER_UNAVAILABLE'),{code:'EMAIL_PROVIDER_UNAVAILABLE'});}
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error(response.status===429?'EMAIL_PROVIDER_RATE_LIMIT':'EMAIL_PROVIDER_REJECTED'),{code:response.status===429?'EMAIL_PROVIDER_RATE_LIMIT':'EMAIL_PROVIDER_REJECTED'});
  return {state:'sent',providerMessageId:result&&typeof result.id==='string'?result.id:null};
 }
 async function process(row){
  const notification=await getNotification(row);
  if(!notification)return {state:'suppressed',errorCode:'NOTIFICATION_NOT_FOUND'};
  const profile=await getProfile(notification.profile_id);
  if(!profile)return {state:'suppressed',errorCode:'RECIPIENT_PROFILE_NOT_FOUND'};
  const prefs=await getPreferences(profile.id);
  if(!preferenceAllows(notification,prefs,row.channel))return {state:'suppressed',errorCode:'DISABLED_BY_PREFERENCE'};
  if(quietNow(prefs))return {state:'deferred',retryAfter:300};
  if(row.channel==='push')return push(notification,profile);
  if(row.channel==='email')return email(notification,profile);
  return {state:'suppressed',errorCode:'CHANNEL_UNSUPPORTED'};
 }
 async function runOne(){
  const claimed=await rpc('claim_notification_delivery',{p_worker:workerId});
  const row=Array.isArray(claimed)?claimed[0]:claimed;
  if(!row||!row.id)return {worked:false};
  try{
   const result=await process(row);
   await finish(row,result.state,result.errorCode||null,result.providerMessageId||null,result.retryAfter||300);
   return {worked:true,ok:true,id:row.id,state:result.state};
  }catch(error){
   const code=safeCode(error);
   try{await finish(row,'failed',code,null,300);}catch(_){}
   logger.error('[zuno-delivery] attempt failed',row.id,code);
   return {worked:true,ok:false,id:row.id,code};
  }
 }
 async function run(){
  if(!base||!serviceKey)throw Object.assign(new Error('NOTIFICATION_WORKER_NOT_CONFIGURED'),{code:'NOTIFICATION_WORKER_NOT_CONFIGURED'});
  while(!stopped){
   let result;
   try{result=await runOne();}catch(error){logger.error('[zuno-delivery] worker loop error',safeCode(error));result={worked:false};}
   if(!result||!result.worked)await sleep(Number(env.NOTIFICATION_WORKER_POLL_MS||1500));
  }
 }
 function stop(){stopped=true;}
 return {workerId,runOne,run,stop,process};
}
module.exports={createDeliveryWorker,quietNow,preferenceAllows,safeCode};
