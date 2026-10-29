'use strict';
const {test,ok,eq}=require('../../tools/test-harness');
const {normalizeJob,safeCode}=require('../../backend/workers/src/search-index-worker');

test('search index worker validates entity IDs, type and operation before processing',()=>{
 const row={id:'10000000-0000-4000-8000-000000000001',entity_id:'10000000-0000-4000-8000-000000000002',entity_type:'post',operation:'upsert',payload:{ownerId:'10000000-0000-4000-8000-000000000003'},attempts:1};
 eq(normalizeJob(row).entityType,'post');
 eq(normalizeJob({...row,operation:'rebuild'}),null);
 eq(normalizeJob({...row,entity_id:'../profile'}),null);
 eq(normalizeJob({...row,entity_type:'wallet'}),null);
});
test('search index worker does not disclose untrusted provider error messages',()=>{
 eq(safeCode({code:'SEARCH_INDEX_PROVIDER_UNAVAILABLE'}),'SEARCH_INDEX_PROVIDER_UNAVAILABLE');
 eq(safeCode({message:'contains user private text'}),'SEARCH_INDEX_WORKER_FAILED');
});
