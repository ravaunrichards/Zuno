'use strict';
const {test,ok,eq}=require('../../tools/test-harness');
const {buildExportDocument,safeAuthIdentity,scrub,DIRECT_PLAN}=require('../../backend/workers/src/privacy-export-worker');

test('privacy export includes user-owned datasets but strips authentication secrets',()=>{
 const doc=buildExportDocument({
  profile:{id:'10000000-0000-4000-8000-000000000001',username:'zuno_user',auth_user_id:'private-reference'},
  authIdentity:{id:'private-reference',email:'user@example.test',access_token:'should-not-export',refresh_token:'should-not-export',user_metadata:{username:'zuno_user',display_name:'Zuno User',private_note:'omit'}},
  datasets:{walletAccounts:[{id:'wallet-1'}],private:{service_role_key:'no',visible:'yes'}}
 });
 eq(doc.format,'zuno-personal-data-export');
 eq(doc.authentication.email,'user@example.test');
 ok(!('access_token' in doc.authentication));
 ok(!('refresh_token' in doc.authentication));
 ok(!('service_role_key' in doc.datasets.private));
 eq(doc.datasets.private.visible,'yes');
 eq(doc.profile.auth_user_id,'private-reference');
});
test('export plan includes privacy, moderation, commerce, and creator records',()=>{
 const tables=DIRECT_PLAN.map(row=>row[1]);
 for(const table of ['posts','comments','messages','gift_deliveries','payment_orders','refund_records','commerce_orders','privacy_consents','data_requests','notifications']){
  ok(tables.includes(table),'missing export table '+table);
 }
});
test('signed URLs with query credentials are stripped before export',()=>{
 const value=scrub({media_url:'https://storage.example.test/object?token=secret&download=1'});
 ok(!value.media_url.includes('secret'));
 ok(!value.media_url.includes('token='));
});
