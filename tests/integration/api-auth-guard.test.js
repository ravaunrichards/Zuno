'use strict';
const http=require('node:http');
const {test,ok}=require('../../tools/test-harness');
const {server}=require('../../backend/api/src/server');
async function start() {
  if(server.listening) return server.address().port;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server.address().port;
}
function post(port,path) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method:'POST',headers:{'Content-Type':'application/json'}},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);
      res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(e){reject(e);}});
    });
    req.on('error',reject);req.end('{}');
  });
}
test('LIVE token endpoint rejects unauthenticated requests',async()=>{
 const port=await start();const response=await post(port,'/api/livekit/token');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('feed endpoint rejects unauthenticated requests',async()=>{\n const port=await start();const response=await new Promise((resolve,reject)=>http.get({hostname:'127.0.0.1',port,path:'/api/feed?mode=for-you&limit=12&offset=12'},res=>{let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(e){reject(e);}}).on('error',reject);});\n ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');\n});\ntest('gift endpoint rejects unauthenticated requests',async()=>{
 const port=await start();const response=await post(port,'/api/gifts/send');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('payment endpoint rejects unauthenticated requests',async()=>{
 const port=await start();const response=await post(port,'/api/payments/order');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
 await new Promise((resolve)=>server.close(resolve));
});
