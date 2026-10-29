'use strict';
const http=require('node:http');
const {test,ok}=require('../../tools/test-harness');
const {server}=require('../../backend/api/src/server');
test('API reports bundled gifts through a real HTTP endpoint',async()=>{
  await new Promise((resolve,reject)=>{if(server.listening)return resolve();server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  const response=await new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port,path:'/api/catalog/gifts'},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
    res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)});}catch(e){reject(e);}});
  }).on('error',reject));
  ok(response.status===200,'expected HTTP 200');
  ok(response.body.ok===true,'endpoint returns ok');
  ok(Array.isArray(response.body.gifts)&&response.body.gifts.length>=100,'catalogue returned');
  await new Promise(resolve=>server.close(resolve));
});
