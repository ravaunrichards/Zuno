'use strict';
const {test,ok}=require('../../tools/test-harness');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../apps/desktop/main.cjs'),'utf8');
test('Electron navigation is restricted to the bundled document and safe external HTTPS',()=>{
  ok(source.includes("normalizedPath === ownDocumentUrl"));
  ok(source.includes("target.protocol === 'https:'"));
  ok(source.includes("shell.openExternal(target.toString())"));
  ok(!source.includes("url.startsWith('file://') || url.startsWith('http://localhost:')"));
});
