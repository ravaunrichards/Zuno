-- Recurring creator subscription plans, provider state reconciliation and entitlements.
alter table public.creator_subscription_tiers add column if not exists provider_product_id text;
alter table public.creator_subscription_tiers add column if not exists provider_plan_id text;
alter table public.creator_subscription_tiers add column if not exists creation_idempotency_key text;
create unique index if not exists creator_subscription_tier_creation_key_uq
  on public.creator_subscription_tiers(creator_id,creation_idempotency_key)
  where creation_idempotency_key is not null;
create unique index if not exists creator_subscription_tier_provider_plan_uq
  on public.creator_subscription_tiers(provider_plan_id) where provider_plan_id is not null;

alter table public.creator_subscriptions add column if not exists tier_id uuid references public.creator_subscription_tiers(id) on delete set null;
alter table public.creator_subscriptions add column if not exists billing_amount_minor bigint check(billing_amount_minor is null or billing_amount_minor>0);
alter table public.creator_subscriptions add column if not exists currency char(3) not null default 'USD';
alter table public.creator_subscriptions add column if not exists provider_approval_url text;
alter table public.creator_subscriptions add column if not exists idempotency_key text;
alter table public.creator_subscriptions add column if not exists updated_at timestamptz not null default now();
alter table public.creator_subscriptions add column if not exists last_payment_at timestamptz;
alter table public.creator_subscriptions drop constraint if exists creator_subscriptions_state_check;
alter table public.creator_subscriptions add constraint creator_subscriptions_state_check
  check(state in ('pending','active','cancelled','expired','grace'));
create unique index if not exists creator_subscriptions_idempotency_key_uq
  on public.creator_subscriptions(subscriber_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists creator_subscriptions_open_tier_uq
  on public.creator_subscriptions(subscriber_id,tier_id) where tier_id is not null and state in ('pending','active','grace');
create index if not exists creator_subscriptions_creator_state_idx
  on public.creator_subscriptions(creator_id,state,created_at desc);

create or replace function public.sync_creator_subscription(
 p_provider_subscription_id text,
 p_provider_status text,
 p_next_billing_time timestamptz,
 p_provider_event_id text
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_sub public.creator_subscriptions%rowtype;
 v_state text;
 v_tier public.creator_subscription_tiers%rowtype;
 v_benefit jsonb;
 v_key text;
 v_period_end timestamptz;
begin
 if coalesce(trim(p_provider_subscription_id),'')='' then raise exception 'CREATOR_SUBSCRIPTION_PROVIDER_ID_REQUIRED'; end if;
 if p_provider_status not in ('APPROVAL_PENDING','APPROVED','ACTIVE','SUSPENDED','CANCELLED','EXPIRED') then
   raise exception 'CREATOR_SUBSCRIPTION_PROVIDER_STATUS_INVALID';
 end if;
 v_state:=case p_provider_status
   when 'APPROVAL_PENDING' then 'pending'
   when 'APPROVED' then 'pending'
   when 'ACTIVE' then 'active'
   when 'SUSPENDED' then 'grace'
   when 'CANCELLED' then 'cancelled'
   when 'EXPIRED' then 'expired'
 end;
 select * into v_sub from public.creator_subscriptions
 where provider_subscription_id=p_provider_subscription_id
 for update;
 if not found then raise exception 'CREATOR_SUBSCRIPTION_NOT_FOUND'; end if;

 v_period_end:=coalesce(p_next_billing_time,v_sub.current_period_end);
 update public.creator_subscriptions
 set state=v_state,current_period_end=v_period_end,updated_at=now()
 where id=v_sub.id;

 if v_sub.tier_id is not null then
   select * into v_tier from public.creator_subscription_tiers where id=v_sub.tier_id;
   if found and jsonb_typeof(v_tier.benefits)='array' then
     for v_benefit in select value from jsonb_array_elements(v_tier.benefits) loop
       v_key:=case
         when jsonb_typeof(v_benefit)='object' then trim(coalesce(v_benefit->>'key',''))
         when jsonb_typeof(v_benefit)='string' then trim(both '"' from v_benefit::text)
         else ''
       end;
       if v_key<>'' and length(v_key)<=120 then
         if v_state='active' then
           insert into public.creator_subscription_entitlements(
             subscription_id,subscriber_id,creator_id,entitlement_key,granted_at,ends_at
           ) values (
             v_sub.id,v_sub.subscriber_id,v_sub.creator_id,v_key,now(),v_period_end
           ) on conflict(subscription_id,entitlement_key) do update
             set ends_at=excluded.ends_at;
         else
           update public.creator_subscription_entitlements set ends_at=coalesce(v_period_end,now())
           where subscription_id=v_sub.id and entitlement_key=v_key;
         end if;
       end if;
     end loop;
   end if;
 end if;

 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values(
   'creator-subscription-sync:'||coalesce(nullif(p_provider_event_id,''),p_provider_subscription_id||':'||v_state),
   'creator.subscription.state_changed','creator_subscription',v_sub.id::text,
   jsonb_build_object('subscriptionId',v_sub.id,'providerSubscriptionId',p_provider_subscription_id,
      'state',v_state,'providerEventId',p_provider_event_id,'periodEnd',v_period_end)
 ) on conflict(event_key) do nothing;

 return v_state;
end;
$$;
revoke all on function public.sync_creator_subscription(text,text,timestamptz,text) from public;
revoke all on function public.sync_creator_subscription(text,text,timestamptz,text) from anon;
revoke all on function public.sync_creator_subscription(text,text,timestamptz,text) from authenticated;
grant execute on function public.sync_creator_subscription(text,text,timestamptz,text) to service_role;
