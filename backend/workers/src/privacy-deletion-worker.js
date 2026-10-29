'use strict';

const paypalDefault=require('../../../integrations/paypal');
const storageDefault=require('../../../integrations/supabase/storage');

function uuid(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
function safeCode(error){const value=String(error&&error.code||error&&error.message||'PRIVACY_DELETION_FAILED');return /^[A-Z0-9_:-]{2,100}$/.test(value)?value:'PRIVACY_DELETION_FAILED';}
function normalizeOwnedStoragePath(raw,{profileId,bucket='zuno-media',supabaseUrl}) {
  if(typeof raw!=='string'||!raw||!uuid(profileId))return null;
  let objectPath=null;
  if(!/^https?:\/\//i.test(raw))objectPath=raw;
  else {
    try {
      const url=new URL(raw),base=new URL(supabaseUrl);
      if(url.origin!==base.origin||url.username||url.password)return null;
      const segments=url.pathname.split('/').filter(Boolean);
      if(segments[0]!=='storage'||segments[1]!=='v1'||segments[2]!=='object')return null;
      if(!['sign','public','authenticated'].includes(segments[3])||decodeURIComponent(segments[4]||'')!==bucket)return null;
      objectPath=segments.slice(5).map(decodeURIComponent).join('/');
    } catch(_){return null;}
  }
  if(!objectPath||objectPath.includes('\\')||objectPath.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f]/.test(part)))return null;
  if(objectPath.startsWith('profiles/'+profileId+'/'))return objectPath;
  if(objectPath.startsWith('privacy-exports/'+profileId+'/'))return objectPath;
  return null;
}
function createPrivacyDeletionWorker(options={}) {
  const env=options.env||process.env;
  const fetcher=options.fetcher||globalThis.fetch;
  const logger=options.logger||console;
  const sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const storage=options.storageAdapter||storageDefault;
  const paypal=options.paypalAdapter||paypalDefault;
  const workerId=options.workerId||('zuno-privacy-deletion-'+process.pid);
  const base=String(env.SUPABASE_URL||'').replace(/\/+$/,'');
  const serviceKey=env.SUPABASE_SERVICE_ROLE_KEY||'';
  const bucket=env.SUPABASE_MEDIA_BUCKET||'zuno-media';
  const paypalConfig={env:env.PAYPAL_ENV||'sandbox',clientId:env.PAYPAL_CLIENT_ID||'',clientSecret:env.PAYPAL_CLIENT_SECRET||''};
  let stopped=false;

  async function request(url,init={}) {
    let response;
    try{response=await fetcher(url,{...init,signal:AbortSignal.timeout(15000)});}
    catch(_){throw Object.assign(new Error('PROVIDER_NETWORK_UNAVAILABLE'),{code:'PROVIDER_NETWORK_UNAVAILABLE'});}
    const raw=await response.text();let data=null;
    try{data=raw?JSON.parse(raw):null;}catch(_){}
    if(!response.ok) {
      const code=response.status===404?'RESOURCE_NOT_FOUND':response.status===429?'PROVIDER_RATE_LIMIT':response.status>=500?'PROVIDER_UNAVAILABLE':'PROVIDER_REQUEST_REJECTED';
      throw Object.assign(new Error(code),{code,status:response.status,data});
    }
    return data;
  }
  function headers(extra={}){return {apikey:serviceKey,Authorization:'Bearer '+serviceKey,Accept:'application/json',...extra};}
  function restUrl(table,params=new URLSearchParams(),rpc=false) {
    const url=new URL(rpc?'/rest/v1/rpc/'+table:'/rest/v1/'+table,base);
    if(!rpc)url.search=params.toString();
    return url;
  }
  async function rpc(name,payload){return request(restUrl(name,null,true),{method:'POST',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify(payload)});}
  async function patch(table,filters,payload) {
    const params=new URLSearchParams(filters);
    return request(restUrl(table,params),{method:'PATCH',headers:headers({'Content-Type':'application/json',Prefer:'return=minimal'}),body:JSON.stringify(payload)});
  }
  async function rows(table,params) {
    const query=new URLSearchParams(params);
    const value=await request(restUrl(table,query),{headers:headers()});
    return Array.isArray(value)?value:[];
  }
  async function cancelSubscriptions(profileId) {
    const active=await rows('creator_subscriptions',{
      select:'id,subscriber_id,creator_id,state,provider_subscription_id',
      or:'(subscriber_id.eq.'+profileId+',creator_id.eq.'+profileId+')',
      state:'in.(active,grace)',limit:'250'
    });
    for(const item of active) {
      if(item.provider_subscription_id) {
        const current=await paypal.getBillingSubscription(paypalConfig,item.provider_subscription_id);
        if(!current.ok)throw Object.assign(new Error(current.code||'PAYPAL_SUBSCRIPTION_LOOKUP_FAILED'),{code:current.code||'PAYPAL_SUBSCRIPTION_LOOKUP_FAILED'});
        const status=String(current.status||'').toUpperCase();
        if(!['CANCELLED','EXPIRED'].includes(status)) {
          const cancelled=await paypal.cancelBillingSubscription(paypalConfig,item.provider_subscription_id,'ZUNO account deletion requested');
          if(!cancelled.ok) {
            const confirm=await paypal.getBillingSubscription(paypalConfig,item.provider_subscription_id).catch(()=>({ok:false}));
            const finalStatus=String(confirm.status||'').toUpperCase();
            if(!confirm.ok||!['CANCELLED','EXPIRED'].includes(finalStatus)) {
              throw Object.assign(new Error(cancelled.code||'PAYPAL_SUBSCRIPTION_CANCEL_FAILED'),{code:cancelled.code||'PAYPAL_SUBSCRIPTION_CANCEL_FAILED'});
            }
          }
        }
      }
      await patch('creator_subscriptions',{id:'eq.'+item.id},{state:'cancelled',updated_at:new Date().toISOString()});
    }
    return active.length;
  }
  async function deleteAuthUser(authUserId) {
    if(!uuid(authUserId))return false;
    const url=new URL('/auth/v1/admin/users/'+encodeURIComponent(authUserId),base);
    try {
      await request(url,{method:'DELETE',headers:headers()});
      return true;
    } catch(error) {
      if(error.status===404)return true;
      throw error;
    }
  }
  async function removeOwnedStorageObjects(context) {
    const paths=new Set();
    for(const value of (Array.isArray(context.storagePaths)?context.storagePaths:[])) {
      const path=normalizeOwnedStoragePath(value,{profileId:context.profileId,bucket,supabaseUrl:base});
      if(path)paths.add(path);
    }
    for(const value of [context.avatarUrl,context.coverUrl]) {
      const path=normalizeOwnedStoragePath(value,{profileId:context.profileId,bucket,supabaseUrl:base});
      if(path)paths.add(path);
    }
    for(const objectPath of paths) {
      const result=await storage.deleteObject({supabase:{url:base,serviceRoleKey:serviceKey}},bucket,objectPath,fetcher);
      if(!result.ok&&result.status!==404)throw Object.assign(new Error(result.code||'STORAGE_DELETE_FAILED'),{code:result.code||'STORAGE_DELETE_FAILED'});
    }
    return paths.size;
  }
  async function processRequest(row) {
    if(!uuid(row.id)||!uuid(row.profile_id))throw Object.assign(new Error('PRIVACY_DELETION_REQUEST_INVALID'),{code:'PRIVACY_DELETION_REQUEST_INVALID'});
    const context=await rpc('prepare_privacy_deletion',{p_request_id:row.id,p_worker:workerId});
    if(!context||context.requestId!==row.id||context.profileId!==row.profile_id)throw Object.assign(new Error('PRIVACY_DELETION_CONTEXT_INVALID'),{code:'PRIVACY_DELETION_CONTEXT_INVALID'});
    const objectsRemoved=await removeOwnedStorageObjects(context);
    const subscriptionsCancelled=await cancelSubscriptions(context.profileId);
    const authUserRevoked=await deleteAuthUser(context.authUserId);
    await rpc('finish_privacy_deletion',{p_request_id:row.id,p_worker:workerId,p_success:true,p_error_code:null});
    return {ok:true,requestId:row.id,objectsRemoved,subscriptionsCancelled,authUserRevoked};
  }
  async function runOne() {
    const claimed=await rpc('claim_privacy_deletion',{p_worker:workerId});
    const row=Array.isArray(claimed)?claimed[0]:claimed;
    if(!row||!row.id)return {worked:false};
    try{return {worked:true,...await processRequest(row)};}
    catch(error) {
      const code=safeCode(error);
      try{await rpc('finish_privacy_deletion',{p_request_id:row.id,p_worker:workerId,p_success:false,p_error_code:code});}catch(_){}
      logger.error('[zuno-privacy-deletion] processing failed',row.id,code);
      return {worked:true,ok:false,id:row.id,code};
    }
  }
  async function run() {
    if(!base||!serviceKey)throw Object.assign(new Error('PRIVACY_DELETION_WORKER_NOT_CONFIGURED'),{code:'PRIVACY_DELETION_WORKER_NOT_CONFIGURED'});
    while(!stopped) {
      let result;
      try{result=await runOne();}catch(error){logger.error('[zuno-privacy-deletion] loop error',safeCode(error));result={worked:false};}
      if(!result||!result.worked)await sleep(Number(env.NOTIFICATION_WORKER_POLL_MS||1500));
    }
  }
  function stop(){stopped=true;}
  return {workerId,runOne,run,stop,processRequest,cancelSubscriptions,removeOwnedStorageObjects};
}
module.exports={createPrivacyDeletionWorker,normalizeOwnedStoragePath,safeCode};
