-- ZUNO full-refund reservation and external reversal restrictions.
-- Coins are reserved atomically before calling PayPal; uncertain provider outcomes remain processing.

alter table public.payment_orders drop constraint if exists payment_orders_state_check;
alter table public.payment_orders add constraint payment_orders_state_check
 check(state in ('created','approved','captured','credited','failed','cancelled','refunded','partially_refunded','reversed'));

create table if not exists public.wallet_restrictions (
 profile_id uuid primary key references public.profiles(id) on delete cascade,
 state text not null default 'active' check(state in ('active','cleared')),
 reason_code text not null,
 source_order_id uuid references public.payment_orders(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 cleared_at timestamptz
);
alter table public.wallet_restrictions enable row level security;
-- Wallet restrictions are only visible and mutable through trusted server/admin routes.

create or replace function public.reserve_coin_refund(
 p_payment_order_id uuid,
 p_profile_id uuid,
 p_idempotency_key text,
 p_reason_code text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_existing public.refund_records%rowtype;
 v_order public.payment_orders%rowtype;
 v_coins bigint;
 v_user_account uuid;
 v_sink_account uuid;
 v_balance bigint;
 v_refund_id uuid;
 v_entry_id uuid;
begin
 if p_payment_order_id is null or p_profile_id is null then raise exception 'REFUND_REQUEST_INVALID'; end if;
 if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>220 then
   raise exception 'REFUND_IDEMPOTENCY_KEY_INVALID';
 end if;
 if coalesce(length(trim(p_reason_code)),0)<2 or length(p_reason_code)>80
    or p_reason_code !~ '^[a-zA-Z0-9_.:-]+$' then
   raise exception 'REFUND_REASON_INVALID';
 end if;

 select * into v_existing from public.refund_records where idempotency_key=p_idempotency_key;
 if found then
   if v_existing.payment_order_id<>p_payment_order_id or v_existing.requested_by<>p_profile_id then
     raise exception 'REFUND_IDEMPOTENCY_CONFLICT';
   end if;
   return v_existing.id;
 end if;

 select * into v_order from public.payment_orders
 where id=p_payment_order_id and profile_id=p_profile_id
 for update;
 if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND'; end if;
 if v_order.state<>'credited' or v_order.provider_capture_id is null then raise exception 'PAYMENT_NOT_REFUNDABLE'; end if;
 if exists(select 1 from public.refund_records rr
   where rr.payment_order_id=v_order.id and rr.state in ('requested','approved','processing','refunded')) then
   raise exception 'REFUND_ALREADY_EXISTS';
 end if;

 if v_order.custom_coins is not null then
   v_coins:=v_order.custom_coins;
 else
   select cp.coins into v_coins from public.coin_packages cp where cp.id=v_order.package_id;
   if not found or v_coins is null or v_coins<=0 then raise exception 'COIN_PACKAGE_UNAVAILABLE'; end if;
 end if;

 select id into v_user_account from public.wallet_accounts where profile_id=p_profile_id and kind='user' for update;
 if v_user_account is null then raise exception 'WALLET_ACCOUNT_UNAVAILABLE'; end if;
 select coalesce(sum(delta),0)::bigint into v_balance from public.ledger_postings
 where account_id=v_user_account and unit='coins';
 if v_balance<v_coins then raise exception 'REFUND_COIN_BALANCE_INSUFFICIENT'; end if;

 select id into v_sink_account from public.wallet_accounts where kind='sink' order by id limit 1 for update;
 if v_sink_account is null then
   insert into public.wallet_accounts(profile_id,kind) values(null,'sink') returning id into v_sink_account;
 end if;

 insert into public.refund_records(payment_order_id,requested_by,amount_usd,reason_code,state,idempotency_key)
 values(v_order.id,p_profile_id,v_order.amount_usd,p_reason_code,'processing',p_idempotency_key)
 returning id into v_refund_id;

 insert into public.ledger_entries(idempotency_key,unit,type)
 values('coin_refund_reserve:'||v_refund_id::text,'coins','refund_reservation')
 returning id into v_entry_id;
 insert into public.ledger_postings(entry_id,account_id,delta,unit)
 values(v_entry_id,v_user_account,-v_coins,'coins'),(v_entry_id,v_sink_account,v_coins,'coins');

 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values(
   'coin-refund-reserved:'||v_refund_id::text,'payment.refund_reserved','refund',v_refund_id::text,
   jsonb_build_object('refundId',v_refund_id,'paymentOrderId',v_order.id,'profileId',p_profile_id,'coinsReserved',v_coins)
 ) on conflict(event_key) do nothing;
 return v_refund_id;
end;
$$;
revoke all on function public.reserve_coin_refund(uuid,uuid,text,text) from public;
revoke all on function public.reserve_coin_refund(uuid,uuid,text,text) from anon;
revoke all on function public.reserve_coin_refund(uuid,uuid,text,text) from authenticated;
grant execute on function public.reserve_coin_refund(uuid,uuid,text,text) to service_role;

create or replace function public.finalize_coin_refund(
 p_refund_id uuid,
 p_provider_refund_id text,
 p_succeeded boolean,
 p_error_code text
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_refund public.refund_records%rowtype;
 v_order public.payment_orders%rowtype;
 v_coins bigint;
 v_user_account uuid;
 v_sink_account uuid;
 v_entry_id uuid;
begin
 select * into v_refund from public.refund_records where id=p_refund_id for update;
 if not found then raise exception 'REFUND_NOT_FOUND'; end if;
 if v_refund.state='refunded' then return 'refunded'; end if;
 if v_refund.state='failed' then return 'failed'; end if;
 if v_refund.state<>'processing' then raise exception 'REFUND_STATE_INVALID'; end if;

 select * into v_order from public.payment_orders where id=v_refund.payment_order_id for update;
 if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND'; end if;

 if p_succeeded then
   if coalesce(trim(p_provider_refund_id),'')='' then raise exception 'PROVIDER_REFUND_ID_REQUIRED'; end if;
   update public.refund_records
     set state='refunded',provider_refund_id=p_provider_refund_id,updated_at=now()
   where id=v_refund.id;
   update public.payment_orders set state='refunded',updated_at=now()
   where id=v_order.id and state in ('credited','refunded');
   insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
   values('coin-refund-completed:'||v_refund.id::text,'payment.refunded','refund',v_refund.id::text,
     jsonb_build_object('refundId',v_refund.id,'paymentOrderId',v_order.id,'profileId',v_order.profile_id))
   on conflict(event_key) do nothing;
   return 'refunded';
 end if;

 if v_order.custom_coins is not null then
   v_coins:=v_order.custom_coins;
 else
   select cp.coins into v_coins from public.coin_packages cp where cp.id=v_order.package_id;
   if not found or v_coins is null or v_coins<=0 then raise exception 'COIN_PACKAGE_UNAVAILABLE'; end if;
 end if;
 select id into v_user_account from public.wallet_accounts where profile_id=v_order.profile_id and kind='user' for update;
 select id into v_sink_account from public.wallet_accounts where kind='sink' order by id limit 1 for update;
 if v_user_account is null or v_sink_account is null then raise exception 'WALLET_ACCOUNT_UNAVAILABLE'; end if;

 select id into v_entry_id from public.ledger_entries where idempotency_key='coin_refund_release:'||v_refund.id::text;
 if v_entry_id is null then
   insert into public.ledger_entries(idempotency_key,unit,type)
   values('coin_refund_release:'||v_refund.id::text,'coins','refund_reservation_release')
   returning id into v_entry_id;
   insert into public.ledger_postings(entry_id,account_id,delta,unit)
   values(v_entry_id,v_user_account,v_coins,'coins'),(v_entry_id,v_sink_account,-v_coins,'coins');
 end if;
 update public.refund_records set state='failed',updated_at=now(),reason_code=left(coalesce(p_error_code,'PROVIDER_REFUND_FAILED'),80)
 where id=v_refund.id;
 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values('coin-refund-released:'||v_refund.id::text,'payment.refund_failed','refund',v_refund.id::text,
   jsonb_build_object('refundId',v_refund.id,'paymentOrderId',v_order.id,'profileId',v_order.profile_id,
     'errorCode',left(coalesce(p_error_code,'PROVIDER_REFUND_FAILED'),80)))
 on conflict(event_key) do nothing;
 return 'failed';
end;
$$;
revoke all on function public.finalize_coin_refund(uuid,text,boolean,text) from public;
revoke all on function public.finalize_coin_refund(uuid,text,boolean,text) from anon;
revoke all on function public.finalize_coin_refund(uuid,text,boolean,text) from authenticated;
grant execute on function public.finalize_coin_refund(uuid,text,boolean,text) to service_role;

