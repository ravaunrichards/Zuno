'use strict';

const crypto=require('node:crypto');

function safeCode(error) {
  const value=String(error&&error.code||error&&error.message||'SEARCH_INDEX_WORKER_FAILED');
  return /^[A-Z0-9_:-]{2,100}$/.test(value)?value:'SEARCH_INDEX_WORKER_FAILED';
}
function normalizeJob(row) {
  if(!row||typeof row!=='object')return null;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(!uuid.test(String(row.id||''))||!uuid.test(String(row.entity_id||'')))return null;
  if(!['profile','post','community','event'].includes(row.entity_type))return null;
  if(!['upsert','delete'].includes(row.operation))return null;
  if(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload))return null;
  return {id:row.id,entityId:row.entity_id,entityType:row.entity_type,operation:row.operation,payload:row.payload,attempts:Number(row.attempts||0)};
}
function createSearchIndexWorker(options={}) {
  const env=options.env||process.env;
  const fetcher=options.fetcher||globalThis.fetch;
  const logger=options.logger||console;
  const sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const workerId=options.workerId||('zuno-search-index-'+process.pid+'-'+crypto.randomBytes(4).toString('hex'));
  const base=String(env.SUPABASE_URL||'').replace(/\/+$/,'');
  const key=env.SUPABASE_SERVICE_ROLE_KEY||'';
  let stopped=false;

  async function rpc(name,payload) {
    if(!base||!key)throw Object.assign(new Error('SEARCH_INDEX_WORKER_NOT_CONFIGURED'),{code:'SEARCH_INDEX_WORKER_NOT_CONFIGURED'});
    const url=new URL('/rest/v1/rpc/'+name,base);
    let response;
    try {
      response=await fetcher(url,{
        method:'POST',
        headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify(payload),
        signal:AbortSignal.timeout(15000)
      });
    } catch(_) {
      throw Object.assign(new Error('SEARCH_INDEX_PROVIDER_UNAVAILABLE'),{code:'SEARCH_INDEX_PROVIDER_UNAVAILABLE'});
    }
    const raw=await response.text();
    let data=null;try{data=raw?JSON.parse(raw):null;}catch(_){}
    if(!response.ok) {
      const code=response.status===429?'SUPABASE_RATE_LIMIT':response.status>=500?'SUPABASE_UNAVAILABLE':'SEARCH_INDEX_RPC_REJECTED';
      throw Object.assign(new Error(code),{code,status:response.status});
    }
    return data;
  }
  async function runOne() {
    const claimed=await rpc('claim_search_index_job',{p_worker:workerId});
    const raw=Array.isArray(claimed)?claimed[0]:claimed;
    if(!raw||!raw.id)return {worked:false};
    const job=normalizeJob(raw);
    if(!job) {
      try{await rpc('finish_search_index_job',{p_job_id:raw.id,p_worker:workerId,p_success:false,p_error_code:'SEARCH_INDEX_JOB_INVALID'});}catch(_){}
      return {worked:true,ok:false,code:'SEARCH_INDEX_JOB_INVALID'};
    }
    try {
      const state=await rpc('finish_search_index_job',{p_job_id:job.id,p_worker:workerId,p_success:true,p_error_code:null});
      return {worked:true,ok:true,jobId:job.id,entityType:job.entityType,operation:job.operation,state};
    } catch(error) {
      const code=safeCode(error);
      try{await rpc('finish_search_index_job',{p_job_id:job.id,p_worker:workerId,p_success:false,p_error_code:code});}catch(_){}
      logger.error('[zuno-search-index] job failed',job.id,code);
      return {worked:true,ok:false,jobId:job.id,code};
    }
  }
  async function run() {
    if(!base||!key)throw Object.assign(new Error('SEARCH_INDEX_WORKER_NOT_CONFIGURED'),{code:'SEARCH_INDEX_WORKER_NOT_CONFIGURED'});
    while(!stopped) {
      let result;
      try{result=await runOne();}catch(error){logger.error('[zuno-search-index] loop error',safeCode(error));result={worked:false};}
      if(!result||!result.worked)await sleep(Number(env.SEARCH_INDEX_WORKER_POLL_MS||1200));
    }
  }
  function stop(){stopped=true;}
  return {workerId,runOne,run,stop};
}
module.exports={createSearchIndexWorker,normalizeJob,safeCode};
