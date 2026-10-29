-- ZUNO wallet checkout, verified provider events, gift delivery and creator revenue policy.
create table if not exists coin_packages (
 id text primary key,
 coins bigint not null check(coins>0),
 amount_usd numeric(10,2),
 enabled boolean not null default false,
 sort_order integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(amount_usd is null or amount_usd>0),
 check(enabled=false or amount_usd is not null)
);
create table if not exists payment_orders (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references profiles(id) on delete restrict,
 package_id text references coin_packages(id),
 custom_coins bigint check(custom_coins is null or custom_coins>0),
 amount_usd numeric(10,2) not null check(amount_usd>0),
 currency char(3) not null default 'USD' check(currency='USD'),
 provider text not null default 'paypal' check(provider='paypal'),
 provider_order_id text unique,
 provider_capture_id text unique,
 idempotency_key text not null unique,
 state text not null default 'created' check(state in ('created','approved','captured','credited','failed','cancelled','refunded','partially_refunded')),
 credited_ledger_entry uuid references ledger_entries(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 captured_at timestamptz,
 credited_at timestamptz,
 check((package_id is not null) <> (custom_coins is not null))
);
create index if not exists payment_orders_profile_idx on payment_orders(profile_id,created_at desc);
create index if not exists payment_orders_pending_idx on payment_orders(state,created_at) where state in ('created','approved','captured');
create table if not exists payment_webhook_events (
 id uuid primary key default gen_random_uuid(),
 provider text not null,
 provider_event_id text not null,
 event_type text not null,
 signature_verified boolean not null default false,
 processing_state text not null default 'received' check(processing_state in ('received','processing','processed','ignored','failed')),
 attempt_count integer not null default 0 check(attempt_count>=0),
 payload jsonb not null,
 received_at timestamptz not null default now(),
 processed_at timestamptz,
 last_error_code text,
 unique(provider,provider_event_id)
);
create table if not exists refund_records (
 id uuid primary key default gen_random_uuid(),
 payment_order_id uuid not null references payment_orders(id),
 requested_by uuid not null references profiles(id),
 amount_usd numeric(10,2) not null check(amount_usd>0),
 reason_code text not null,
 state text not null default 'requested' check(state in ('requested','approved','processing','refunded','rejected','failed')),
 provider_refund_id text unique,
 idempotency_key text not null unique,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists gift_deliveries (
 id uuid primary key default gen_random_uuid(),
 gift_id text not null references gift_definitions(id),
 sender_profile_id uuid not null references profiles(id),
 recipient_profile_id uuid not null references profiles(id),
 live_room_id uuid references live_rooms(id) on delete set null,
 ledger_entry_id uuid not null references ledger_entries(id),
 price_coins bigint not null check(price_coins>0),
 idempotency_key text not null unique,
 message text,
 delivered_at timestamptz not null default now(),
 check(sender_profile_id<>recipient_profile_id)
);
create index if not exists gift_deliveries_recipient_idx on gift_deliveries(recipient_profile_id,delivered_at desc);
create index if not exists gift_deliveries_sender_idx on gift_deliveries(sender_profile_id,delivered_at desc);
create table if not exists creator_subscription_tiers (
 id uuid primary key default gen_random_uuid(),
 creator_id uuid not null references profiles(id) on delete cascade,
 tier_key text not null,
 title text not null,
 monthly_price_minor bigint not null check(monthly_price_minor>0),
 currency char(3) not null default 'USD',
 benefits jsonb not null default '[]'::jsonb,
 enabled boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(creator_id,tier_key)
);
create table if not exists creator_subscription_entitlements (
 subscription_id uuid not null references creator_subscriptions(id) on delete cascade,
 subscriber_id uuid not null references profiles(id) on delete cascade,
 creator_id uuid not null references profiles(id) on delete cascade,
 entitlement_key text not null,
 granted_at timestamptz not null default now(),
 ends_at timestamptz,
 primary key(subscription_id,entitlement_key)
);
create table if not exists creator_earning_policies (
 policy_version text primary key,
 creator_share_basis_points integer not null check(creator_share_basis_points between 0 and 10000),
 platform_share_basis_points integer not null check(platform_share_basis_points between 0 and 10000),
 split_basis text not null check(split_basis in ('gross','net_after_provider_fees')),
 state text not null default 'draft' check(state in ('draft','active','retired')),
 effective_from timestamptz not null,
 effective_until timestamptz,
 created_at timestamptz not null default now(),
 check(creator_share_basis_points+platform_share_basis_points=10000),
 check(effective_until is null or effective_until>effective_from)
);
create unique index if not exists creator_earning_one_active_policy_idx on creator_earning_policies(state) where state='active';
create table if not exists payout_reconciliation_records (
 id uuid primary key default gen_random_uuid(),
 payout_id uuid not null references payouts(id) on delete cascade,
 provider_batch_id text,
 provider_item_id text,
 expected_minor bigint not null,
 observed_minor bigint,
 state text not null default 'pending' check(state in ('pending','matched','mismatch','failed','resolved')),
 checked_at timestamptz,
 resolution_note text,
 created_at timestamptz not null default now()
);
create table if not exists payment_reconciliation_runs (
 id uuid primary key default gen_random_uuid(),
 provider text not null,
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 state text not null default 'running' check(state in ('running','completed','failed')),
 checked_count integer not null default 0 check(checked_count>=0),
 mismatch_count integer not null default 0 check(mismatch_count>=0),
 summary jsonb not null default '{}'::jsonb
);
create table if not exists gifter_milestone_history (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references profiles(id) on delete cascade,
 milestone_key text not null check(milestone_key in ('ultimate_universe','level_10','level_20','level_30','level_40','level_50')),
 eligible_lifetime_coins bigint not null check(eligible_lifetime_coins>=0),
 awarded_at timestamptz not null default now(),
 unique(profile_id,milestone_key)
);
create table if not exists ranking_reset_runs (
 id uuid primary key default gen_random_uuid(),
 scope text not null,
 period text not null check(period in ('weekly','monthly')),
 timezone_name text not null default 'America/Jamaica',
 period_start timestamptz not null,
 period_end timestamptz not null,
 completed_at timestamptz,
 state text not null default 'pending' check(state in ('pending','running','completed','failed')),
 unique(scope,period,period_start),
 check(period_end>period_start)
);

alter table payouts add column if not exists idempotency_key text;
alter table payouts add column if not exists updated_at timestamptz not null default now();
alter table payouts add column if not exists provider_request_id text;
create unique index if not exists payouts_idempotency_key_idx on payouts(idempotency_key) where idempotency_key is not null;

alter table coin_packages enable row level security;
alter table payment_orders enable row level security;
alter table payment_webhook_events enable row level security;
alter table refund_records enable row level security;
alter table gift_deliveries enable row level security;
alter table creator_subscription_tiers enable row level security;
alter table creator_subscription_entitlements enable row level security;
alter table creator_earning_policies enable row level security;
alter table payout_reconciliation_records enable row level security;
alter table payment_reconciliation_runs enable row level security;
alter table gifter_milestone_history enable row level security;
alter table ranking_reset_runs enable row level security;

create policy coin_packages_public_read on coin_packages for select using(enabled=true);
create policy payment_orders_owner_read on payment_orders for select using(profile_id=current_profile_id());
create policy refund_records_owner_read on refund_records for select using(requested_by=current_profile_id() or exists(select 1 from payment_orders po where po.id=payment_order_id and po.profile_id=current_profile_id()));
create policy gift_deliveries_party_read on gift_deliveries for select using(sender_profile_id=current_profile_id() or recipient_profile_id=current_profile_id());
create policy creator_subscription_tiers_read on creator_subscription_tiers for select using(enabled=true or creator_id=current_profile_id());
create policy creator_entitlements_party_read on creator_subscription_entitlements for select using(subscriber_id=current_profile_id() or creator_id=current_profile_id());
create policy creator_earning_policy_active_read on creator_earning_policies for select using(state='active');
create policy gifter_milestones_owner_read on gifter_milestone_history for select using(profile_id=current_profile_id());
-- Webhook events, ledger, payouts, reconciliation and ranking reset runs are service-only.
-- No client policies are created for these tables.

create or replace function enforce_balanced_ledger_entry()
returns trigger language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_entry uuid;
 v_total bigint;
 v_units integer;
begin
 v_entry:=coalesce(new.entry_id,old.entry_id);
 select coalesce(sum(delta),0),count(distinct unit) into v_total,v_units
 from public.ledger_postings where entry_id=v_entry;
 if v_units>1 then raise exception 'LEDGER_UNIT_MISMATCH'; end if;
 if v_total<>0 then raise exception 'LEDGER_ENTRY_UNBALANCED'; end if;
 return null;
end;
$$;
drop trigger if exists ledger_postings_balanced on ledger_postings;
create constraint trigger ledger_postings_balanced
after insert or update or delete on ledger_postings
deferrable initially deferred
for each row execute function enforce_balanced_ledger_entry();

create or replace function post_gift(
 p_sender_account uuid,
 p_recipient_account uuid,
 p_price bigint,
 p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
 v_entry uuid;
 v_sender_kind text;
 v_sender_balance bigint;
begin
 if p_price is null or p_price<=0 then raise exception 'INVALID_GIFT_PRICE'; end if;
 if p_sender_account=p_recipient_account then raise exception 'SELF_GIFT_NOT_ALLOWED'; end if;
 if coalesce(length(trim(p_idempotency_key)),0)<16 then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
 select id into v_entry from public.ledger_entries where idempotency_key=p_idempotency_key;
 if found then return v_entry; end if;
 select kind into v_sender_kind from public.wallet_accounts where id=p_sender_account for update;
 if v_sender_kind is null then raise exception 'NO_ACCOUNT'; end if;
 perform 1 from public.wallet_accounts where id=p_recipient_account;
 if not found then raise exception 'NO_RECIPIENT_ACCOUNT'; end if;
 select coalesce(sum(delta),0) into v_sender_balance from public.ledger_postings where account_id=p_sender_account and unit='coins';
 if v_sender_kind='user' and v_sender_balance<p_price then raise exception 'INSUFFICIENT_FUNDS'; end if;
 insert into public.ledger_entries(idempotency_key,unit,type) values(p_idempotency_key,'coins','gift') returning id into v_entry;
 insert into public.ledger_postings(entry_id,account_id,delta,unit)
 values(v_entry,p_sender_account,-p_price,'coins'),(v_entry,p_recipient_account,p_price,'coins');
 return v_entry;
end;
$$;

-- Ranking periods are scheduled by a server-side worker using America/Jamaica.
-- Closing a period preserves prior aggregates; current monthly rankings reset by period key, not deletion.
