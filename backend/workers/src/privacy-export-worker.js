'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storageDefault = require('../../../integrations/supabase/storage');

const PAGE_SIZE = 500;
const MAX_ROWS = 50000;
const MAX_BYTES = 100 * 1024 * 1024;

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function safeCode(error) {
  const code=String(error&&error.code||error&&error.message||'PRIVACY_EXPORT_FAILED');
  return /^[A-Z0-9_:-]{2,100}$/.test(code)?code:'PRIVACY_EXPORT_FAILED';
}
function scrub(value,key='') {
  if (/(^|_)(access_token|refresh_token|client_secret|service_role_key|password|secret|auth_key|p256dh_key|private_key)(_|$)/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map(item=>scrub(item,'')).filter(item=>item!==undefined);
  if (value&&typeof value==='object') {
    const out={};
    for(const [childKey,childValue] of Object.entries(value)) {
      const clean=scrub(childValue,childKey);
      if(clean!==undefined)out[childKey]=clean;
    }
    return out;
  }
  if(typeof value==='string' && /^https?:\/\//i.test(value) && /token=|signature=|auth=/i.test(value)) {
    try {
      const url=new URL(value);
      for(const name of [...url.searchParams.keys()])if(/token|signature|auth|key/i.test(name))url.searchParams.delete(name);
      return url.toString();
    } catch (_) { return '[redacted-signed-url]'; }
  }
  return value;
}
function safeAuthIdentity(value) {
  if(!value||typeof value!=='object')return null;
  const metadata=value.user_metadata&&typeof value.user_metadata==='object'?value.user_metadata:{};
  return scrub({
    id:value.id||null,email:value.email||null,emailConfirmedAt:value.email_confirmed_at||value.confirmed_at||null,
    createdAt:value.created_at||null,lastSignInAt:value.last_sign_in_at||null,phone:value.phone||null,
    userMetadata:{username:metadata.username||null,display_name:metadata.display_name||null}
  });
}
function buildExportDocument({profile,authIdentity,datasets,createdAt=new Date().toISOString()}) {
  return {
    format:'zuno-personal-data-export',
    version:1,
    exportedAt:createdAt,
    profile:scrub(profile||{}),
    authentication:safeAuthIdentity(authIdentity),
    datasets:scrub(datasets||{})
  };
}
function inFilter(ids) {
  return ids.length ? 'in.('+ids.join(',')+')' : null;
}
function commonFilter(field,profileId) { return {[field]:'eq.'+profileId}; }
function orFilter(...parts) { return {or:'('+parts.join(',')+')'}; }

const DIRECT_PLAN = [
  ['roles','roles',p=>commonFilter('profile_id',p)],
  ['follows','follows',p=>orFilter('follower_id.eq.'+p,'followee_id.eq.'+p)],
  ['blocks','blocks',p=>orFilter('blocker_id.eq.'+p,'blocked_id.eq.'+p)],
  ['posts','posts',p=>commonFilter('author_id',p)],
  ['reactions','reactions',p=>commonFilter('profile_id',p)],
  ['comments','comments',p=>commonFilter('author_id',p)],
  ['postBookmarks','post_bookmarks',p=>commonFilter('profile_id',p)],
  ['postReposts','post_reposts',p=>commonFilter('profile_id',p)],
  ['postViews','post_view_events',p=>commonFilter('profile_id',p)],
  ['postShares','post_share_events',p=>commonFilter('profile_id',p)],
  ['feedPreferences','feed_preferences',p=>commonFilter('profile_id',p)],
  ['recommendationFeedback','recommendation_feedback',p=>commonFilter('profile_id',p)],
  ['searchEvents','search_events',p=>commonFilter('profile_id',p)],
  ['mediaAssets','media_assets',p=>commonFilter('uploader_id',p)],
  ['stories','stories',p=>commonFilter('author_id',p)],
  ['storyViews','story_views',p=>commonFilter('viewer_id',p)],
  ['storyReplies','story_replies',p=>commonFilter('author_id',p)],
  ['communityMemberships','community_members',p=>commonFilter('profile_id',p)],
  ['ownedCommunities','communities',p=>commonFilter('owner_id',p)],
  ['communityPosts','community_posts',p=>commonFilter('author_id',p)],
  ['communityPostReactions','community_post_reactions',p=>commonFilter('profile_id',p)],
  ['eventRsvps','community_event_rsvps',p=>commonFilter('profile_id',p)],
  ['hostedEvents','events',p=>commonFilter('host_id',p)],
  ['hostedLiveRooms','live_rooms',p=>commonFilter('host_id',p)],
  ['liveParticipation','live_participants',p=>commonFilter('profile_id',p)],
  ['guestRequests','guest_requests',p=>commonFilter('requester_id',p)],
  ['liveChatMessages','live_chat_messages',p=>commonFilter('author_id',p)],
  ['hostedLivePolls','live_polls',p=>commonFilter('host_id',p)],
  ['livePollVotes','live_poll_votes',p=>commonFilter('voter_id',p)],
  ['liveQuestions','live_questions',p=>commonFilter('asker_id',p)],
  ['giftDeliveries','gift_deliveries',p=>orFilter('sender_profile_id.eq.'+p,'recipient_profile_id.eq.'+p)],
  ['gifterProgress','gifter_progress',p=>commonFilter('profile_id',p)],
  ['paymentOrders','payment_orders',p=>commonFilter('profile_id',p)],
  ['refunds','refund_records',p=>commonFilter('requested_by',p)],
  ['creatorSubscriptions','creator_subscriptions',p=>orFilter('subscriber_id.eq.'+p,'creator_id.eq.'+p)],
  ['creatorSubscriptionTiers','creator_subscription_tiers',p=>commonFilter('creator_id',p)],
  ['creatorEarnings','creator_earnings',p=>commonFilter('creator_id',p)],
  ['payouts','payouts',p=>commonFilter('creator_id',p)],
  ['reportsFiled','reports',p=>commonFilter('reporter_id',p)],
  ['moderationAppeals','moderation_appeals',p=>commonFilter('appellant_id',p)],
  ['privacyConsents','privacy_consents',p=>commonFilter('profile_id',p)],
  ['dataRequests','data_requests',p=>commonFilter('profile_id',p)],
  ['notifications','notifications',p=>commonFilter('profile_id',p)],
  ['notificationPreferences','notification_preferences',p=>commonFilter('profile_id',p)],
  ['marketplaceListings','marketplace_listings',p=>commonFilter('seller_id',p)],
  ['commerceOrders','commerce_orders',p=>commonFilter('buyer_id',p)]
];

function createPrivacyExportWorker(options={}) {
  const env=options.env||process.env;
  const fetcher=options.fetcher||globalThis.fetch;
  const logger=options.logger||console;
  const sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const adapter=options.storageAdapter||storageDefault;
  const workerId=options.workerId||('zuno-privacy-export-'+process.pid);
  const base=String(env.SUPABASE_URL||'').replace(/\/+$/,'');
  const serviceKey=env.SUPABASE_SERVICE_ROLE_KEY||'';
  const bucket=env.SUPABASE_MEDIA_BUCKET||'zuno-media';
  let stopped=false;
  let nextCleanupAt=0;
  async function fetchJson(url,init={}) {
    let response;
    try { response=await fetcher(url,{...init,signal:AbortSignal.timeout(15000)}); }
    catch (_) { throw Object.assign(new Error('SUPABASE_NETWORK_UNAVAILABLE'),{code:'SUPABASE_NETWORK_UNAVAILABLE'}); }
    const text=await response.text();
    let data=null;
    try { data=text?JSON.parse(text):null; } catch (_) {}
    if(!response.ok) {
      const code=response.status===429?'SUPABASE_RATE_LIMIT':response.status>=500?'SUPABASE_UNAVAILABLE':'SUPABASE_REQUEST_REJECTED';
      throw Object.assign(new Error(code),{code,status:response.status});
    }
    return {data,headers:response.headers};
  }
  function headers(extra={}) {
    return {apikey:serviceKey,Authorization:'Bearer '+serviceKey,Accept:'application/json',...extra};
  }
  async function restRows(table,filters={}) {
    const all=[];
    for(let offset=0;offset<MAX_ROWS;offset+=PAGE_SIZE) {
      const params=new URLSearchParams({select:'*'});
      for(const [key,value] of Object.entries(filters)) if(value!==null&&value!==undefined)params.set(key,String(value));
      const url=new URL('/rest/v1/'+encodeURIComponent(table)+'?'+params.toString(),base);
      const result=await fetchJson(url,{headers:headers({Range:offset+'-'+(offset+PAGE_SIZE-1),'Range-Unit':'items'})});
      const page=Array.isArray(result.data)?result.data:[];
      all.push(...page);
      if(all.length>MAX_ROWS)throw Object.assign(new Error('EXPORT_ROW_LIMIT_EXCEEDED'),{code:'EXPORT_ROW_LIMIT_EXCEEDED'});
      if(page.length<PAGE_SIZE) return all;
    }
    throw Object.assign(new Error('EXPORT_ROW_LIMIT_EXCEEDED'),{code:'EXPORT_ROW_LIMIT_EXCEEDED'});
  }
  async function authUser(id) {
    const url=new URL('/auth/v1/admin/users/'+encodeURIComponent(id),base);
    const result=await fetchJson(url,{headers:headers()});
    return result.data&&result.data.user||result.data||null;
  }
  async function rpc(name,payload) {
    const url=new URL('/rest/v1/rpc/'+name,base);
    return (await fetchJson(url,{method:'POST',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify(payload)})).data;
  }
  async function profileExport(profileId) {
    const profiles=await restRows('profiles',{id:'eq.'+profileId,limit:'1'});
    if(!profiles.length)throw Object.assign(new Error('EXPORT_PROFILE_NOT_FOUND'),{code:'EXPORT_PROFILE_NOT_FOUND'});
    const profile=profiles[0];
    const convMembers=await restRows('conversation_members',{profile_id:'eq.'+profileId});
    const conversationIds=[...new Set(convMembers.map(row=>row.conversation_id).filter(uuid))];
    const walletAccounts=await restRows('wallet_accounts',{profile_id:'eq.'+profileId,kind:'eq.user'});
    const accountIds=walletAccounts.map(row=>row.id).filter(uuid);
    const datasets={};
    for(const [name,table,filterFactory] of DIRECT_PLAN) {
      if(name==='dataRequests') {
        datasets[name]=(await restRows(table,filterFactory(profileId))).filter(row=>row.id!==currentRequestId);
      } else {
        datasets[name]=await restRows(table,filterFactory(profileId));
      }
    }
    datasets.conversationMemberships=convMembers;
    datasets.conversations=conversationIds.length?await restRows('conversations',{id:inFilter(conversationIds)}):[];
    datasets.messages=conversationIds.length?await restRows('messages',{conversation_id:inFilter(conversationIds)}):[];
    datasets.messageReactions=await restRows('message_reactions',{profile_id:'eq.'+profileId});
    datasets.messageReadReceipts=await restRows('message_read_receipts',{profile_id:'eq.'+profileId});
    datasets.walletAccounts=walletAccounts;
    datasets.ledgerPostings=accountIds.length?await restRows('ledger_postings',{account_id:inFilter(accountIds)}):[];
    const entryIds=[...new Set(datasets.ledgerPostings.map(row=>row.entry_id).filter(uuid))];
    datasets.ledgerEntries=entryIds.length?await restRows('ledger_entries',{id:inFilter(entryIds)}):[];
    const roomIds=[...new Set([
      ...(datasets.hostedLiveRooms||[]).map(row=>row.id),
      ...(datasets.liveParticipation||[]).map(row=>row.room_id)
    ].filter(uuid))];
    datasets.liveRoomEvents=roomIds.length?await restRows('live_room_events',{room_id:inFilter(roomIds)}):[];
    const notifIds=(datasets.notifications||[]).map(row=>row.id).filter(uuid);
    datasets.notificationDeliveryAttempts=notifIds.length?await restRows('notification_delivery_attempts',{notification_id:inFilter(notifIds)}):[];
    const commerceOrderIds=(datasets.commerceOrders||[]).map(row=>row.id).filter(uuid);
    datasets.commerceOrderItems=commerceOrderIds.length?await restRows('commerce_order_items',{order_id:inFilter(commerceOrderIds)}):[];
    datasets.commerceShipments=commerceOrderIds.length?await restRows('commerce_shipments',{order_id:inFilter(commerceOrderIds)}):[];
    datasets.commerceRefunds=commerceOrderIds.length?await restRows('commerce_refunds',{order_id:inFilter(commerceOrderIds)}):[];
    const authIdentity=profile.auth_user_id?await authUser(profile.auth_user_id):null;
    const profileSafe={...profile};
    delete profileSafe.password;delete profileSafe.auth_secret;
    return buildExportDocument({profile:profileSafe,authIdentity,datasets});
  }
  let currentRequestId=null;
  async function processRequest(row) {
    if(!uuid(row.id)||!uuid(row.profile_id)||row.request_type!=='export')throw Object.assign(new Error('PRIVACY_EXPORT_REQUEST_INVALID'),{code:'PRIVACY_EXPORT_REQUEST_INVALID'});
    currentRequestId=row.id;
    const doc=await profileExport(row.profile_id);
    currentRequestId=null;
    const body=Buffer.from(JSON.stringify(doc,null,2),'utf8');
    if(body.length<=0||body.length>MAX_BYTES)throw Object.assign(new Error('EXPORT_BYTE_LIMIT_EXCEEDED'),{code:'EXPORT_BYTE_LIMIT_EXCEEDED'});
    const digest=crypto.createHash('sha256').update(body).digest('hex');
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'zuno-privacy-'));
    const file=path.join(folder,'export.json');
    const objectPath='privacy-exports/'+row.profile_id+'/'+row.id+'.json';
    try {
      await fs.writeFile(file,body,{flag:'wx',mode:0o600});
      // A prior worker attempt may have uploaded but not completed the DB commit.
      await adapter.deleteObject({supabase:{url:base,serviceRoleKey:serviceKey}},bucket,objectPath,fetcher).catch(()=>{});
      const uploaded=await adapter.uploadObjectFromFile({supabase:{url:base,serviceRoleKey:serviceKey}},bucket,objectPath,file,'application/json',fetcher);
      if(!uploaded.ok)throw Object.assign(new Error(uploaded.code||'EXPORT_STORAGE_UPLOAD_FAILED'),{code:uploaded.code||'EXPORT_STORAGE_UPLOAD_FAILED'});
      await rpc('finish_privacy_export',{
        p_request_id:row.id,p_worker:workerId,p_success:true,p_storage_path:objectPath,
        p_byte_size:body.length,p_sha256:digest,p_error_code:null
      });
      return {ok:true,requestId:row.id,byteSize:body.length,sha256:digest};
    } finally {
      currentRequestId=null;
      await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});
    }
  }
  async function cleanupExpiredExports() {
    const now=new Date().toISOString();
    const expired=await restRows('data_requests',{
      select:'id,profile_id,result_storage_path,result_expires_at',
      request_type:'eq.export',state:'eq.completed',
      result_expires_at:'lt.'+now,result_storage_path:'not.is.null',limit:'100'
    });
    for(const row of expired) {
      const expected='privacy-exports/'+row.profile_id+'/'+row.id+'.json';
      if(!uuid(row.id)||!uuid(row.profile_id)||row.result_storage_path!==expected) {
        logger.error('[zuno-privacy-export] invalid expired object path',row.id,'PRIVACY_EXPORT_PATH_INVALID');
        continue;
      }
      const removed=await adapter.deleteObject({supabase:{url:base,serviceRoleKey:serviceKey}},bucket,expected,fetcher);
      if(!removed.ok&&removed.status!==404) {
        logger.error('[zuno-privacy-export] expired object cleanup failed',row.id,removed.code||'EXPORT_CLEANUP_FAILED');
        continue;
      }
      const url=new URL('/rest/v1/data_requests',base);
      url.searchParams.set('id','eq.'+row.id);
      url.searchParams.set('profile_id','eq.'+row.profile_id);
      url.searchParams.set('request_type','eq.export');
      url.searchParams.set('state','eq.completed');
      await fetchJson(url,{method:'PATCH',headers:headers({'Content-Type':'application/json',Prefer:'return=minimal'}),body:JSON.stringify({
        result_storage_path:null,result_byte_size:null,result_sha256:null,updated_at:new Date().toISOString()
      })});
    }
    return expired.length;
  }
  async function runOne() {
    if(Date.now()>=nextCleanupAt){await cleanupExpiredExports();nextCleanupAt=Date.now()+60000;}
    const result=await rpc('claim_privacy_export',{p_worker:workerId});
    const row=Array.isArray(result)?result[0]:result;
    if(!row||!row.id)return {worked:false};
    try {return {worked:true,...await processRequest(row)};}
    catch(error) {
      const code=safeCode(error);
      try {await rpc('finish_privacy_export',{p_request_id:row.id,p_worker:workerId,p_success:false,p_storage_path:null,p_byte_size:null,p_sha256:null,p_error_code:code});} catch (_) {}
      logger.error('[zuno-privacy-export] processing failed',row.id,code);
      return {worked:true,ok:false,id:row.id,code};
    }
  }
  async function run() {
    if(!base||!serviceKey)throw Object.assign(new Error('PRIVACY_EXPORT_WORKER_NOT_CONFIGURED'),{code:'PRIVACY_EXPORT_WORKER_NOT_CONFIGURED'});
    while(!stopped) {
      let result;
      try {result=await runOne();} catch(error) {logger.error('[zuno-privacy-export] loop error',safeCode(error));result={worked:false};}
      if(!result||!result.worked)await sleep(Number(env.PRIVACY_EXPORT_WORKER_POLL_MS||1500));
    }
  }
  function stop(){stopped=true;}
  return {workerId,runOne,run,stop,processRequest,cleanupExpiredExports};
}
module.exports={createPrivacyExportWorker,safeCode,buildExportDocument,safeAuthIdentity,scrub,DIRECT_PLAN};
