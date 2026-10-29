-- Creator payout destinations, audited eligibility gates, earnings reservations and provider reconciliation.
alter table public.payouts
  add column if not exists currency char(3) not null default 'USD' check(currency='USD'),
  add column if not exists provider_item_id text,
  add column if not exists failure_code text;
create unique index if not exists payouts_provider_batch_id_uq
  on public.payouts(provider_batch_id) where provider_batch_id is not null;

create table if not exists public.creator_payout_profiles (
  creator_id uuid primary key references public.profiles(id) on delete restrict,
  recipient_ciphertext text not null,
  recipient_nonce text not null,
  recipient_tag text not null,
  recipient_hash text not null,
  recipient_masked text not null,
  country_code char(2) not null,
  country_eligibility text not null default 'pending'
    check(country_eligibility in ('pending','eligible','ineligible')),
  provider_recipient_ready boolean not null default false,
  identity_verified_at timestamptz,
  compliance_state text not null default 'pending'
    check(compliance_state in ('pending','cleared','held')),
  risk_hold boolean not null default false,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(length(country_code)=2),
  check(length(recipient_hash)=64),
  check(length(recipient_masked)<=160),
  check(review_note is null or length(review_note)<=500),
  check(not provider_recipient_ready or
    (identity_verified_at is not null and country_eligibility='eligible' and compliance_state='cleared' and risk_hold=false))
);
alter table public.creator_payout_profiles enable row level security;
revoke all on public.creator_payout_profiles from public,anon,authenticated;
grant select,insert,update,delete on public.creator_payout_profiles to service_role;

alter table public.payouts enable row level security;
revoke insert,update,delete on public.payouts from public,anon,authenticated;

