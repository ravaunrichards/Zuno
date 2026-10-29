-- Freeze the encrypted recipient for every reserved payout; retries must not follow a later destination edit.
alter table public.payouts
  add column if not exists recipient_ciphertext text,
  add column if not exists recipient_nonce text,
  add column if not exists recipient_tag text,
  add column if not exists recipient_hash text,
  add column if not exists recipient_masked text,
  add column if not exists recipient_country_code char(2);

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
  if coalesce(v_profile.recipient_ciphertext,'')='' or coalesce(v_profile.recipient_nonce,'')=''
     or coalesce(v_profile.recipient_tag,'')='' or coalesce(v_profile.recipient_hash,'')='' then
    raise exception 'PAYOUT_DESTINATION_INVALID';
  end if;

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

  insert into public.payouts(
    creator_id,amount_minor,currency,state,idempotency_key,updated_at,
    recipient_ciphertext,recipient_nonce,recipient_tag,recipient_hash,recipient_masked,recipient_country_code
  ) values(
    p_creator_profile_id,v_available,'USD','requested',p_idempotency_key,now(),
    v_profile.recipient_ciphertext,v_profile.recipient_nonce,v_profile.recipient_tag,
    v_profile.recipient_hash,v_profile.recipient_masked,v_profile.country_code
  ) returning id into v_payout_id;

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
