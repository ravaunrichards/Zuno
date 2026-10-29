-- ZUNO content, media processing, stories, saves and discovery feedback.
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  uploader_id uuid not null references profiles(id) on delete cascade,
  post_id uuid references posts(id) on delete set null,
  storage_path text not null unique,
  media_type text not null check (media_type in ('image','video','audio','thumbnail','document')),
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  checksum_sha256 text,
  state text not null default 'uploaded' check (state in ('uploaded','quarantined','processing','ready','failed','deleted')),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists media_assets_uploader_idx on media_assets(uploader_id,created_at desc);
create index if not exists media_assets_processing_idx on media_assets(state,created_at) where state in ('uploaded','processing');

create table if not exists post_bookmarks (
  profile_id uuid not null references profiles(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(profile_id,post_id)
);
create table if not exists post_reposts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  caption text,
  created_at timestamptz not null default now(),
  unique(profile_id,post_id)
);
create table if not exists post_view_events (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  viewer_id uuid references profiles(id) on delete set null,
  session_hash text,
  watch_ms bigint not null default 0 check (watch_ms >= 0),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  check(viewer_id is not null or session_hash is not null)
);
create index if not exists post_view_events_post_idx on post_view_events(post_id,created_at desc);
create table if not exists post_share_events (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  destination text not null check (destination in ('internal','copy_link','external','message')),
  created_at timestamptz not null default now()
);
create table if not exists hashtags (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check(slug ~ '^[a-z0-9_]{1,80}$'),
  label text not null,
  created_at timestamptz not null default now()
);
create table if not exists post_hashtags (
  post_id uuid not null references posts(id) on delete cascade,
  hashtag_id uuid not null references hashtags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id,hashtag_id)
);
create table if not exists stories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id) on delete cascade,
  media_asset_id uuid references media_assets(id) on delete set null,
  media_url text,
  caption text,
  audience text not null default 'public' check(audience in ('public','followers','close_friends')),
  expires_at timestamptz not null default(now()+interval '24 hours'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check(media_asset_id is not null or media_url is not null)
);
create index if not exists stories_expiration_idx on stories(expires_at) where deleted_at is null;
create index if not exists stories_author_idx on stories(author_id,created_at desc);
create table if not exists story_views (
  story_id uuid not null references stories(id) on delete cascade,
  viewer_id uuid not null references profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  completed boolean not null default false,
  primary key(story_id,viewer_id)
);
create table if not exists story_replies (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  body text not null check(length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create table if not exists feed_preferences (
  profile_id uuid primary key references profiles(id) on delete cascade,
  preferred_topics text[] not null default '{}',
  autoplay_video boolean not null default true,
  reduced_motion boolean not null default false,
  data_saver boolean not null default false,
  updated_at timestamptz not null default now()
);
create table if not exists recommendation_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  content_type text not null,
  content_id uuid,
  event_type text not null check(event_type in ('impression','open','watch','skip','like','hide','not_interested','follow')),
  position integer check(position is null or position >= 0),
  created_at timestamptz not null default now()
);
create index if not exists recommendation_events_profile_idx on recommendation_events(profile_id,created_at desc);

alter table media_assets enable row level security;
alter table post_bookmarks enable row level security;
alter table post_reposts enable row level security;
alter table post_view_events enable row level security;
alter table post_share_events enable row level security;
alter table hashtags enable row level security;
alter table post_hashtags enable row level security;
alter table stories enable row level security;
alter table story_views enable row level security;
alter table story_replies enable row level security;
alter table feed_preferences enable row level security;
alter table recommendation_events enable row level security;

create policy media_assets_owner_read on media_assets for select using(uploader_id=current_profile_id());
create policy media_assets_owner_insert on media_assets for insert with check(uploader_id=current_profile_id());
create policy media_assets_owner_update on media_assets for update using(uploader_id=current_profile_id() and state in ('uploaded','failed')) with check(uploader_id=current_profile_id() and state in ('uploaded','failed'));
create policy post_bookmarks_owner on post_bookmarks for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id());
create policy post_reposts_visible_read on post_reposts for select using(profile_id=current_profile_id() or can_view_post(post_id));
create policy post_reposts_owner_insert on post_reposts for insert with check(profile_id=current_profile_id() and can_view_post(post_id));
create policy post_reposts_owner_delete on post_reposts for delete using(profile_id=current_profile_id());
create policy post_view_events_self_read on post_view_events for select using(viewer_id=current_profile_id());
create policy post_share_events_self_read on post_share_events for select using(actor_id=current_profile_id());
create policy hashtags_public_read on hashtags for select using(true);
create policy post_hashtags_public_read on post_hashtags for select using(can_view_post(post_id));
create policy post_hashtags_author_insert on post_hashtags for insert with check(exists(select 1 from posts p where p.id=post_id and p.author_id=current_profile_id()));
create policy post_hashtags_author_delete on post_hashtags for delete using(exists(select 1 from posts p where p.id=post_id and p.author_id=current_profile_id()));
create policy stories_visible_read on stories for select using(
  deleted_at is null and expires_at>now() and
  (author_id=current_profile_id() or audience='public' or
   (audience='followers' and exists(select 1 from follows f where f.follower_id=current_profile_id() and f.followee_id=stories.author_id)))
);
create policy stories_owner_write on stories for all using(author_id=current_profile_id()) with check(author_id=current_profile_id());
create policy story_views_participant_read on story_views for select using(viewer_id=current_profile_id() or exists(select 1 from stories s where s.id=story_id and s.author_id=current_profile_id()));
create policy story_views_self_insert on story_views for insert with check(viewer_id=current_profile_id() and exists(select 1 from stories s where s.id=story_id and s.author_id<>current_profile_id() and s.expires_at>now() and s.deleted_at is null));
create policy story_replies_participant_read on story_replies for select using(author_id=current_profile_id() or exists(select 1 from stories s where s.id=story_id and s.author_id=current_profile_id()));
create policy story_replies_self_insert on story_replies for insert with check(author_id=current_profile_id() and exists(select 1 from stories s where s.id=story_id and s.expires_at>now() and s.deleted_at is null and s.author_id<>current_profile_id()));
create policy feed_preferences_owner on feed_preferences for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id());
-- Watch/recommendation events are append-only server-side records; no client policy.