create or replace function public.request_creator_payout(
  p_creator_profile_id uuid,
  p_minimum_minor bigint,
  p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_profile public.creator_payout_profiles%rowtype;
  v_existing public.payouts%rowtype;
  v_available bigint;
  v_payout_id uuid;
  v_rows integer;
begin
  if p_creator_profile_id is null then raise exception 'PAYOUT_CREATOR_REQUIRED'; end if;
  if p_minimum_minor is null or p_minimum_minor<=0 then raise exception 'PAYOUT_MINIMUM_NOT_CONFIGURED'; end if;
  if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>220 then
    raise exception 'PAYOUT_IDEMPOTENCY_KEY_INVALID';
  end if;

  select * into v_existing from public.payouts where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.creator_id<>p_creator_profile_id then raise exception 'PAYOUT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing.id;
  end if;

  select * into v_profile from public.creator_payout_profiles
    where creator_id=p_creator_profile_id for update;
  if not found then raise exception 'PAYOUT_DESTINATION_REQUIRED'; end if;
  if not v_profile.provider_recipient_ready then raise exception 'PAYOUT_RECIPIENT_NOT_READY'; end if;
  if v_profile.identity_verified_at is null then raise exception 'PAYOUT_IDENTITY_NOT_VERIFIED'; end if;
  if v_profile.country_eligibility<>'eligible' then raise exception 'PAYOUT_COUNTRY_NOT_ELIGIBLE'; end if;
  if v_profile.compliance_state<>'cleared' then raise exception 'PAYOUT_COMPLIANCE_NOT_CLEARED'; end if;
  if v_profile.risk_hold then raise exception 'PAYOUT_RISK_HOLD'; end if;

  -- Lock every eligible earnings row before summing/reserving it.
  perform 1 from public.creator_earning_entries
    where creator_id=p_creator_profile_id and state='available'
      and currency='USD' and available_at is not null and available_at<=now()
    order by created_at,id for update;
  select coalesce(sum(creator_share_minor),0)::bigint into v_available
    from public.creator_earning_entries
    where creator_id=p_creator_profile_id and state='available'
      and currency='USD' and available_at is not null and available_at<=now();
  if v_available<=0 then raise exception 'PAYOUT_NO_AVAILABLE_EARNINGS'; end if;
  if v_available<p_minimum_minor then raise exception 'PAYOUT_BELOW_MINIMUM'; end if;

  insert into public.payouts(creator_id,amount_minor,currency,state,idempotency_key,updated_at)
    values(p_creator_profile_id,v_available,'USD','requested',p_idempotency_key,now())
    returning id into v_payout_id;

  update public.creator_earning_entries
    set state='held',payout_id=v_payout_id
    where creator_id=p_creator_profile_id and state='available'
      and currency='USD' and available_at is not null and available_at<=now();
  get diagnostics v_rows = row_count;
  if v_rows<1 then raise exception 'PAYOUT_RESERVATION_FAILED'; end if;

  insert into public.payout_reconciliation_records(payout_id,expected_minor,state,resolution_note)
    values(v_payout_id,v_available,'pending','Reserved available USD creator earnings before PayPal dispatch');
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('creator-payout-requested:'||v_payout_id::text,'creator.payout.requested','payout',v_payout_id::text,
      jsonb_build_object('payoutId',v_payout_id,'creatorId',p_creator_profile_id,'amountMinor',v_available,'currency','USD'))
    on conflict(event_key) do nothing;
  return v_payout_id;
end;
$$;
revoke all on function public.request_creator_payout(uuid,bigint,text) from public;
revoke all on function public.request_creator_payout(uuid,bigint,text) from anon;
revoke all on function public.request_creator_payout(uuid,bigint,text) from authenticated;
grant execute on function public.request_creator_payout(uuid,bigint,text) to service_role;

create or replace function public.attach_creator_payout_batch(
  p_payout_id uuid,
  p_provider_batch_id text
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare v_payout public.payouts%rowtype;
begin
  if p_payout_id is null or coalesce(length(trim(p_provider_batch_id)),0)<3 or length(p_provider_batch_id)>128 then
    raise exception 'PAYOUT_PROVIDER_BATCH_INVALID';
  end if;
  select * into v_payout from public.payouts where id=p_payout_id for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_payout.state='paid' then return 'paid'; end if;
  if v_payout.state='failed' then raise exception 'PAYOUT_ALREADY_FAILED'; end if;
  if v_payout.provider_batch_id is not null and v_payout.provider_batch_id<>p_provider_batch_id then
    raise exception 'PAYOUT_PROVIDER_BATCH_CONFLICT';
  end if;
  update public.payouts set provider_batch_id=p_provider_batch_id,state='processing',updated_at=now(),failure_code=null
    where id=p_payout_id;
  update public.payout_reconciliation_records
    set provider_batch_id=p_provider_batch_id,checked_at=now()
    where payout_id=p_payout_id and state='pending';
  return 'processing';
end;
$$;
revoke all on function public.attach_creator_payout_batch(uuid,text) from public;
revoke all on function public.attach_creator_payout_batch(uuid,text) from anon;
revoke all on function public.attach_creator_payout_batch(uuid,text) from authenticated;
grant execute on function public.attach_creator_payout_batch(uuid,text) to service_role;

create or replace function public.complete_creator_payout(
  p_payout_id uuid,
  p_provider_batch_id text,
  p_provider_item_id text,
  p_observed_minor bigint
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_payout public.payouts%rowtype;
  v_reserved bigint;
begin
  if p_payout_id is null or coalesce(length(trim(p_provider_batch_id)),0)=0
     or coalesce(length(trim(p_provider_item_id)),0)=0 then raise exception 'PAYOUT_PROVIDER_REFERENCE_REQUIRED'; end if;
  select * into v_payout from public.payouts where id=p_payout_id for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_payout.state='paid' then
    if v_payout.provider_batch_id=p_provider_batch_id and v_payout.provider_item_id=p_provider_item_id
       and v_payout.amount_minor=p_observed_minor then return 'paid'; end if;
    raise exception 'PAYOUT_COMPLETION_CONFLICT';
  end if;
  if v_payout.state not in ('requested','processing') then raise exception 'PAYOUT_STATE_NOT_COMPLETABLE'; end if;
  if v_payout.provider_batch_id is distinct from p_provider_batch_id then raise exception 'PAYOUT_PROVIDER_BATCH_CONFLICT'; end if;
  if v_payout.amount_minor<>p_observed_minor then raise exception 'PAYOUT_AMOUNT_MISMATCH'; end if;
  select coalesce(sum(creator_share_minor),0)::bigint into v_reserved
    from public.creator_earning_entries where payout_id=p_payout_id and state='held';
  if v_reserved<>v_payout.amount_minor then raise exception 'PAYOUT_EARNINGS_RESERVATION_MISMATCH'; end if;

  update public.creator_earning_entries set state='paid',paid_at=now()
    where payout_id=p_payout_id and state='held';
  update public.payouts set state='paid',provider_item_id=p_provider_item_id,updated_at=now(),failure_code=null
    where id=p_payout_id;
  update public.payout_reconciliation_records set provider_item_id=p_provider_item_id,
    observed_minor=p_observed_minor,state='matched',checked_at=now(),
    resolution_note='PayPal payout item success webhook verified'
    where payout_id=p_payout_id;
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('creator-payout-paid:'||p_payout_id::text,'creator.payout.paid','payout',p_payout_id::text,
      jsonb_build_object('payoutId',p_payout_id,'creatorId',v_payout.creator_id,'amountMinor',v_payout.amount_minor,'currency',v_payout.currency))
    on conflict(event_key) do nothing;
  return 'paid';
end;
$$;
revoke all on function public.complete_creator_payout(uuid,text,text,bigint) from public;
revoke all on function public.complete_creator_payout(uuid,text,text,bigint) from anon;
revoke all on function public.complete_creator_payout(uuid,text,text,bigint) from authenticated;
grant execute on function public.complete_creator_payout(uuid,text,text,bigint) to service_role;

create or replace function public.release_creator_payout(
  p_payout_id uuid,
  p_failure_code text
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare v_payout public.payouts%rowtype; v_code text;
begin
  if p_payout_id is null then raise exception 'PAYOUT_ID_REQUIRED'; end if;
  v_code:=left(coalesce(nullif(trim(p_failure_code),''),'PAYOUT_PROVIDER_FAILED'),100);
  if v_code !~ '^[A-Za-z0-9_.:-]+$' then v_code:='PAYOUT_PROVIDER_FAILED'; end if;
  select * into v_payout from public.payouts where id=p_payout_id for update;
  if not found then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if v_payout.state='failed' then return 'failed'; end if;
  if v_payout.state='paid' then raise exception 'PAYOUT_ALREADY_PAID'; end if;

  update public.creator_earning_entries set state='available',payout_id=null
    where payout_id=p_payout_id and state='held';
  update public.payouts set state='failed',failure_code=v_code,updated_at=now()
    where id=p_payout_id;
  update public.payout_reconciliation_records set state='failed',checked_at=now(),resolution_note=v_code
    where payout_id=p_payout_id and state in ('pending','mismatch');
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('creator-payout-failed:'||p_payout_id::text,'creator.payout.failed','payout',p_payout_id::text,
      jsonb_build_object('payoutId',p_payout_id,'creatorId',v_payout.creator_id,'failureCode',v_code))
    on conflict(event_key) do nothing;
  return 'failed';
end;
$$;
revoke all on function public.release_creator_payout(uuid,text) from public;
revoke all on function public.release_creator_payout(uuid,text) from anon;
revoke all on function public.release_creator_payout(uuid,text) from authenticated;
grant execute on function public.release_creator_payout(uuid,text) to service_role;
