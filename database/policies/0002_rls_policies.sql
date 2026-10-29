-- ZUNO row-level security (migration 0002). Idempotent: drop-if-exists before create.
-- Enabling RLS alone does not secure a table — each policy below is explicit and
-- least-privilege. Service-role connections bypass RLS and are server-side only.

-- Helper: current profile id from the Supabase auth JWT.
create or replace function current_profile_id() returns uuid
language sql stable as $$
  select id from profiles where auth_user_id = auth.uid()
$$;

-- profiles --------------------------------------------------------------
alter table profiles enable row level security;
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select
  using (
    visibility = 'public'
    or auth_user_id = auth.uid()
    or (visibility = 'restricted' and exists (
      select 1 from follows f where f.follower_id = current_profile_id() and f.followee_id = profiles.id))
  );
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update
  using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());
drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert
  with check (auth_user_id = auth.uid());

-- posts -----------------------------------------------------------------
alter table posts enable row level security;
drop policy if exists posts_select on posts;
create policy posts_select on posts for select
  using (
    deleted_at is null and (
      audience = 'public'
      or author_id = current_profile_id()
      or (audience = 'followers' and exists (
        select 1 from follows f where f.follower_id = current_profile_id() and f.followee_id = posts.author_id))
    )
    and not exists (select 1 from blocks b where b.blocker_id = posts.author_id and b.blocked_id = current_profile_id())
  );
drop policy if exists posts_write on posts;
create policy posts_write on posts for all
  using (author_id = current_profile_id()) with check (author_id = current_profile_id());

-- messages: only conversation members ----------------------------------
alter table messages enable row level security;
drop policy if exists messages_select on messages;
create policy messages_select on messages for select
  using (exists (select 1 from conversation_members m
                 where m.conversation_id = messages.conversation_id and m.profile_id = current_profile_id()));
drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert
  with check (sender_id = current_profile_id() and exists (
    select 1 from conversation_members m
    where m.conversation_id = messages.conversation_id and m.profile_id = current_profile_id()));

-- notifications: owner only --------------------------------------------
alter table notifications enable row level security;
drop policy if exists notifications_owner on notifications;
create policy notifications_owner on notifications for all
  using (profile_id = current_profile_id()) with check (profile_id = current_profile_id());

-- wallet/ledger: NO client access. Only service role (which bypasses RLS)
-- may read/write. Enabling RLS with no permissive policy denies all anon/user access.
alter table wallet_accounts enable row level security;
alter table ledger_entries enable row level security;
alter table ledger_postings enable row level security;
alter table recharge_purchases enable row level security;
alter table creator_earnings enable row level security;
alter table payouts enable row level security;
drop policy if exists recharge_owner_read on recharge_purchases;
create policy recharge_owner_read on recharge_purchases for select
  using (profile_id = current_profile_id());

-- gift_definitions: world-readable catalog (no secrets) ----------------
alter table gift_definitions enable row level security;
drop policy if exists gifts_read on gift_definitions;
create policy gifts_read on gift_definitions for select using (true);

-- live_rooms: public rooms visible; private only to host/participants ---
alter table live_rooms enable row level security;
drop policy if exists live_select on live_rooms;
create policy live_select on live_rooms for select
  using (not is_private or host_id = current_profile_id()
         or exists (select 1 from live_participants p where p.room_id = live_rooms.id and p.profile_id = current_profile_id()));
