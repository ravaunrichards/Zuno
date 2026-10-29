-- ZUNO core schema (versioned migration 0001).
-- Supabase/PostgreSQL. Idempotent where practical (IF NOT EXISTS).
-- Covers the required domains from the brief, Section 10.1.

create extension if not exists "pgcrypto";

-- ---------- Identity & profiles ----------
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique not null,
  username text unique not null,
  display_name text,
  bio text,
  avatar_url text,
  cover_url text,
  visibility text not null default 'public' check (visibility in ('public','private','restricted')),
  is_creator boolean not null default false,
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists roles (
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null check (role in ('user','creator','live_host','guest','moderator','community_manager','business','support','finance','admin')),
  primary key (profile_id, role)
);

-- ---------- Social graph ----------
create table if not exists follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  followee_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create table if not exists blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

-- ---------- Content ----------
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in ('short_video','long_video','photo','gallery','text','audio','story')),
  caption text,
  media jsonb not null default '[]'::jsonb,
  audience text not null default 'public' check (audience in ('public','followers','private')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists posts_author_idx on posts(author_id, created_at desc);

create table if not exists reactions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null default 'like',
  created_at timestamptz not null default now(),
  unique (post_id, profile_id, kind)
);
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  parent_id uuid references comments(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ---------- Messaging ----------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member',
  primary key (conversation_id, profile_id)
);
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  body text,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index if not exists messages_conv_idx on messages(conversation_id, created_at desc);

-- ---------- Communities & events ----------
create table if not exists communities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  access text not null default 'public' check (access in ('public','private','invite')),
  created_at timestamptz not null default now()
);
create table if not exists community_members (
  community_id uuid not null references communities(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('member','moderator','owner')),
  primary key (community_id, profile_id)
);
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  tz text not null default 'America/Jamaica',
  created_at timestamptz not null default now()
);

-- ---------- LIVE ----------
create table if not exists live_rooms (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  title text,
  category text,
  state text not null default 'scheduled' check (state in ('scheduled','live','ended')),
  is_private boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists live_participants (
  room_id uuid not null references live_rooms(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('host','guest','viewer')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (room_id, profile_id)
);
create table if not exists guest_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references live_rooms(id) on delete cascade,
  requester_id uuid not null references profiles(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','accepted','rejected','expired','cancelled')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (room_id, requester_id, state)
);

-- ---------- Economy ----------
create table if not exists gift_definitions (
  id text primary key,                       -- stable gift id (never changes)
  name text not null,
  category text not null,
  tier int not null,
  price_coins bigint not null check (price_coins > 0),
  unlock_rule text not null default 'none',
  model_path text not null,
  audio_path text,
  audio_status text not null default 'not_required',
  asset_version text not null default '1.0.0',
  license text not null
);
create table if not exists wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete cascade,
  kind text not null default 'user' check (kind in ('user','mint','sink')),
  unique (profile_id)
);
create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text unique not null,
  unit text not null check (unit in ('coins','diamonds','league_points','ad_credits','cash')),
  type text not null,
  created_at timestamptz not null default now()
);
create table if not exists ledger_postings (
  entry_id uuid not null references ledger_entries(id) on delete cascade,
  account_id uuid not null references wallet_accounts(id),
  delta bigint not null,
  unit text not null
);
create table if not exists recharge_purchases (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  package_id text not null,
  coins bigint not null,
  amount_usd numeric(10,2) not null,
  provider text not null default 'paypal',
  provider_order_id text,
  provider_capture_id text unique,           -- idempotency anchor for coin credit
  state text not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists gifter_progress (
  profile_id uuid primary key references profiles(id) on delete cascade,
  eligible_lifetime_coins bigint not null default 0,
  level int not null default 0,
  ultimate_universe boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------- Subscriptions, earnings, payouts ----------
create table if not exists creator_subscriptions (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references profiles(id) on delete cascade,
  creator_id uuid not null references profiles(id) on delete cascade,
  tier text not null,
  state text not null default 'active' check (state in ('active','cancelled','expired','grace')),
  current_period_end timestamptz,
  provider_subscription_id text unique,
  created_at timestamptz not null default now()
);
create table if not exists creator_earnings (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles(id) on delete cascade,
  source text not null,
  gross_minor bigint not null,
  provider_fee_minor bigint not null default 0,
  creator_share_minor bigint not null,
  platform_share_minor bigint not null,
  split_policy text not null,
  created_at timestamptz not null default now()
);
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles(id) on delete cascade,
  amount_minor bigint not null,
  state text not null default 'requested' check (state in ('requested','processing','paid','failed')),
  provider_batch_id text,
  created_at timestamptz not null default now()
);

-- ---------- Moderation, notifications, rankings ----------
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  target_type text not null,
  target_id text not null,
  reason text,
  state text not null default 'open' check (state in ('open','reviewing','actioned','dismissed','appealed')),
  created_at timestamptz not null default now()
);
create table if not exists moderation_actions (
  id uuid primary key default gen_random_uuid(),
  moderator_id uuid references profiles(id),
  target_type text not null,
  target_id text not null,
  action text not null,
  created_at timestamptz not null default now()
);
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_unread_idx on notifications(profile_id) where read_at is null;
create table if not exists ranking_aggregates (
  id uuid primary key default gen_random_uuid(),
  scope text not null,            -- global|country|creator|room|friends
  period text not null,           -- weekly|monthly|all_time
  period_start timestamptz not null,
  actor_id uuid not null references profiles(id) on delete cascade,
  coins bigint not null default 0,
  unique (scope, period, period_start, actor_id)
);

-- ---------- Audit ----------
create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
