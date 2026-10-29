'use strict';
const {test,ok,eq}=require('../../tools/test-harness');
const {normalizeOwnedStoragePath,safeCode}=require('../../backend/workers/src/privacy-deletion-worker');
const profileId='10000000-0000-4000-8000-000000000001';
const base='https://project.example.test';

test('privacy deletion only removes objects within the account or export namespace',()=>{
  eq(normalizeOwnedStoragePath('profiles/'+profileId+'/avatar.webp',{profileId,bucket:'zuno-media',supabaseUrl:base}),'profiles/'+profileId+'/avatar.webp');
  eq(normalizeOwnedStoragePath('privacy-exports/'+profileId+'/export.json',{profileId,bucket:'zuno-media',supabaseUrl:base}),'privacy-exports/'+profileId+'/export.json');
  eq(normalizeOwnedStoragePath('profiles/10000000-0000-4000-8000-000000000002/avatar.webp',{profileId,bucket:'zuno-media',supabaseUrl:base}),null);
  eq(normalizeOwnedStoragePath('../other-user/file.webp',{profileId,bucket:'zuno-media',supabaseUrl:base}),null);
});
test('privacy deletion only accepts known same-project URLs and strips signed query strings',()=>{
  const raw='https://project.example.test/storage/v1/object/sign/zuno-media/profiles/'+profileId+'/avatar.webp?token=signed-secret';
  eq(normalizeOwnedStoragePath(raw,{profileId,bucket:'zuno-media',supabaseUrl:base}),'profiles/'+profileId+'/avatar.webp');
  eq(normalizeOwnedStoragePath('https://evil.example.test/storage/v1/object/sign/zuno-media/profiles/'+profileId+'/avatar.webp',{profileId,bucket:'zuno-media',supabaseUrl:base}),null);
});
test('privacy deletion errors use safe stable codes',()=>{
  eq(safeCode({code:'PAYPAL_SUBSCRIPTION_CANCEL_FAILED'}),'PAYPAL_SUBSCRIPTION_CANCEL_FAILED');
  eq(safeCode({message:'arbitrary response may contain personal data'}),'PRIVACY_DELETION_FAILED');
});
