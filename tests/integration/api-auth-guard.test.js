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
    req.on('error',reject);
    req.end('{}');
  });
}

function get(port,path) {
  return new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port,path},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);
      res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(e){reject(e);}});
    });
    req.on('error',reject);
  });
}

test('LIVE token endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/livekit/token');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('feed endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/feed?mode=for-you&limit=12&offset=12');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('gift endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/gifts/send');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('media upload URL endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/media/upload-url');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('media completion endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/media/10000000-0000-4000-8000-000000000001/complete');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('private creator media library endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/media/mine');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('creator post history endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/posts/mine');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('creator analytics endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/creator/analytics');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('admin overview endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/admin/overview');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('moderation queue endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/admin/reports?state=open');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('moderation resolution endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/admin/reports/10000000-0000-4000-8000-000000000001/resolve');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('admin audit endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/admin/audit');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('admin provider readiness endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/admin/integrations');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('conversation creation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/conversations');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('community creation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/communities');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('marketplace listing creation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/marketplace/listings');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('marketplace order creation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/marketplace/orders');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('marketplace capture rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/marketplace/orders/10000000-0000-4000-8000-000000000001/capture');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('search endpoint rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/search?q=zuno&type=all');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('event RSVP rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/events/10000000-0000-4000-8000-000000000001/rsvp');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('payment endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/payments/order');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
 await new Promise((resolve)=>server.close(resolve));
});
