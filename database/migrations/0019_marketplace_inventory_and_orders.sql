-- Transactional marketplace inventory reservation and provider-confirmed order completion.
alter table public.commerce_orders add column if not exists request_hash text;
alter table public.commerce_orders add column if not exists provider_order_id text;
alter table public.commerce_orders add column if not exists provider_approval_url text;
alter table public.commerce_orders add column if not exists provider_capture_id text;
alter table public.commerce_orders add column if not exists captured_at timestamptz;
create unique index if not exists commerce_orders_provider_order_id_uq on public.commerce_orders(provider_order_id) where provider_order_id is not null;
create unique index if not exists commerce_orders_provider_capture_id_uq on public.commerce_orders(provider_capture_id) where provider_capture_id is not null;
create index if not exists commerce_orders_buyer_created_idx on public.commerce_orders(buyer_id,created_at desc);

create or replace function public.create_marketplace_listing(
 p_listing_id uuid,
 p_seller_profile_id uuid,
 p_title text,
 p_description text,
 p_category text,
 p_price_minor bigint,
 p_quantity integer,
 p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_hash text;
 v_old_hash text;
 v_response jsonb;
 v_listing_id uuid;
begin
 if p_listing_id is null or p_seller_profile_id is null then raise exception 'MARKETPLACE_LISTING_IDENTITY_REQUIRED'; end if;
 if coalesce(length(trim(p_title)),0)<2 or length(p_title)>160 then raise exception 'MARKETPLACE_LISTING_TITLE_INVALID'; end if;
 if coalesce(length(trim(p_category)),0)<2 or length(p_category)>80 then raise exception 'MARKETPLACE_LISTING_CATEGORY_INVALID'; end if;
 if p_description is not null and length(p_description)>4000 then raise exception 'MARKETPLACE_LISTING_DESCRIPTION_INVALID'; end if;
 if p_price_minor is null or p_price_minor<1 or p_price_minor>100000000000 then raise exception 'MARKETPLACE_LISTING_PRICE_INVALID'; end if;
 if p_quantity is null or p_quantity<0 or p_quantity>1000000 then raise exception 'MARKETPLACE_LISTING_QUANTITY_INVALID'; end if;
 if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>180 then raise exception 'MARKETPLACE_LISTING_IDEMPOTENCY_INVALID'; end if;
 v_hash:=md5(trim(p_title)||':'||coalesce(trim(p_description),'')||':'||trim(p_category)||':'||p_price_minor::text||':'||p_quantity::text);
 perform pg_advisory_xact_lock(hashtextextended('marketplace-listing:'||p_seller_profile_id::text||':'||p_idempotency_key,0));
 select request_hash,response_body into v_old_hash,v_response from public.api_idempotency_keys
 where scope='marketplace-listing:'||p_seller_profile_id::text and idempotency_key=p_idempotency_key for update;
 if found then
   if v_old_hash<>v_hash then raise exception 'MARKETPLACE_LISTING_IDEMPOTENCY_CONFLICT'; end if;
   if v_response ? 'listingId' then return (v_response->>'listingId')::uuid; end if;
   raise exception 'MARKETPLACE_LISTING_CREATION_IN_PROGRESS';
 end if;
 insert into public.api_idempotency_keys(scope,idempotency_key,request_hash,state)
 values('marketplace-listing:'||p_seller_profile_id::text,p_idempotency_key,v_hash,'started');
 insert into public.marketplace_listings(id,seller_id,title,description,category,currency,price_minor,status,metadata)
 values(p_listing_id,p_seller_profile_id,trim(p_title),nullif(trim(coalesce(p_description,'')),''),trim(p_category),'USD',p_price_minor,'draft','{}'::jsonb)
 returning id into v_listing_id;
 insert into public.listing_inventory(listing_id,quantity_available,quantity_reserved)
 values(v_listing_id,p_quantity,0);
 update public.api_idempotency_keys set state='completed',response_status=201,
   response_body=jsonb_build_object('listingId',v_listing_id)
 where scope='marketplace-listing:'||p_seller_profile_id::text and idempotency_key=p_idempotency_key;
 return v_listing_id;
end;
$$;
revoke all on function public.create_marketplace_listing(uuid,uuid,text,text,text,bigint,integer,text) from public;
revoke all on function public.create_marketplace_listing(uuid,uuid,text,text,text,bigint,integer,text) from anon;
revoke all on function public.create_marketplace_listing(uuid,uuid,text,text,text,bigint,integer,text) from authenticated;
grant execute on function public.create_marketplace_listing(uuid,uuid,text,text,text,bigint,integer,text) to service_role;

create or replace function public.set_marketplace_listing_state(
 p_listing_id uuid,
 p_seller_profile_id uuid,
 p_state text
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_listing public.marketplace_listings%rowtype;
 v_inventory public.listing_inventory%rowtype;
begin
 if p_state not in ('draft','active','paused','sold_out') then raise exception 'MARKETPLACE_LISTING_STATE_INVALID'; end if;
 select * into v_listing from public.marketplace_listings where id=p_listing_id for update;
 if not found then raise exception 'MARKETPLACE_LISTING_NOT_FOUND'; end if;
 if v_listing.seller_id<>p_seller_profile_id then raise exception 'MARKETPLACE_LISTING_NOT_OWNER'; end if;
 select * into v_inventory from public.listing_inventory where listing_id=p_listing_id for update;
 if p_state='active' and (not found or v_inventory.quantity_available<=v_inventory.quantity_reserved) then
   raise exception 'MARKETPLACE_STOCK_EMPTY';
 end if;
 update public.marketplace_listings set status=p_state,updated_at=now() where id=p_listing_id;
 return p_state;
end;
$$;
revoke all on function public.set_marketplace_listing_state(uuid,uuid,text) from public;
revoke all on function public.set_marketplace_listing_state(uuid,uuid,text) from anon;
revoke all on function public.set_marketplace_listing_state(uuid,uuid,text) from authenticated;
grant execute on function public.set_marketplace_listing_state(uuid,uuid,text) to service_role;

create or replace function public.create_commerce_order(
 p_buyer_profile_id uuid,
 p_items jsonb,
 p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_item jsonb;
 v_listing public.marketplace_listings%rowtype;
 v_inventory public.listing_inventory%rowtype;
 v_lines jsonb:='[]'::jsonb;
 v_listing_id uuid;
 v_quantity integer;
 v_seen uuid[]:='{}'::uuid[];
 v_subtotal bigint:=0;
 v_hash text;
 v_old_hash text;
 v_response jsonb;
 v_order_id uuid;
 v_line jsonb;
begin
 if p_buyer_profile_id is null then raise exception 'MARKETPLACE_BUYER_REQUIRED'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>20 then raise exception 'MARKETPLACE_ORDER_ITEMS_INVALID'; end if;
 if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>180 then raise exception 'MARKETPLACE_ORDER_IDEMPOTENCY_INVALID'; end if;
 v_hash:=md5(p_items::text);
 perform pg_advisory_xact_lock(hashtextextended('commerce-order:'||p_buyer_profile_id::text||':'||p_idempotency_key,0));
 select id,request_hash into v_order_id,v_old_hash from public.commerce_orders
 where idempotency_key='commerce:'||p_buyer_profile_id::text||':'||p_idempotency_key for update;
 if found then
   if v_old_hash is distinct from v_hash then raise exception 'MARKETPLACE_ORDER_IDEMPOTENCY_CONFLICT'; end if;
   return v_order_id;
 end if;

 for v_item in select value from jsonb_array_elements(p_items) loop
   if not (v_item ? 'listingId' and v_item ? 'quantity') then raise exception 'MARKETPLACE_ORDER_ITEMS_INVALID'; end if;
   begin
     v_listing_id:=(v_item->>'listingId')::uuid;
     v_quantity:=(v_item->>'quantity')::integer;
   exception when others then raise exception 'MARKETPLACE_ORDER_ITEMS_INVALID'; end;
   if v_quantity<1 or v_quantity>100 then raise exception 'MARKETPLACE_ITEM_QUANTITY_INVALID'; end if;
   if v_listing_id=any(v_seen) then raise exception 'MARKETPLACE_ORDER_ITEM_DUPLICATE'; end if;
   v_seen:=array_append(v_seen,v_listing_id);
   select * into v_listing from public.marketplace_listings where id=v_listing_id and status='active' for update;
   if not found then raise exception 'MARKETPLACE_LISTING_NOT_ACTIVE'; end if;
   if v_listing.seller_id=p_buyer_profile_id then raise exception 'MARKETPLACE_SELF_PURCHASE_FORBIDDEN'; end if;
   select * into v_inventory from public.listing_inventory where listing_id=v_listing_id for update;
   if not found or v_inventory.quantity_available-v_inventory.quantity_reserved<v_quantity then raise exception 'MARKETPLACE_INVENTORY_UNAVAILABLE'; end if;
   v_subtotal:=v_subtotal+(v_listing.price_minor::bigint*v_quantity::bigint);
   if v_subtotal>9000000000000000 then raise exception 'MARKETPLACE_ORDER_TOTAL_INVALID'; end if;
   v_lines:=v_lines||jsonb_build_array(jsonb_build_object(
     'listingId',v_listing_id,'quantity',v_quantity,'unitPriceMinor',v_listing.price_minor,'sellerId',v_listing.seller_id
   ));
 end loop;
 insert into public.commerce_orders(buyer_id,currency,subtotal_minor,tax_minor,shipping_minor,total_minor,status,idempotency_key,request_hash)
 values(p_buyer_profile_id,'USD',v_subtotal,0,0,v_subtotal,'pending_payment',
   'commerce:'||p_buyer_profile_id::text||':'||p_idempotency_key,v_hash)
 returning id into v_order_id;
 for v_line in select value from jsonb_array_elements(v_lines) loop
   insert into public.commerce_order_items(order_id,listing_id,seller_id,quantity,unit_price_minor,line_total_minor)
   values(v_order_id,(v_line->>'listingId')::uuid,(v_line->>'sellerId')::uuid,(v_line->>'quantity')::integer,
     (v_line->>'unitPriceMinor')::bigint,
     (v_line->>'unitPriceMinor')::bigint*(v_line->>'quantity')::bigint);
   update public.listing_inventory set quantity_reserved=quantity_reserved+(v_line->>'quantity')::integer,updated_at=now()
   where listing_id=(v_line->>'listingId')::uuid;
 end loop;
 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values('commerce-order-created:'||v_order_id::text,'commerce.order.created','commerce_order',v_order_id::text,
   jsonb_build_object('orderId',v_order_id,'buyerProfileId',p_buyer_profile_id,'totalMinor',v_subtotal,'lineCount',jsonb_array_length(v_lines)))
 on conflict(event_key) do nothing;
 return v_order_id;
end;
$$;
revoke all on function public.create_commerce_order(uuid,jsonb,text) from public;
revoke all on function public.create_commerce_order(uuid,jsonb,text) from anon;
revoke all on function public.create_commerce_order(uuid,jsonb,text) from authenticated;
grant execute on function public.create_commerce_order(uuid,jsonb,text) to service_role;

create or replace function public.complete_commerce_order(
 p_order_id uuid,
 p_provider_capture_id text,
 p_capture_amount numeric,
 p_currency text
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_order public.commerce_orders%rowtype;
 v_item public.commerce_order_items%rowtype;
 v_inventory public.listing_inventory%rowtype;
begin
 if coalesce(trim(p_provider_capture_id),'')='' then raise exception 'COMMERCE_CAPTURE_ID_REQUIRED'; end if;
 select * into v_order from public.commerce_orders where id=p_order_id for update;
 if not found then raise exception 'COMMERCE_ORDER_NOT_FOUND'; end if;
 if upper(coalesce(p_currency,''))<>v_order.currency then raise exception 'COMMERCE_CURRENCY_MISMATCH'; end if;
 if round(coalesce(p_capture_amount,0)*100)::bigint<>v_order.total_minor then raise exception 'COMMERCE_CAPTURE_AMOUNT_MISMATCH'; end if;
 if v_order.status='paid' then
   if v_order.provider_capture_id=p_provider_capture_id then return 'paid'; end if;
   raise exception 'COMMERCE_ORDER_ALREADY_PAID';
 end if;
 if v_order.status not in ('pending_payment') then raise exception 'COMMERCE_ORDER_NOT_OPEN'; end if;
 if exists(select 1 from public.commerce_orders where provider_capture_id=p_provider_capture_id and id<>v_order.id) then raise exception 'COMMERCE_CAPTURE_ALREADY_USED'; end if;
 for v_item in select * from public.commerce_order_items where order_id=v_order.id order by listing_id for update loop
   select * into v_inventory from public.listing_inventory where listing_id=v_item.listing_id for update;
   if not found or v_inventory.quantity_reserved<v_item.quantity or v_inventory.quantity_available<v_item.quantity then
     raise exception 'COMMERCE_INVENTORY_RECONCILIATION_REQUIRED';
   end if;
   update public.listing_inventory set
     quantity_available=quantity_available-v_item.quantity,
     quantity_reserved=quantity_reserved-v_item.quantity,
     updated_at=now()
   where listing_id=v_item.listing_id;
   update public.marketplace_listings set status=case when v_inventory.quantity_available-v_item.quantity<=0 then 'sold_out' else status end,updated_at=now()
   where id=v_item.listing_id;
 end loop;
 update public.commerce_orders set status='paid',provider_capture_id=p_provider_capture_id,captured_at=now(),updated_at=now()
 where id=v_order.id;
 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values('commerce-order-paid:'||v_order.id::text,'commerce.order.paid','commerce_order',v_order.id::text,
   jsonb_build_object('orderId',v_order.id,'buyerProfileId',v_order.buyer_id,'captureId',p_provider_capture_id,'totalMinor',v_order.total_minor))
 on conflict(event_key) do nothing;
 return 'paid';
end;
$$;
revoke all on function public.complete_commerce_order(uuid,text,numeric,text) from public;
revoke all on function public.complete_commerce_order(uuid,text,numeric,text) from anon;
revoke all on function public.complete_commerce_order(uuid,text,numeric,text) from authenticated;
grant execute on function public.complete_commerce_order(uuid,text,numeric,text) to service_role;

create or replace function public.cancel_commerce_order(p_order_id uuid,p_buyer_profile_id uuid)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_order public.commerce_orders%rowtype;
 v_item public.commerce_order_items%rowtype;
begin
 select * into v_order from public.commerce_orders where id=p_order_id for update;
 if not found or v_order.buyer_id<>p_buyer_profile_id then raise exception 'COMMERCE_ORDER_NOT_FOUND'; end if;
 if v_order.status='cancelled' then return 'cancelled'; end if;
 if v_order.status<>'pending_payment' or v_order.provider_capture_id is not null then raise exception 'COMMERCE_ORDER_NOT_CANCELLABLE'; end if;
 for v_item in select * from public.commerce_order_items where order_id=v_order.id order by listing_id for update loop
   update public.listing_inventory set quantity_reserved=quantity_reserved-v_item.quantity,updated_at=now()
   where listing_id=v_item.listing_id and quantity_reserved>=v_item.quantity;
   if not found then raise exception 'COMMERCE_INVENTORY_RECONCILIATION_REQUIRED'; end if;
 end loop;
 update public.commerce_orders set status='cancelled',updated_at=now() where id=v_order.id;
 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values('commerce-order-cancelled:'||v_order.id::text,'commerce.order.cancelled','commerce_order',v_order.id::text,
   jsonb_build_object('orderId',v_order.id,'buyerProfileId',v_order.buyer_id))
 on conflict(event_key) do nothing;
 return 'cancelled';
end;
$$;
revoke all on function public.cancel_commerce_order(uuid,uuid) from public;
revoke all on function public.cancel_commerce_order(uuid,uuid) from anon;
revoke all on function public.cancel_commerce_order(uuid,uuid) from authenticated;
grant execute on function public.cancel_commerce_order(uuid,uuid) to service_role;
