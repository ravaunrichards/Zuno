-- ZUNO messaging state, calls, communities, channels and event participation.
create or replace function is_message_participant(p_message_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.messages m join public.conversation_members cm on cm.conversation_id=m.conversation_id
 where m.id=p_message_id and cm.profile_id=public.current_profile_id())
$$;
create or replace function is_call_party(p_call_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.call_sessions cs where cs.id=p_call_id and cs.initiated_by=public.current_profile_id())
 or exists(select 1 from public.call_participants cp where cp.call_id=p_call_id and cp.profile_id=public.current_profile_id())
$$;

create table if not exists message_reactions (
 message_id uuid not null references messages(id) on delete cascade,
 profile_id uuid not null references profiles(id) on delete cascade,
 reaction text not null check(reaction in ('like','love','laugh','wow','sad','celebrate','custom')),
 created_at timestamptz not null default now(),
 primary key(message_id,profile_id,reaction)
);
create table if not exists message_read_receipts (
 message_id uuid not null references messages(id) on delete cascade,
 profile_id uuid not null references profiles(id) on delete cascade,
 read_at timestamptz not null default now(),
 primary key(message_id,profile_id)
);
create table if not exists call_sessions (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid references conversations(id) on delete set null,
 initiated_by uuid not null references profiles(id) on delete cascade,
 provider text not null default 'livekit',
 provider_room text unique,
 call_type text not null check(call_type in ('audio','video')),
 state text not null default 'created' check(state in ('created','ringing','active','ended','failed','missed','cancelled')),
 started_at timestamptz,
 ended_at timestamptz,
 created_at timestamptz not null default now(),
 check(ended_at is null or started_at is null or ended_at>=started_at)
);
create index if not exists call_sessions_conversation_idx on call_sessions(conversation_id,created_at desc);
create table if not exists call_participants (
 call_id uuid not null references call_sessions(id) on delete cascade,
 profile_id uuid not null references profiles(id) on delete cascade,
 invited_at timestamptz not null default now(),
 joined_at timestamptz,
 left_at timestamptz,
 last_state text not null default 'invited' check(last_state in ('invited','ringing','joined','declined','missed','left')),
 primary key(call_id,profile_id)
);
create table if not exists community_channels (
 id uuid primary key default gen_random_uuid(),
 community_id uuid not null references communities(id) on delete cascade,
 slug text not null check(slug ~ '^[a-z0-9_-]{1,80}$'),
 name text not null,
 description text,
 channel_type text not null default 'chat' check(channel_type in ('chat','announcement','media','voice','event')),
 created_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 unique(community_id,slug)
);
create index if not exists community_channels_parent_idx on community_channels(community_id,created_at);
create table if not exists community_posts (
 id uuid primary key default gen_random_uuid(),
 community_id uuid not null references communities(id) on delete cascade,
 channel_id uuid references community_channels(id) on delete set null,
 author_id uuid not null references profiles(id) on delete cascade,
 body text,
 attachments jsonb not null default '[]'::jsonb,
 pinned_at timestamptz,
 created_at timestamptz not null default now(),
 edited_at timestamptz,
 deleted_at timestamptz,
 check(coalesce(length(trim(body)),0)>0 or jsonb_array_length(attachments)>0)
);
create index if not exists community_posts_timeline_idx on community_posts(community_id,created_at desc) where deleted_at is null;
create table if not exists community_post_reactions (
 community_post_id uuid not null references community_posts(id) on delete cascade,
 profile_id uuid not null references profiles(id) on delete cascade,
 reaction text not null,
 created_at timestamptz not null default now(),
 primary key(community_post_id,profile_id,reaction)
);
create table if not exists community_event_rsvps (
 event_id uuid not null references events(id) on delete cascade,
 profile_id uuid not null references profiles(id) on delete cascade,
 response text not null default 'going' check(response in ('going','interested','not_going')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(event_id,profile_id)
);
create table if not exists muted_profiles (
 profile_id uuid not null references profiles(id) on delete cascade,
 muted_profile_id uuid not null references profiles(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(profile_id,muted_profile_id),
 check(profile_id<>muted_profile_id)
);
create table if not exists restricted_profiles (
 profile_id uuid not null references profiles(id) on delete cascade,
 restricted_profile_id uuid not null references profiles(id) on delete cascade,
 reason_code text,
 created_at timestamptz not null default now(),
 primary key(profile_id,restricted_profile_id),
 check(profile_id<>restricted_profile_id)
);
create table if not exists notification_preferences (
 profile_id uuid primary key references profiles(id) on delete cascade,
 preferences jsonb not null default '{"push":true,"email":false,"messages":true,"live":true,"creator":true}'::jsonb,
 quiet_hours_start time,
 quiet_hours_end time,
 updated_at timestamptz not null default now()
);

alter table message_reactions enable row level security;
alter table message_read_receipts enable row level security;
alter table call_sessions enable row level security;
alter table call_participants enable row level security;
alter table community_channels enable row level security;
alter table community_posts enable row level security;
alter table community_post_reactions enable row level security;
alter table community_event_rsvps enable row level security;
alter table muted_profiles enable row level security;
alter table restricted_profiles enable row level security;
alter table notification_preferences enable row level security;

create policy message_reactions_member_read on message_reactions for select using(is_message_participant(message_id));
create policy message_reactions_self_write on message_reactions for all using(profile_id=current_profile_id() and is_message_participant(message_id)) with check(profile_id=current_profile_id() and is_message_participant(message_id));
create policy message_receipts_member_read on message_read_receipts for select using(is_message_participant(message_id));
create policy message_receipts_self_write on message_read_receipts for all using(profile_id=current_profile_id() and is_message_participant(message_id)) with check(profile_id=current_profile_id() and is_message_participant(message_id));

create policy call_sessions_party_read on call_sessions for select using(is_call_party(id));
create policy call_sessions_caller_insert on call_sessions for insert with check(initiated_by=current_profile_id() and (conversation_id is null or is_conversation_member(conversation_id)));
create policy call_participants_party_read on call_participants for select using(is_call_party(call_id));
create policy call_participants_self_insert on call_participants for insert with check(profile_id=current_profile_id() and is_call_party(call_id));
create policy community_channels_visible_read on community_channels for select using(exists(select 1 from communities c where c.id=community_id and (c.access='public' or c.owner_id=current_profile_id() or is_community_member(c.id))));
create policy community_channels_manager_insert on community_channels for insert with check(created_by=current_profile_id() and exists(select 1 from communities c where c.id=community_id and (c.owner_id=current_profile_id() or is_community_member(c.id))));
create policy community_posts_visible_read on community_posts for select using(deleted_at is null and exists(select 1 from communities c where c.id=community_id and (c.access='public' or c.owner_id=current_profile_id() or is_community_member(c.id))));
create policy community_posts_member_insert on community_posts for insert with check(author_id=current_profile_id() and is_community_member(community_id));
create policy community_posts_author_update on community_posts for update using(author_id=current_profile_id()) with check(author_id=current_profile_id());
create policy community_post_reactions_visible_read on community_post_reactions for select using(profile_id=current_profile_id() or exists(select 1 from community_posts p join communities c on c.id=p.community_id where p.id=community_post_id and (c.access='public' or is_community_member(c.id))));
create policy community_post_reactions_owner_write on community_post_reactions for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id() and exists(select 1 from community_posts p where p.id=community_post_id and is_community_member(p.community_id)));
create policy event_rsvps_visible_read on community_event_rsvps for select using(profile_id=current_profile_id() or exists(select 1 from events e where e.id=event_id and e.host_id=current_profile_id()));
create policy event_rsvps_self_write on community_event_rsvps for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id());
create policy muted_profiles_owner on muted_profiles for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id() and profile_id<>muted_profile_id);
create policy restricted_profiles_owner_read on restricted_profiles for select using(profile_id=current_profile_id());
create policy restricted_profiles_owner_insert on restricted_profiles for insert with check(profile_id=current_profile_id() and profile_id<>restricted_profile_id);
create policy restricted_profiles_owner_delete on restricted_profiles for delete using(profile_id=current_profile_id());
create policy notification_preferences_owner on notification_preferences for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id());
