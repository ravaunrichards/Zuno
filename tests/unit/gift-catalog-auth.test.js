'use strict';
const {test,ok}=require('../../tools/test-harness');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../../apps/web/src/features/gifts/catalog.js'),'utf8');
test('gift sender imports the same session accessor used by its sign-in guard',()=>{
  ok(source.includes("import { getSession } from '../auth/session.js';"));
  ok(source.includes("if(!getSession())"));
  ok(source.includes("recipientUsername:username"));
  ok(source.includes("'Idempotency-Key':key"));
});
