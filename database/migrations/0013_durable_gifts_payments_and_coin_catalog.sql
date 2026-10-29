-- ZUNO durable checkout, wallet crediting and atomic gift delivery.
alter table public.payment_orders add column if not exists provider_approval_url text;

-- Authoritative initial recharge catalog. These are product price settings, not sample customer data.
insert into public.coin_packages(id,coins,amount_usd,enabled,sort_order)
values
 ('z_coins_60',60,0.99,true,10),
 ('z_coins_300',300,4.99,true,20),
 ('z_coins_980',980,14.99,true,30),
 ('z_coins_1980',1980,29.99,true,40),
 ('z_coins_3280',3280,49.99,true,50),
 ('z_coins_6600',6600,99.99,true,60),
 ('z_coins_16500',16500,249.99,true,70),
 ('z_coins_33000',33000,499.99,true,80)
on conflict(id) do update set coins=excluded.coins,amount_usd=excluded.amount_usd,
  enabled=excluded.enabled,sort_order=excluded.sort_order,updated_at=now();

-- Versioned 50/50 revenue rule. This records split policy; it does not invent
-- a coin-to-cash exchange rate. Gift cash earnings remain unavailable until a
-- separately approved FX policy can value consumed virtual coins.
update public.creator_earning_policies set state='retired'
where state='active' and policy_version<>'v1-2026';
insert into public.creator_earning_policies(
 policy_version,creator_share_basis_points,platform_share_basis_points,split_basis,state,effective_from
) values('v1-2026',5000,5000,'gross','active',now())
on conflict(policy_version) do update set
 creator_share_basis_points=excluded.creator_share_basis_points,
 platform_share_basis_points=excluded.platform_share_basis_points,
 split_basis=excluded.split_basis,
 state='active',
 effective_until=null;

-- Every new Auth profile receives its own user wallet. The trigger is server-owned.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp as $$
declare
  v_username text;
  v_display_name text;
  v_profile_id uuid;
