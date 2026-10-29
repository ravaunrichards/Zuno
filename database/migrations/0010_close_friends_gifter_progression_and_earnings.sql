-- ZUNO close-friends access, auditable creator earnings and gifter progression.
create table if not exists close_friends (
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  friend_profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(owner_profile_id,friend_profile_id),
  check(owner_profile_id<>friend_profile_id)
);
alter table close_friends enable row level security;
create policy close_friends_owner_read on close_friends for select using(owner_profile_id=current_profile_id());
create policy close_friends_owner_write on close_friends for all using(owner_profile_id=current_profile_id())
  with check(owner_profile_id=current_profile_id() and owner_profile_id<>friend_profile_id);

create or replace function is_close_friend(p_owner_profile_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.close_friends cf
    where cf.owner_profile_id=p_owner_profile_id and cf.friend_profile_id=public.current_profile_id())
$$;
revoke all on function is_close_friend(uuid) from public;
grant execute on function is_close_friend(uuid) to anon,authenticated,service_role;

drop policy if exists stories_visible_read on stories;
create policy stories_visible_read on stories for select using(
  deleted_at is null and expires_at>now() and (
    author_id=current_profile_id()
    or audience='public'
    or (audience='followers' and exists(select 1 from follows f where f.follower_id=current_profile_id() and f.followee_id=stories.author_id))
    or (audience='close_friends' and is_close_friend(author_id))
  )
);

-- The level schedule is persisted/configurable and includes the exact requested level-50 threshold.
create table if not exists gifter_level_thresholds (
  level smallint primary key check(level between 0 and 50),
  minimum_eligible_lifetime_coins bigint not null unique check(minimum_eligible_lifetime_coins>=0),
  created_at timestamptz not null default now()
);
insert into gifter_level_thresholds(level,minimum_eligible_lifetime_coins)
values(0,0)
on conflict(level) do update set minimum_eligible_lifetime_coins=excluded.minimum_eligible_lifetime_coins;
insert into gifter_level_thresholds(level,minimum_eligible_lifetime_coins)
select level::smallint,round(power(level::numeric/50.0,2.6)*100000000)::bigint
from generate_series(1,50) as levels(level)
on conflict(level) do update set minimum_eligible_lifetime_coins=excluded.minimum_eligible_lifetime_coins;
alter table gifter_level_thresholds enable row level security;
create policy gifter_level_thresholds_public_read on gifter_level_thresholds for select using(true);

alter table gifter_progress add column if not exists eligible_lifetime_coins bigint not null default 0;
alter table gifter_progress add column if not exists level smallint not null default 0;
create unique index if not exists gifter_progress_profile_id_uq on gifter_progress(profile_id);
alter table gifter_progress enable row level security;
drop policy if exists gifter_progress_owner_read on gifter_progress;
create policy gifter_progress_owner_read on gifter_progress for select using(profile_id=current_profile_id());

create or replace function gifter_level_for_coins(p_eligible_coins bigint) returns smallint
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(max(level),0)::smallint from public.gifter_level_thresholds
  where minimum_eligible_lifetime_coins<=greatest(coalesce(p_eligible_coins,0),0)
$$;

create table if not exists creator_earning_entries (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles(id) on delete restrict,
  source_type text not null check(source_type in ('gift','subscription','advertising','commerce','other')),
  source_id text not null,
  gross_minor bigint not null check(gross_minor>=0),
  provider_fee_minor bigint not null default 0 check(provider_fee_minor>=0),
  net_minor bigint generated always as (gross_minor-provider_fee_minor) stored,
  creator_share_minor bigint not null check(creator_share_minor>=0),
  platform_share_minor bigint not null check(platform_share_minor>=0),
  currency char(3) not null default 'USD',
  policy_version text not null references creator_earning_policies(policy_version),
  state text not null default 'pending' check(state in ('pending','available','paid','reversed','held')),
  payout_id uuid references payouts(id) on delete set null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  available_at timestamptz,
  paid_at timestamptz,
  check(provider_fee_minor<=gross_minor),
  check(creator_share_minor+platform_share_minor=gross_minor-provider_fee_minor),
  unique(source_type,source_id,creator_id)
);
create index if not exists creator_earning_entries_creator_idx on creator_earning_entries(creator_id,created_at desc);
create index if not exists creator_earning_entries_available_idx on creator_earning_entries(creator_id,available_at) where state='available';
alter table creator_earning_entries enable row level security;
create policy creator_earning_entries_owner_read on creator_earning_entries for select using(creator_id=current_profile_id());
-- No client insert/update/delete policies: earning rows are derived from verified provider and ledger events.

alter table gift_deliveries add column if not exists state text not null default 'delivered'
  check(state in ('delivered','refunded','reversed'));
create index if not exists gift_deliveries_eligible_sender_idx on gift_deliveries(sender_profile_id,state,delivered_at);


alter table gifter_milestone_history enable row level security;
drop policy if exists gifter_milestones_owner_read on gifter_milestone_history;
create policy gifter_milestones_owner_read on gifter_milestone_history for select using(profile_id=current_profile_id());

create or replace function refresh_gifter_progress(p_profile_id uuid) returns smallint
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_total bigint;
  v_level smallint;
begin
  if p_profile_id is null then raise exception 'PROFILE_REQUIRED'; end if;
  select coalesce(sum(price_coins),0)::bigint into v_total
  from public.gift_deliveries where sender_profile_id=p_profile_id and state='delivered';
  v_level:=public.gifter_level_for_coins(v_total);
  insert into public.gifter_progress(profile_id,eligible_lifetime_coins,level)
  values(p_profile_id,v_total,v_level)
  on conflict(profile_id) do update
    set eligible_lifetime_coins=excluded.eligible_lifetime_coins,level=excluded.level;

  if v_total>=1000000 then
    insert into public.gifter_milestone_history(profile_id,milestone_key,eligible_lifetime_coins)
    values(p_profile_id,'ultimate_universe',v_total) on conflict(profile_id,milestone_key) do nothing;
  end if;
  insert into public.gifter_milestone_history(profile_id,milestone_key,eligible_lifetime_coins)
  select p_profile_id,case level when 10 then 'level_10' when 20 then 'level_20' when 30 then 'level_30' when 40 then 'level_40' when 50 then 'level_50' end,v_total
  from generate_series(10,50,10) as milestone(level)
  where v_level>=milestone.level
  on conflict(profile_id,milestone_key) do nothing;
  return v_level;
end;
$$;
revoke all on function refresh_gifter_progress(uuid) from public;
revoke all on function refresh_gifter_progress(uuid) from anon;
revoke all on function refresh_gifter_progress(uuid) from authenticated;
grant execute on function refresh_gifter_progress(uuid) to service_role;

create or replace function sync_gifter_progress_from_delivery() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_profile uuid;
begin
  if tg_op='DELETE' then v_profile:=old.sender_profile_id;
  else v_profile:=new.sender_profile_id;
  end if;
  perform public.refresh_gifter_progress(v_profile);
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists gift_deliveries_sync_gifter_progress on gift_deliveries;
create trigger gift_deliveries_sync_gifter_progress
after insert or update or delete on gift_deliveries
for each row execute function sync_gifter_progress_from_delivery();
revoke all on function sync_gifter_progress_from_delivery() from public;

-- Gifter thresholds are policy data, not client-editable. Level 0 starts at zero coins;
-- Level 50 is exactly 100,000,000 eligible lifetime gifting coins. The separate
-- Ultimate Universe milestone is awarded at 1,000,000 eligible lifetime coins.
