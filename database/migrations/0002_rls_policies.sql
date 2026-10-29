-- ZUNO row-level security (migration 0002). Idempotent: drop-if-exists before create.
-- Enabling RLS alone does not secure a table — each policy below is explicit and
-- least-privilege. Service-role connections bypass RLS and are server-side only.

-- Helper: current profile id from the Supabase auth JWT.
create or replace function current_profile_id() returns uuid
language sql stable security definer
set search_path = public, pg_temp as $
  select id from public.profiles where auth_user_id = auth.uid()
$;

create or replace function is_conversation_member(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $
  select exists (select 1 from public.conversation_members m where m.conversation_id = p_conversation_id and m.profile_id = public.current_profile_id())
$;
create or replace function is_live_room_participant(p_room_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $
  select exists (select 1 from public.live_participants p where p.room_id = p_room_id and p.profile_id = public.current_profile_id())
$;
create or replace function is_community_member(p_community_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $
  select exists (select 1 from public.community_members m where m.community_id = p_community_id and m.profile_id = public.current_profile_id())
$;
create or replace function is_moderator_or_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $
  select exists (select 1 from public.roles r where r.profile_id = public.current_profile_id() and r.role in ('moderator','admin','support'))
$;
create or replace function can_view_post(p_post_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $
  select exists (select 1 from public.posts p where p.id = p_post_id and p.deleted_at is null and
    (p.audience = 'public' or p.author_id = public.current_profile_id() or
    (p.audience = 'followers' and exists (select 1 from public.follows f where f.follower_id = public.current_profile_id() and f.followee_id = p.author_id)))
    and not exists (select 1 from public.blocks b where
      (b.blocker_id = public.current_profile_id() and b.blocked_id = (select p2.author_id from public.posts p2 where p2.id=p_post_id)) or
      (b.blocked_id = public.current_profile_id() and b.blocker_id = (select p3.author_id from public.posts p3 where p3.id=p_post_id)))
$;

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


-- Core ownership and least-privilege policies for remaining schema tables.
alter table roles enable row level security;
alter table follows enable row level security;
alter table blocks enable row level security;
alter table reactions enable row level security;
alter table comments enable row level security;
alter table conversations enable row level security;
alter table conversation_members enable row level security;
alter table communities enable row level security;
alter table community_members enable row level security;
alter table events enable row level security;
alter table live_participants enable row level security;
alter table guest_requests enable row level security;
alter table gifter_progress enable row level security;
alter table creator_subscriptions enable row level security;
alter table ranking_aggregates enable row level security;
alter table reports enable row level security;
alter table moderation_actions enable row level security;
alter table audit_events enable row level security;

create policy roles_owner_read on roles for select using (profile_id = current_profile_id());
create policy follows_participant_read on follows for select using (follower_id = current_profile_id() or followee_id = current_profile_id());
create policy follows_self_insert on follows for insert with check (follower_id = current_profile_id() and follower_id <> followee_id);
create policy follows_self_delete on follows for delete using (follower_id = current_profile_id());
create policy blocks_owner_read on blocks for select using (blocker_id = current_profile_id());
create policy blocks_owner_insert on blocks for insert with check (blocker_id = current_profile_id() and blocker_id <> blocked_id);
create policy blocks_owner_delete on blocks for delete using (blocker_id = current_profile_id());

create policy reactions_visible_read on reactions for select using (can_view_post(post_id));
create policy reactions_self_insert on reactions for insert with check (profile_id = current_profile_id() and can_view_post(post_id));
create policy reactions_self_delete on reactions for delete using (profile_id = current_profile_id());
create policy comments_visible_read on comments for select using (deleted_at is null and can_view_post(post_id));
create policy comments_self_insert on comments for insert with check (author_id = current_profile_id() and length(trim(body)) > 0 and can_view_post(post_id));
create policy comments_self_update on comments for update using (author_id = current_profile_id()) with check (author_id = current_profile_id());
create policy comments_self_delete on comments for delete using (author_id = current_profile_id());

drop policy if exists messages_select on messages;
create policy messages_select on messages for select using (is_conversation_member(conversation_id));
drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert with check (sender_id = current_profile_id() and is_conversation_member(conversation_id));
create policy conversations_member_read on conversations for select using (is_conversation_member(id));
create policy conversation_members_member_read on conversation_members for select using (profile_id = current_profile_id() or is_conversation_member(conversation_id));

create policy communities_visible_read on communities for select using (access = 'public' or owner_id = current_profile_id() or is_community_member(id));
create policy communities_owner_insert on communities for insert with check (owner_id = current_profile_id());
create policy communities_owner_update on communities for update using (owner_id = current_profile_id()) with check (owner_id = current_profile_id());
create policy communities_owner_delete on communities for delete using (owner_id = current_profile_id());
create policy community_members_visible_read on community_members for select using (profile_id = current_profile_id() or is_community_member(community_id) or exists (select 1 from communities c where c.id = community_members.community_id and c.access = 'public'));
create policy community_members_self_join on community_members for insert with check (
  profile_id = current_profile_id() and role = 'member'
  and exists (select 1 from communities c where c.id = community_id and c.access = 'public')
);
create policy community_members_self_leave on community_members for delete using (profile_id = current_profile_id() and role = 'member');

create policy events_public_read on events for select using (true);
create policy events_host_insert on events for insert with check (host_id = current_profile_id());
create policy events_host_update on events for update using (host_id = current_profile_id()) with check (host_id = current_profile_id());
create policy live_participants_room_read on live_participants for select using (profile_id = current_profile_id() or is_live_room_participant(room_id));
create policy guest_requests_participant_read on guest_requests for select using (requester_id = current_profile_id() or exists (select 1 from live_rooms r where r.id = room_id and r.host_id = current_profile_id()));
create policy guest_requests_self_insert on guest_requests for insert with check (requester_id = current_profile_id() and exists (select 1 from live_rooms r where r.id = room_id and r.state = 'live'));
create policy guest_requests_host_update on guest_requests for update using (exists (select 1 from live_rooms r where r.id = room_id and r.host_id = current_profile_id())) with check (exists (select 1 from live_rooms r where r.id = room_id and r.host_id = current_profile_id()));

create policy gifter_progress_owner_read on gifter_progress for select using (profile_id = current_profile_id());
create policy creator_subscriptions_party_read on creator_subscriptions for select using (subscriber_id = current_profile_id() or creator_id = current_profile_id());
create policy ranking_aggregates_public_read on ranking_aggregates for select using (true);
create policy reports_reporter_read on reports for select using (reporter_id = current_profile_id() or is_moderator_or_admin());
create policy reports_self_insert on reports for insert with check (reporter_id = current_profile_id());
create policy moderation_actions_moderator_read on moderation_actions for select using (is_moderator_or_admin());
-- No client policies for audit_events, wallet_accounts, ledger_entries, ledger_postings,
-- creator_earnings or payouts: RLS denies ordinary client access to these records.
