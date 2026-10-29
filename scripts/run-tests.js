'use strict';
/** Discovers and runs zero-dependency tests, optionally restricted to a named suite. */
const fs=require('node:fs');
const path=require('node:path');
const harness=require('../tools/test-harness');
const ROOT=path.join(__dirname,'..','tests');
const SUITES={
  unit:['unit'],
  integration:['integration'],
  e2e:['e2e'],
  security:['security'],
  payments:['payments'],
  accessibility:['accessibility']
};
const requested=process.argv[2]||'all';
if(requested!=='all'&&!SUITES[requested]){
  console.error('Unknown test suite: '+requested+'. Allowed: '+Object.keys(SUITES).join(', ')+', all');
  process.exit(2);
}
function walk(dir,acc=[]){
  if(!fs.existsSync(dir))return acc;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())walk(full,acc);
    else if(entry.name.endsWith('.test.js'))acc.push(full);
  }
  return acc;
}
(async()=>{
  let files=walk(ROOT).sort();
  if(requested!=='all'){
    const allowed=SUITES[requested];
    files=files.filter((file)=>allowed.some((suite)=>file.startsWith(path.join(ROOT,suite)+path.sep)));
  }
  if(files.length===0){
    console.error('No tests found for suite "'+requested+'". This is not a passing verification result.');
    process.exit(1);
  }
  console.log('Loading '+files.length+' test file(s) for '+requested+':');
  for(const file of files){console.log('  '+path.relative(path.join(__dirname,'..'),file));require(file);}
  const result=await harness.run();
  if(result.fail>0)process.exit(1);
})().catch((error)=>{console.error(error);process.exit(1);});
