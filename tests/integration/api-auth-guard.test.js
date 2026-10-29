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

function del(port,path) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method:'DELETE'},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);
      res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(e){reject(e);}});
    });
    req.on('error',reject);
    req.end();
  });
}
function patch(port,path) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method:'PATCH',headers:{'Content-Type':'application/json'}},res=>{
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

test('block, mute and restrict lists reject unauthenticated access',async()=>{
 for(const kind of ['blocks','mutes','restrictions']){
  const response=await get(await start(),'/api/relationships/'+kind);
  ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
 }
});
test('block, mute and restrict mutations reject unauthenticated access',async()=>{
 for(const kind of ['blocks','mutes','restrictions']){
  const response=await post(await start(),'/api/relationships/'+kind);
  ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
 }
});
test('profile settings endpoint rejects unauthenticated reads and updates',async()=>{
 const read=await get(await start(),'/api/profile/me');
 ok(read.status===401);ok(read.body.code==='AUTH_REQUIRED');
 const update=await patch(await start(),'/api/profile/me');
 ok(update.status===401);ok(update.body.code==='AUTH_REQUIRED');
});
test('privacy consent and data-rights endpoints reject unauthenticated access',async()=>{
 const port=await start();
 const consent=await post(port,'/api/privacy/consents');
 ok(consent.status===401);ok(consent.body.code==='AUTH_REQUIRED');
 const requests=await get(port,'/api/privacy/data-requests');
 ok(requests.status===401);ok(requests.body.code==='AUTH_REQUIRED');
});
test('notification preference endpoints reject unauthenticated access',async()=>{
 const port=await start();
 const read=await get(port,'/api/notifications/preferences');
 ok(read.status===401);ok(read.body.code==='AUTH_REQUIRED');
 const update=await patch(port,'/api/notifications/preferences');
 ok(update.status===401);ok(update.body.code==='AUTH_REQUIRED');
});
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
test('notification preferences reject unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/notifications/preferences');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('privacy data requests reject unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/privacy/data-requests');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('privacy consent changes reject unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/privacy/consents');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('content reports reject unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/reports');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('moderation appeals reject unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/moderation/appeals');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('creator subscriber dashboard rejects unauthenticated requests',async()=>{
 const response=await get(await start(),'/api/creator/subscriptions');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('creator tier creation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/creator/subscription-tiers');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('creator subscription creation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/creator-subscriptions');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('creator subscription cancellation rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/creator-subscriptions/10000000-0000-4000-8000-000000000001/cancel');
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
test('community channel listing requires authentication',async()=>{
 const response=await get(await start(),'/api/communities/10000000-0000-4000-8000-000000000001/channels');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('community channel creation requires authentication',async()=>{
 const response=await post(await start(),'/api/communities/10000000-0000-4000-8000-000000000001/channels');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('call creation requires authentication',async()=>{
 const response=await post(await start(),'/api/calls');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('call join requires authentication',async()=>{
 const response=await post(await start(),'/api/calls/10000000-0000-4000-8000-000000000001/join');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('message reaction requires authentication',async()=>{
 const response=await post(await start(),'/api/messages/10000000-0000-4000-8000-000000000001/reactions');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('post reactions require authentication',async()=>{
 const port=await start();
 const read=await get(port,'/api/posts/10000000-0000-4000-8000-000000000001/reactions');
 ok(read.status===401);ok(read.body.code==='AUTH_REQUIRED');
 const create=await post(port,'/api/posts/10000000-0000-4000-8000-000000000001/reactions');
 ok(create.status===401);ok(create.body.code==='AUTH_REQUIRED');
 const remove=await del(port,'/api/posts/10000000-0000-4000-8000-000000000001/reactions');
 ok(remove.status===401);ok(remove.body.code==='AUTH_REQUIRED');
});
test('post bookmarks and reposts require authentication',async()=>{
 const port=await start();
 for(const path of ['/api/posts/10000000-0000-4000-8000-000000000001/bookmark','/api/posts/10000000-0000-4000-8000-000000000001/repost']){
  const create=await post(port,path);ok(create.status===401);ok(create.body.code==='AUTH_REQUIRED');
  const remove=await del(port,path);ok(remove.status===401);ok(remove.body.code==='AUTH_REQUIRED');
 }
 const list=await get(port,'/api/bookmarks');ok(list.status===401);ok(list.body.code==='AUTH_REQUIRED');
});
test('post share and view telemetry require authentication',async()=>{
 const port=await start();
 const share=await post(port,'/api/posts/10000000-0000-4000-8000-000000000001/share');
 ok(share.status===401);ok(share.body.code==='AUTH_REQUIRED');
 const view=await post(port,'/api/posts/10000000-0000-4000-8000-000000000001/view');
 ok(view.status===401);ok(view.body.code==='AUTH_REQUIRED');
});
test('post comments list requires authentication',async()=>{
 const response=await get(await start(),'/api/posts/10000000-0000-4000-8000-000000000001/comments');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
});
test('story feed and creation require authentication',async()=>{
 const port=await start();
 const read=await get(port,'/api/stories');ok(read.status===401);ok(read.body.code==='AUTH_REQUIRED');
 const create=await post(port,'/api/stories');ok(create.status===401);ok(create.body.code==='AUTH_REQUIRED');
});
test('story view, reply and deletion require authentication',async()=>{
 const port=await start();
 const base='/api/stories/10000000-0000-4000-8000-000000000001';
 const view=await post(port,base+'/view');ok(view.status===401);ok(view.body.code==='AUTH_REQUIRED');
 const reply=await post(port,base+'/replies');ok(reply.status===401);ok(reply.body.code==='AUTH_REQUIRED');
 const remove=await del(port,base);ok(remove.status===401);ok(remove.body.code==='AUTH_REQUIRED');
});
test('feed preferences GET and PATCH require authentication',async()=>{
 const port=await start();
 const read=await get(port,'/api/feed/preferences');ok(read.status===401);ok(read.body.code==='AUTH_REQUIRED');
 const update=await patch(port,'/api/feed/preferences');ok(update.status===401);ok(update.body.code==='AUTH_REQUIRED');
});
test('payment endpoint rejects unauthenticated requests',async()=>{
 const response=await post(await start(),'/api/payments/order');
 ok(response.status===401);ok(response.body.code==='AUTH_REQUIRED');
 await new Promise((resolve)=>server.close(resolve));
});
