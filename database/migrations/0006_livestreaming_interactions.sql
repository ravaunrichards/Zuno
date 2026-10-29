-- ZUNO livestream chat, polls, questions, host moderation and recording state.
create or replace function can_view_live_room(p_room_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.live_rooms r where r.id=p_room_id and
  (not r.is_private or r.host_id=public.current_profile_id() or
   exists(select 1 from public.live_participants p where p.room_id=r.id and p.profile_id=public.current_profile_id())))
$$;
create or replace function is_live_room_host(p_room_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.live_rooms r where r.id=p_room_id and r.host_id=public.current_profile_id())
$$;

create table if not exists live_chat_messages (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references live_rooms(id) on delete cascade,
 author_id uuid not null references profiles(id) on delete cascade,
 body text not null check(length(trim(body)) between 1 and 2000),
 is_pinned boolean not null default false,
 deleted_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists live_chat_timeline_idx on live_chat_messages(room_id,created_at desc) where deleted_at is null;
create table if not exists live_polls (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references live_rooms(id) on delete cascade,
 host_id uuid not null references profiles(id) on delete cascade,
 question text not null check(length(trim(question)) between 1 and 500),
 state text not null default 'open' check(state in ('draft','open','closed')),
 closes_at timestamptz,
 created_at timestamptz not null default now(),
 closed_at timestamptz
);
create table if not exists live_poll_options (
 id uuid primary key default gen_random_uuid(),
 poll_id uuid not null references live_polls(id) on delete cascade,
 label text not null check(length(trim(label)) between 1 and 200),
 position integer not null check(position>=0),
 unique(poll_id,position)
);
create table if not exists live_poll_votes (
 poll_id uuid not null references live_polls(id) on delete cascade,
 option_id uuid not null references live_poll_options(id) on delete cascade,
 voter_id uuid not null references profiles(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(poll_id,voter_id)
);
create table if not exists live_questions (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references live_rooms(id) on delete cascade,
 asker_id uuid not null references profiles(id) on delete cascade,
 body text not null check(length(trim(body)) between 1 and 1500),
 state text not null default 'submitted' check(state in ('submitted','selected','answered','dismissed')),
 selected_at timestamptz,
 answered_at timestamptz,
 created_at timestamptz not null default now()
);
create table if not exists live_room_moderators (
 room_id uuid not null references live_rooms(id) on delete cascade,
 profile_id uuid not null references profiles(id) on delete cascade,
 added_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 primary key(room_id,profile_id)
);
create table if not exists live_room_events (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references live_rooms(id) on delete cascade,
 event_type text not null,
 provider_event_id text unique,
 payload jsonb not null default '{}'::jsonb,
 occurred_at timestamptz not null default now()
);
create table if not exists live_recording_assets (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references live_rooms(id) on delete cascade,
 requested_by uuid not null references profiles(id),
 storage_path text,
 duration_ms bigint check(duration_ms is null or duration_ms>=0),
 state text not null default 'requested' check(state in ('requested','recording','processing','ready','failed','deleted')),
 created_at timestamptz not null default now(),
 completed_at timestamptz
);

alter table live_chat_messages enable row level security;
alter table live_polls enable row level security;
alter table live_poll_options enable row level security;
alter table live_poll_votes enable row level security;
alter table live_questions enable row level security;
alter table live_room_moderators enable row level security;
alter table live_room_events enable row level security;
alter table live_recording_assets enable row level security;

create policy live_chat_room_read on live_chat_messages for select using(deleted_at is null and can_view_live_room(room_id));
create policy live_chat_member_insert on live_chat_messages for insert with check(author_id=current_profile_id() and exists(select 1 from live_rooms r where r.id=room_id and r.state='live') and can_view_live_room(room_id));
create policy live_chat_author_delete on live_chat_messages for delete using(author_id=current_profile_id() or is_live_room_host(room_id));
create policy live_polls_visible_read on live_polls for select using(can_view_live_room(room_id));
create policy live_polls_host_write on live_polls for all using(is_live_room_host(room_id) and host_id=current_profile_id()) with check(is_live_room_host(room_id) and host_id=current_profile_id());
create policy live_poll_options_visible_read on live_poll_options for select using(exists(select 1 from live_polls p where p.id=poll_id and can_view_live_room(p.room_id)));
create policy live_poll_options_host_insert on live_poll_options for insert with check(exists(select 1 from live_polls p where p.id=poll_id and is_live_room_host(p.room_id)));
create policy live_poll_options_host_update on live_poll_options for update using(exists(select 1 from live_polls p where p.id=poll_id and is_live_room_host(p.room_id))) with check(exists(select 1 from live_polls p where p.id=poll_id and is_live_room_host(p.room_id)));
create policy live_poll_votes_visible_read on live_poll_votes for select using(voter_id=current_profile_id() or exists(select 1 from live_polls p where p.id=poll_id and is_live_room_host(p.room_id)));
create policy live_poll_votes_self_insert on live_poll_votes for insert with check(voter_id=current_profile_id() and exists(select 1 from live_polls p join live_poll_options o on o.poll_id=p.id and o.id=option_id where p.id=poll_id and p.state='open' and (p.closes_at is null or p.closes_at>now()) and can_view_live_room(p.room_id)));
create policy live_questions_visible_read on live_questions for select using(asker_id=current_profile_id() or is_live_room_host(room_id) or can_view_live_room(room_id));
create policy live_questions_self_insert on live_questions for insert with check(asker_id=current_profile_id() and exists(select 1 from live_rooms r where r.id=room_id and r.state='live') and can_view_live_room(room_id));
create policy live_questions_host_update on live_questions for update using(is_live_room_host(room_id)) with check(is_live_room_host(room_id));
create policy live_room_moderators_host_read on live_room_moderators for select using(profile_id=current_profile_id() or is_live_room_host(room_id));
create policy live_room_moderators_host_insert on live_room_moderators for insert with check(is_live_room_host(room_id) and added_by=current_profile_id());
create policy live_room_moderators_host_delete on live_room_moderators for delete using(is_live_room_host(room_id));
-- Provider events and recording state are written by authorized server/webhook code only.
create policy live_recording_owner_read on live_recording_assets for select using(requested_by=current_profile_id() or is_live_room_host(room_id));