begin
  v_username:=lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username',''), '[^a-z0-9_.]', '', 'g'));
  v_display_name:=left(trim(coalesce(new.raw_user_meta_data->>'display_name','')),80);
  if v_username !~ '^[a-z0-9_.]{3,30}$'
     or exists(select 1 from public.profiles p where p.username=v_username) then
    v_username:='user_'||left(replace(new.id::text,'-',''),25);
  end if;
  insert into public.profiles(auth_user_id,username,display_name,visibility)
  values(new.id,v_username,nullif(v_display_name,''),'public')
  on conflict(auth_user_id) do update set auth_user_id=excluded.auth_user_id
  returning id into v_profile_id;
  insert into public.roles(profile_id,role) values(v_profile_id,'user')
  on conflict(profile_id,role) do nothing;
  insert into public.wallet_accounts(profile_id,kind) values(v_profile_id,'user')
  on conflict(profile_id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public;

create or replace function public.deliver_gift(
 p_sender_profile_id uuid,
 p_recipient_profile_id uuid,
 p_gift_id text,
 p_live_room_id uuid,
 p_message text,
 p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_existing public.gift_deliveries%rowtype;
 v_gift public.gift_definitions%rowtype;
 v_sender_account uuid;
 v_recipient_account uuid;
 v_entry_id uuid;
 v_delivery_id uuid;
 v_sender_level smallint;
begin
 if p_sender_profile_id is null or p_recipient_profile_id is null or p_gift_id is null then
   raise exception 'GIFT_REQUEST_INVALID';
 end if;
 if p_sender_profile_id=p_recipient_profile_id then raise exception 'SELF_GIFT_FORBIDDEN'; end if;
 if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>220 then
   raise exception 'GIFT_IDEMPOTENCY_KEY_INVALID';
 end if;
 if p_message is not null and length(p_message)>240 then raise exception 'GIFT_MESSAGE_TOO_LONG'; end if;

 select * into v_existing from public.gift_deliveries where idempotency_key=p_idempotency_key;
 if found then
   if v_existing.sender_profile_id<>p_sender_profile_id
      or v_existing.recipient_profile_id<>p_recipient_profile_id
      or v_existing.gift_id<>p_gift_id
      or v_existing.live_room_id is distinct from p_live_room_id then
     raise exception 'GIFT_IDEMPOTENCY_CONFLICT';
   end if;
   return v_existing.id;
 end if;

 select * into v_gift from public.gift_definitions where id=p_gift_id;
 if not found then raise exception 'UNKNOWN_GIFT'; end if;

 select coalesce(gp.level,0)::smallint into v_sender_level
 from public.profiles p left join public.gifter_progress gp on gp.profile_id=p.id
 where p.id=p_sender_profile_id;
 if not found then raise exception 'SENDER_NOT_FOUND'; end if;
 if not exists(select 1 from public.profiles where id=p_recipient_profile_id) then raise exception 'RECIPIENT_NOT_FOUND'; end if;
 if v_gift.unlock_rule='level>=5' and v_sender_level<5 then raise exception 'GIFT_LOCKED'; end if;
 if v_gift.unlock_rule='level>=15' and v_sender_level<15 then raise exception 'GIFT_LOCKED'; end if;
 if v_gift.unlock_rule not in ('none','level>=5','level>=15') then raise exception 'GIFT_UNLOCK_RULE_UNSUPPORTED'; end if;

 if p_live_room_id is not null then
   if not exists(select 1 from public.live_rooms r where r.id=p_live_room_id and r.state='live') then raise exception 'LIVE_ROOM_NOT_ACTIVE'; end if;
   if not (
     exists(select 1 from public.live_rooms r where r.id=p_live_room_id and r.host_id=p_sender_profile_id)
     or exists(select 1 from public.live_participants lp where lp.room_id=p_live_room_id and lp.profile_id=p_sender_profile_id and lp.left_at is null)
   ) then raise exception 'SENDER_NOT_IN_LIVE_ROOM'; end if;
   if not (
     exists(select 1 from public.live_rooms r where r.id=p_live_room_id and r.host_id=p_recipient_profile_id)
     or exists(select 1 from public.live_participants lp where lp.room_id=p_live_room_id and lp.profile_id=p_recipient_profile_id and lp.left_at is null)
   ) then raise exception 'RECIPIENT_NOT_IN_LIVE_ROOM'; end if;
 end if;

 insert into public.wallet_accounts(profile_id,kind) values(p_sender_profile_id,'user')
 on conflict(profile_id) do nothing;
 insert into public.wallet_accounts(profile_id,kind) values(p_recipient_profile_id,'user')
 on conflict(profile_id) do nothing;
 select id into v_sender_account from public.wallet_accounts where profile_id=p_sender_profile_id and kind='user' for update;
 select id into v_recipient_account from public.wallet_accounts where profile_id=p_recipient_profile_id and kind='user' for update;
 if v_sender_account is null or v_recipient_account is null then raise exception 'WALLET_ACCOUNT_UNAVAILABLE'; end if;

 v_entry_id:=public.post_gift(v_sender_account,v_recipient_account,v_gift.price_coins,p_idempotency_key);
 insert into public.gift_deliveries(
   gift_id,sender_profile_id,recipient_profile_id,live_room_id,ledger_entry_id,price_coins,idempotency_key,message,state
 ) values (
   v_gift.id,p_sender_profile_id,p_recipient_profile_id,p_live_room_id,v_entry_id,v_gift.price_coins,p_idempotency_key,nullif(trim(p_message),''),'delivered'
 )
 on conflict(idempotency_key) do nothing
 returning id into v_delivery_id;

 if v_delivery_id is null then
   select id into v_delivery_id from public.gift_deliveries where idempotency_key=p_idempotency_key;
 end if;
 if v_delivery_id is null then raise exception 'GIFT_DELIVERY_RECORD_FAILED'; end if;

 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values(
   'gift-delivered:'||v_delivery_id::text,
   'gift.delivered',
   'gift_delivery',
   v_delivery_id::text,
   jsonb_build_object('deliveryId',v_delivery_id,'giftId',v_gift.id,'senderProfileId',p_sender_profile_id,
     'recipientProfileId',p_recipient_profile_id,'liveRoomId',p_live_room_id,'priceCoins',v_gift.price_coins)
 )
 on conflict(event_key) do nothing;
 return v_delivery_id;
end;
$$;
revoke all on function public.deliver_gift(uuid,uuid,text,uuid,text,text) from public;
revoke all on function public.deliver_gift(uuid,uuid,text,uuid,text,text) from anon;
revoke all on function public.deliver_gift(uuid,uuid,text,uuid,text,text) from authenticated;
grant execute on function public.deliver_gift(uuid,uuid,text,uuid,text,text) to service_role;

create or replace function public.credit_captured_coin_order(
 p_provider_order_id text,
 p_capture_id text,
 p_capture_amount numeric,
 p_currency text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_order public.payment_orders%rowtype;
 v_coins bigint;
 v_user_account uuid;
 v_mint_account uuid;
 v_entry_id uuid;
begin
 if coalesce(trim(p_provider_order_id),'')='' or coalesce(trim(p_capture_id),'')='' then
   raise exception 'PAYMENT_CAPTURE_IDENTIFIERS_REQUIRED';
 end if;
 if upper(coalesce(p_currency,''))<>'USD' then raise exception 'PAYMENT_CURRENCY_MISMATCH'; end if;

 select * into v_order from public.payment_orders where provider_order_id=p_provider_order_id for update;
 if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND'; end if;
 if v_order.state='credited' then
   if v_order.provider_capture_id=p_capture_id and v_order.credited_ledger_entry is not null then
     return v_order.credited_ledger_entry;
   end if;
   raise exception 'PAYMENT_ALREADY_CREDITED';
 end if;
 if v_order.state not in ('created','approved','captured') then raise exception 'PAYMENT_ORDER_STATE_INVALID'; end if;
 if round(coalesce(p_capture_amount,0),2)<>v_order.amount_usd then raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;
 if exists(select 1 from public.payment_orders po where po.provider_capture_id=p_capture_id and po.id<>v_order.id) then
   raise exception 'CAPTURE_ALREADY_USED';
 end if;

 if v_order.custom_coins is not null then
   v_coins:=v_order.custom_coins;
 else
   select coins into v_coins from public.coin_packages where id=v_order.package_id;
   if not found or v_coins is null or v_coins<=0 then raise exception 'COIN_PACKAGE_UNAVAILABLE'; end if;
 end if;

 insert into public.wallet_accounts(profile_id,kind) values(v_order.profile_id,'user')
 on conflict(profile_id) do nothing;
 select id into v_user_account from public.wallet_accounts where profile_id=v_order.profile_id and kind='user' for update;
 select id into v_mint_account from public.wallet_accounts where kind='mint' order by id limit 1 for update;
 if v_mint_account is null then
   insert into public.wallet_accounts(profile_id,kind) values(null,'mint') returning id into v_mint_account;
 end if;
 if v_user_account is null or v_mint_account is null then raise exception 'WALLET_ACCOUNT_UNAVAILABLE'; end if;

 select id into v_entry_id from public.ledger_entries where idempotency_key='coin_credit:'||p_capture_id;
 if v_entry_id is null then
   insert into public.ledger_entries(idempotency_key,unit,type)
   values('coin_credit:'||p_capture_id,'coins','recharge')
   returning id into v_entry_id;
   insert into public.ledger_postings(entry_id,account_id,delta,unit)
   values(v_entry_id,v_mint_account,-v_coins,'coins'),(v_entry_id,v_user_account,v_coins,'coins');
 end if;

 update public.payment_orders
 set state='credited',provider_capture_id=p_capture_id,credited_ledger_entry=v_entry_id,
     captured_at=coalesce(captured_at,now()),credited_at=coalesce(credited_at,now()),updated_at=now()
 where id=v_order.id;
 return v_entry_id;
end;
$$;
revoke all on function public.credit_captured_coin_order(text,text,numeric,text) from public;
revoke all on function public.credit_captured_coin_order(text,text,numeric,text) from anon;
revoke all on function public.credit_captured_coin_order(text,text,numeric,text) from authenticated;
grant execute on function public.credit_captured_coin_order(text,text,numeric,text) to service_role;
