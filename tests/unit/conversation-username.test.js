'use strict';
const {test,ok}=require('../../tools/test-harness');
const fs=require('node:fs');
const path=require('node:path');
const api=fs.readFileSync(path.join(__dirname,'../../backend/api/src/server.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../../apps/web/src/features/messaging.js'),'utf8');
test('direct messaging accepts a username and resolves it server-side',()=>{
  ok(api.includes("const recipientUsername = typeof body.recipientUsername === 'string'"));
  ok(api.includes("username: 'eq.' + recipientUsername"));
  ok(api.includes("'CONVERSATION_RECIPIENT_NOT_FOUND'"));
  ok(ui.includes("body:{recipientUsername:username,isGroup:false}"));
  ok(!ui.slice(ui.indexOf('async function createConversation(event){'),ui.indexOf('function cleanLiveRoom')).includes('profile UUID'));
});
