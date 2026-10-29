'use strict';
const {test,ok}=require('../../tools/test-harness');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'../..',p),'utf8');
const api=read('backend/api/src/server.js');
const auth=read('backend/api/src/auth.js');
const migration=read('database/migrations/0030_marketplace_fulfillment_and_tracking.sql');
const ui=read('apps/web/src/features/marketplace/marketplace.js');
const html=read('apps/web/index.html');
test('marketplace fulfillment uses a gated RPC and auditable state transitions',()=>{
  ok(auth.includes("'update_commerce_fulfillment'"));
  ok(auth.includes("'commerce_fulfillment_events'"));
  ok(api.includes("'/api/marketplace/sales'"));
  ok(api.includes("/fulfillment$/i"));
  ok(api.includes("p_seller_profile_id:session.profile.id"));
  ok(migration.includes('for select using(exists(select 1 from public.commerce_orders'));
  ok(migration.includes('commerce_fulfillment_events'));
  ok(migration.includes("grant execute on function public.update_commerce_fulfillment"));
});
test('marketplace UI displays buyer tracking and seller fulfillment controls',()=>{
  ok(ui.includes("order.shipments"));
  ok(ui.includes("function loadSales()"));
  ok(ui.includes("Mark shipped"));
  ok(ui.includes("Mark delivered"));
  ok(html.includes('id="marketplace-sales-list"'));
});
