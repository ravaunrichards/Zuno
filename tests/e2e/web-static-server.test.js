'use strict';
const http=require('node:http');
const path=require('node:path');
const {test,ok,eq}=require('../../tools/test-harness');
const {createStaticServer}=require('../../scripts/serve-static');
test('static web server serves the real homepage with security headers and rejects traversal',async()=>{
 const server=createStaticServer(path.join(__dirname,'..','..','apps','web'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;
 const request=(pathname)=>new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port,path:pathname},res=>{
  let data='';res.setEncoding('utf8');res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));
 }).on('error',reject));
 try{
  const homepage=await request('/index.html');
  eq(homepage.status,200);
  ok(homepage.body.includes('ZUNO — Your world, all in one place'));
  eq(homepage.headers['x-content-type-options'],'nosniff');
  const css=await request('/src/styles/main.css');
  eq(css.status,200);
  ok(css.headers['content-type'].startsWith('text/css'));
  const traversal=await request('/%2e%2e/%2e%2e/.env.example');
  ok(traversal.status===400||traversal.status===403||traversal.status===404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
