'use strict';
const {test,ok,eq}=require('../../tools/test-harness');
const {notificationText,safeErrorCode,isUuid}=require('../../backend/workers/src/notification-worker');

test('notification titles are fixed templates and unknown kinds have safe fallback',()=>{
 eq(notificationText('gift_received').title,'You received a gift');
 eq(notificationText('unknown').title,'ZUNO update');
});
test('notification error codes never expose bearer credentials',()=>{
 eq(safeErrorCode({message:'SUPABASE_NETWORK_UNAVAILABLE'}),'SUPABASE_NETWORK_UNAVAILABLE');
 eq(safeErrorCode({message:'Bearer very-secret-token'}),'NOTIFICATION_WORKER_FAILED');
});
test('notification routing validates profile identifiers',()=>{
 ok(isUuid('10000000-0000-4000-8000-000000000001'));
 ok(!isUuid('not-a-profile'));
});
