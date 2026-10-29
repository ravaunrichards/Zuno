'use strict';
const {test,ok,eq}=require('../../tools/test-harness');
const {quietNow,preferenceAllows,safeCode}=require('../../backend/workers/src/notification-delivery-worker');

test('quiet hours support normal and overnight ranges',()=>{
 ok(quietNow({quiet_hours_start:'22:00',quiet_hours_end:'06:00',timezone:'UTC'},new Date('2026-01-01T23:00:00Z')));
 ok(quietNow({quiet_hours_start:'22:00',quiet_hours_end:'06:00',timezone:'UTC'},new Date('2026-01-01T04:00:00Z')));
 ok(!quietNow({quiet_hours_start:'09:00',quiet_hours_end:'17:00',timezone:'UTC'},new Date('2026-01-01T20:00:00Z')));
});
test('external delivery requires explicit channel and category preferences',()=>{
 ok(preferenceAllows({kind:'message'},{preferences:{push:true,messages:true}},'push'));
 ok(!preferenceAllows({kind:'message'},{preferences:{push:true,messages:false}},'push'));
 ok(!preferenceAllows({kind:'follow'},{preferences:{push:true,creator:false}},'push'));
});
test('delivery errors are safe codes only',()=>{
 eq(safeCode({message:'EMAIL_PROVIDER_UNAVAILABLE'}),'EMAIL_PROVIDER_UNAVAILABLE');
 eq(safeCode({message:'Bearer should-not-leak'}),'NOTIFICATION_PROVIDER_FAILED');
});
