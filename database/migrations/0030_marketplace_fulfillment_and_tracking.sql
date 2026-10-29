-- Seller-scoped fulfillment transitions, order tracking and immutable transition history.
alter table public.commerce_shipments
  add column if not exists seller_id uuid references public.profiles(id) on delete restrict,
  add column if not exists updated_at timestamptz not null default now();
alter table public.commerce_shipments drop constraint if exists commerce_shipments_tracking_reference_length;
alter table public.commerce_shipments add constraint commerce_shipments_tracking_reference_length
  check (tracking_reference is null or length(tracking_reference)<=180) not valid;
alter table public.commerce_shipments drop constraint if exists commerce_shipments_carrier_length;
alter table public.commerce_shipments add constraint commerce_shipments_carrier_length
  check (carrier is null or length(carrier)<=100) not valid;
create unique index if not exists commerce_shipments_order_seller_uq
  on public.commerce_shipments(order_id,seller_id) where seller_id is not null;
create index if not exists commerce_shipments_seller_state_idx
  on public.commerce_shipments(seller_id,state,updated_at desc) where seller_id is not null;

create table if not exists public.commerce_fulfillment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  shipment_id uuid not null references public.commerce_shipments(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  from_state text not null check(from_state in ('pending','label_created','in_transit','delivered','lost','returned')),
  to_state text not null check(to_state in ('pending','label_created','in_transit','delivered','lost','returned')),
  carrier text,
  tracking_reference text,
  created_at timestamptz not null default now()
);
create index if not exists commerce_fulfillment_events_order_idx
  on public.commerce_fulfillment_events(order_id,created_at);
create index if not exists commerce_fulfillment_events_seller_idx
  on public.commerce_fulfillment_events(seller_id,created_at desc);
alter table public.commerce_fulfillment_events enable row level security;
revoke all on public.commerce_fulfillment_events from public,anon;
revoke insert,update,delete on public.commerce_shipments from public,anon,authenticated;
grant select on public.commerce_shipments to authenticated,service_role;
grant select on public.commerce_fulfillment_events to authenticated,service_role;
drop policy if exists commerce_shipments_buyer_read on public.commerce_shipments;
create policy commerce_shipments_buyer_read on public.commerce_shipments
for select using(exists(select 1 from public.commerce_orders o where o.id=order_id and o.buyer_id=public.current_profile_id()));
drop policy if exists commerce_shipments_seller_read on public.commerce_shipments;
create policy commerce_shipments_seller_read on public.commerce_shipments
for select using(seller_id=public.current_profile_id());
drop policy if exists commerce_fulfillment_events_party_read on public.commerce_fulfillment_events;
create policy commerce_fulfillment_events_party_read on public.commerce_fulfillment_events
for select using(
 seller_id=public.current_profile_id()
 or exists(select 1 from public.commerce_orders o where o.id=order_id and o.buyer_id=public.current_profile_id())
);

create or replace function public.update_commerce_fulfillment(
 p_order_id uuid,
 p_seller_profile_id uuid,
 p_state text,
 p_carrier text default null,
 p_tracking_reference text default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_order public.commerce_orders%rowtype;
 v_shipment public.commerce_shipments%rowtype;
 v_from text;
 v_carrier text;
 v_tracking text;
 v_seller_count integer;
 v_delivered_count integer;
begin
 if p_order_id is null or p_seller_profile_id is null then raise exception 'COMMERCE_FULFILLMENT_IDENTITY_REQUIRED'; end if;
 if p_state not in ('label_created','in_transit','delivered','lost','returned') then raise exception 'COMMERCE_FULFILLMENT_STATE_INVALID'; end if;
 v_carrier:=nullif(trim(coalesce(p_carrier,'')),'');
 v_tracking:=nullif(trim(coalesce(p_tracking_reference,'')),'');
 if v_carrier is not null and length(v_carrier)>100 then raise exception 'COMMERCE_CARRIER_INVALID'; end if;
 if v_tracking is not null and length(v_tracking)>180 then raise exception 'COMMERCE_TRACKING_REFERENCE_INVALID'; end if;
 if p_state='in_transit' and (v_carrier is null or v_tracking is null) then raise exception 'COMMERCE_TRACKING_REQUIRED'; end if;

 select * into v_order from public.commerce_orders where id=p_order_id for update;
 if not found then raise exception 'COMMERCE_ORDER_NOT_FOUND'; end if;
 if v_order.status not in ('paid','processing','fulfilled') then raise exception 'COMMERCE_ORDER_NOT_FULFILLABLE'; end if;
 if not exists(select 1 from public.commerce_order_items i where i.order_id=p_order_id and i.seller_id=p_seller_profile_id) then
   raise exception 'COMMERCE_SELLER_NOT_ORDER_PARTY';
 end if;
 select * into v_shipment from public.commerce_shipments
   where order_id=p_order_id and seller_id=p_seller_profile_id for update;
 if v_order.status='fulfilled' then
   if found and v_shipment.state=p_state
      and coalesce(v_shipment.carrier,'')=coalesce(v_carrier,coalesce(v_shipment.carrier,''))
      and coalesce(v_shipment.tracking_reference,'')=coalesce(v_tracking,coalesce(v_shipment.tracking_reference,'')) then
     return v_shipment.id;
   end if;
   raise exception 'COMMERCE_ORDER_ALREADY_FULFILLED';
 end if;

 if not found then
   if p_state<>'label_created' then raise exception 'COMMERCE_FULFILLMENT_TRANSITION_INVALID'; end if;
   insert into public.commerce_shipments(order_id,seller_id,carrier,tracking_reference,state,updated_at)
   values(p_order_id,p_seller_profile_id,v_carrier,v_tracking,'label_created',now())
   returning * into v_shipment;
   v_from:='pending';
 else
   v_from:=v_shipment.state;
   if v_from=p_state
      and coalesce(v_shipment.carrier,'')=coalesce(v_carrier,coalesce(v_shipment.carrier,''))
      and coalesce(v_shipment.tracking_reference,'')=coalesce(v_tracking,coalesce(v_shipment.tracking_reference,'')) then
     return v_shipment.id;
   end if;
   if not (
     (v_from='label_created' and p_state='in_transit')
     or (v_from='in_transit' and p_state in ('delivered','lost','returned'))
     or (v_from='lost' and p_state in ('in_transit','returned'))
   ) then raise exception 'COMMERCE_FULFILLMENT_TRANSITION_INVALID'; end if;
   update public.commerce_shipments
   set state=p_state,
       carrier=coalesce(v_carrier,carrier),
       tracking_reference=coalesce(v_tracking,tracking_reference),
       shipped_at=case when p_state='in_transit' then coalesce(shipped_at,now()) else shipped_at end,
       delivered_at=case when p_state='delivered' then coalesce(delivered_at,now()) else delivered_at end,
       updated_at=now()
   where id=v_shipment.id returning * into v_shipment;
 end if;

 insert into public.commerce_fulfillment_events(
   order_id,shipment_id,seller_id,actor_profile_id,from_state,to_state,carrier,tracking_reference
 ) values (
   p_order_id,v_shipment.id,p_seller_profile_id,p_seller_profile_id,v_from,p_state,
   coalesce(v_carrier,v_shipment.carrier),coalesce(v_tracking,v_shipment.tracking_reference)
 );
 if p_state in ('label_created','in_transit','lost','returned') and v_order.status='paid' then
   update public.commerce_orders set status='processing',updated_at=now() where id=p_order_id and status='paid';
 end if;
 select count(distinct seller_id)::integer into v_seller_count from public.commerce_order_items where order_id=p_order_id;
 select count(*)::integer into v_delivered_count from (
   select i.seller_id from public.commerce_order_items i
   join public.commerce_shipments sh on sh.order_id=i.order_id and sh.seller_id=i.seller_id
   where i.order_id=p_order_id group by i.seller_id having bool_and(sh.state='delivered')
 ) delivered;
 if v_seller_count>0 and v_delivered_count=v_seller_count then
   update public.commerce_orders set status='fulfilled',updated_at=now() where id=p_order_id and status in ('paid','processing');
   insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
   values('commerce-order-fulfilled:'||p_order_id::text,'commerce.order.fulfilled','commerce_order',p_order_id::text,
     jsonb_build_object('orderId',p_order_id,'sellerCount',v_seller_count))
   on conflict(event_key) do nothing;
 end if;
 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values('commerce-fulfillment:'||v_shipment.id::text||':'||p_state||':'||extract(epoch from clock_timestamp())::bigint::text,
   'commerce.fulfillment.updated','commerce_shipment',v_shipment.id::text,
   jsonb_build_object('orderId',p_order_id,'shipmentId',v_shipment.id,'sellerProfileId',p_seller_profile_id,'state',p_state))
 on conflict(event_key) do nothing;
 return v_shipment.id;
end;
$$;
revoke all on function public.update_commerce_fulfillment(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.update_commerce_fulfillment(uuid,uuid,text,text,text) to service_role;
