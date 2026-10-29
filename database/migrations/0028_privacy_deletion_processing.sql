-- Asynchronous account deletion. Anonymized financial/audit rows remain for reconciliation.
alter table public.profiles add column if not exists is_deleted boolean not null default false;
alter table public.profiles add column if not exists deleted_at timestamptz;
alter table public.profiles alter column auth_user_id drop not null;

alter table public.data_requests add column if not exists deletion_context jsonb;

create or replace function public.current_profile_id() returns uuid
language sql stable security definer
set search_path=public,pg_temp as $privacy_current_profile$
  select id from public.profiles where auth_user_id=auth.uid() and not is_deleted limit 1
$privacy_current_profile$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (not is_deleted and (
    visibility='public'
    or auth_user_id=auth.uid()
    or (visibility='restricted' and exists(
      select 1 from public.follows f
      where f.follower_id=public.current_profile_id() and f.followee_id=profiles.id
    ))
  ));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (auth_user_id=auth.uid() and not is_deleted)
  with check (auth_user_id=auth.uid() and not is_deleted);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert
  with check (auth_user_id=auth.uid() and not is_deleted);

create index if not exists data_requests_deletion_claim_idx
  on public.data_requests(run_after,requested_at)
  where request_type='deletion' and state in ('submitted','processing');

create table if not exists public.privacy_deletion_jobs (
  data_request_id uuid primary key references public.data_requests(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  auth_user_id uuid,
  storage_paths jsonb not null default '[]'::jsonb,
  avatar_url text,
  cover_url text,
  prepared_at timestamptz not null default now()
);
alter table public.privacy_deletion_jobs enable row level security;
revoke all on public.privacy_deletion_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.privacy_deletion_jobs to service_role;

create or replace function public.claim_privacy_deletion(p_worker text)
returns setof public.data_requests
language plpgsql security definer
set search_path=public,pg_temp as $privacy_claim$
declare v_request public.data_requests%rowtype;
begin
  if coalesce(length(trim(p_worker)),0)<1 or length(p_worker)>120 then raise exception 'INVALID_WORKER_ID'; end if;
  update public.data_requests
  set state='failed',locked_at=null,locked_by=null,updated_at=now(),
      resolution_code='DELETION_ATTEMPTS_EXHAUSTED',last_error_code='DELETION_ATTEMPTS_EXHAUSTED'
  where request_type='deletion' and state='processing' and attempt_count>=3
    and (locked_at is null or locked_at<now()-interval '10 minutes');

  select * into v_request from public.data_requests d
  where d.request_type='deletion' and d.attempt_count<3 and d.run_after<=now()
    and (d.state='submitted' or (d.state='processing' and (d.locked_at is null or d.locked_at<now()-interval '10 minutes')))
  order by d.requested_at for update skip locked limit 1;
  if not found then return; end if;
  update public.data_requests d
  set state='processing',attempt_count=d.attempt_count+1,locked_at=now(),locked_by=p_worker,
      updated_at=now(),last_error_code=null
  where d.id=v_request.id returning d.* into v_request;
  return next v_request;
end;
$privacy_claim$;
revoke all on function public.claim_privacy_deletion(text) from public,anon,authenticated;
grant execute on function public.claim_privacy_deletion(text) to service_role;

create or replace function public.prepare_privacy_deletion(p_request_id uuid,p_worker text)
returns jsonb
language plpgsql security definer
set search_path=public,pg_temp as $privacy_prepare$
declare
  v_request public.data_requests%rowtype;
  v_profile public.profiles%rowtype;
  v_context public.privacy_deletion_jobs%rowtype;
  v_paths jsonb;
begin
  select * into v_request from public.data_requests d
  where d.id=p_request_id and d.request_type='deletion' and d.state='processing' and d.locked_by=p_worker
  for update;
  if not found then raise exception 'PRIVACY_DELETION_LEASE_NOT_OWNED'; end if;
  select * into v_context from public.privacy_deletion_jobs where data_request_id=p_request_id for update;
  if found then
    return jsonb_build_object('requestId',v_context.data_request_id,'profileId',v_context.profile_id,
      'authUserId',v_context.auth_user_id,'storagePaths',v_context.storage_paths,
      'avatarUrl',v_context.avatar_url,'coverUrl',v_context.cover_url);
  end if;

  select * into v_profile from public.profiles where id=v_request.profile_id for update;
  if not found then raise exception 'PRIVACY_DELETION_PROFILE_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(path),'[]'::jsonb) into v_paths from (
    select a.storage_path as path from public.media_assets a where a.uploader_id=v_profile.id
    union
    select d.result_storage_path as path from public.data_requests d
      where d.profile_id=v_profile.id and d.result_storage_path is not null
  ) owned_paths;

  insert into public.privacy_deletion_jobs(data_request_id,profile_id,auth_user_id,storage_paths,avatar_url,cover_url)
  values(p_request_id,v_profile.id,v_profile.auth_user_id,v_paths,v_profile.avatar_url,v_profile.cover_url)
  returning * into v_context;

  update public.profiles
  set is_deleted=true,deleted_at=coalesce(deleted_at,now()),
      username='deleted_'||replace(v_profile.id::text,'-',''),
      display_name='Deleted user',bio=null,avatar_url=null,cover_url=null,
      visibility='private',is_creator=false,is_verified=false,updated_at=now()
  where id=v_profile.id;
  update public.marketplace_listings set status='removed',updated_at=now()
    where seller_id=v_profile.id and status in ('draft','active','paused');
  update public.creator_subscription_tiers set enabled=false,updated_at=now()
    where creator_id=v_profile.id and enabled=true;

  update public.data_requests
  set state=case when state in ('submitted','reviewing','processing') then 'failed' else state end,
      resolution_code=case when id<>p_request_id and state in ('submitted','reviewing','processing') then 'ACCOUNT_DELETION_IN_PROGRESS' else resolution_code end,
      result_storage_path=null,result_byte_size=null,result_sha256=null,request_reason=null,updated_at=now()
  where profile_id=v_profile.id and id<>p_request_id;

  return jsonb_build_object('requestId',v_context.data_request_id,'profileId',v_context.profile_id,
    'authUserId',v_context.auth_user_id,'storagePaths',v_context.storage_paths,
    'avatarUrl',v_context.avatar_url,'coverUrl',v_context.cover_url);
end;
$privacy_prepare$;
revoke all on function public.prepare_privacy_deletion(uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_privacy_deletion(uuid,text) to service_role;

create or replace function public.finish_privacy_deletion(p_request_id uuid,p_worker text,p_success boolean,p_error_code text default null)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $privacy_finish$
declare
  v_request public.data_requests%rowtype;
  v_job public.privacy_deletion_jobs%rowtype;
  v_profile_id uuid;
  v_next_state text;
  v_target record;
begin
  select * into v_request from public.data_requests d
  where d.id=p_request_id and d.request_type='deletion' and d.state='processing' and d.locked_by=p_worker
  for update;
  if not found then raise exception 'PRIVACY_DELETION_LEASE_NOT_OWNED'; end if;

  if not coalesce(p_success,false) then
    v_next_state:=case when v_request.attempt_count>=3 then 'failed' else 'submitted' end;
    update public.data_requests
    set state=v_next_state,
        run_after=now()+make_interval(secs=>least(3600,30*power(2,greatest(0,attempt_count-1))::integer)),
        updated_at=now(),locked_at=null,locked_by=null,
        last_error_code=left(coalesce(nullif(p_error_code,''),'PRIVACY_DELETION_FAILED'),100),
        resolution_code=case when v_next_state='failed' then 'DELETION_PROCESSING_FAILED' else null end
    where id=p_request_id;
    return v_next_state;
  end if;

  select * into v_job from public.privacy_deletion_jobs where data_request_id=p_request_id for update;
  if not found then raise exception 'PRIVACY_DELETION_CONTEXT_NOT_FOUND'; end if;
  v_profile_id:=v_job.profile_id;

  for v_target in
    select * from (values
      ('comments','author_id'),('reactions','profile_id'),
      ('message_reactions','profile_id'),('message_read_receipts','profile_id'),
      ('call_participants','profile_id'),('call_sessions','initiated_by'),('messages','sender_id'),('story_replies','author_id'),('stories','author_id'),
      ('story_views','viewer_id'),('post_bookmarks','profile_id'),('post_reposts','profile_id'),
      ('post_view_events','profile_id'),('post_share_events','profile_id'),
      ('feed_preferences','profile_id'),('recommendation_feedback','profile_id'),
      ('recommendation_events','profile_id'),('search_events','profile_id'),
      ('community_posts','author_id'),('community_post_reactions','profile_id'),
      ('community_event_rsvps','profile_id'),('live_chat_messages','author_id'),
      ('live_questions','asker_id'),('live_poll_votes','voter_id'),
      ('live_room_moderators','profile_id'),('live_room_moderators','added_by'),
      ('follows','follower_id'),('follows','followee_id'),
      ('blocks','blocker_id'),('blocks','blocked_id'),
      ('muted_profiles','muted_profile_id'),('restricted_profiles','restricted_profile_id'),
      ('community_members','profile_id'),('conversation_members','profile_id'),
      ('live_participants','profile_id'),('guest_requests','requester_id'),
      ('push_subscriptions','profile_id'),('notification_preferences','profile_id'),
      ('notifications','profile_id'),('media_assets','uploader_id'),
      ('gifter_progress','profile_id'),('ranking_aggregates','profile_id'),
      ('roles','profile_id'),('creator_subscription_entitlements','subscriber_id'),
      ('creator_subscription_entitlements','profile_id')
    ) as targets(table_name,column_name)
  loop
    if to_regclass('public.'||v_target.table_name) is not null
       and exists(select 1 from information_schema.columns c
        where c.table_schema='public' and c.table_name=v_target.table_name and c.column_name=v_target.column_name) then
      execute format('delete from public.%I where %I=$1',v_target.table_name,v_target.column_name) using v_profile_id;
    end if;
  end loop;

  delete from public.posts where author_id=v_profile_id;
  delete from public.communities where owner_id=v_profile_id;
  delete from public.events where host_id=v_profile_id;
  delete from public.live_rooms where host_id=v_profile_id;
  delete from public.conversations c where not exists(
    select 1 from public.conversation_members cm where cm.conversation_id=c.id
  );

  update public.creator_subscriptions set state='cancelled',updated_at=now()
    where (subscriber_id=v_profile_id or creator_id=v_profile_id) and state in ('active','grace');
  update public.data_requests
  set request_reason=null,result_storage_path=null,result_byte_size=null,result_sha256=null,
      deletion_context=null,updated_at=now()
  where profile_id=v_profile_id;
  update public.profiles
  set auth_user_id=null,is_deleted=true,deleted_at=coalesce(deleted_at,now()),
      username='deleted_'||replace(v_profile_id::text,'-',''),
      display_name='Deleted user',bio=null,avatar_url=null,cover_url=null,
      visibility='private',is_creator=false,is_verified=false,updated_at=now()
  where id=v_profile_id;

  insert into public.wallet_restrictions(profile_id,state,reason_code,updated_at)
  values(v_profile_id,'active','ACCOUNT_DELETED',now())
  on conflict(profile_id) do update set state='active',reason_code='ACCOUNT_DELETED',updated_at=now(),cleared_at=null;

  update public.data_requests
  set state='completed',completed_at=now(),updated_at=now(),locked_at=null,locked_by=null,
      last_error_code=null,resolution_code='ACCOUNT_PERSONAL_DATA_ERASED'
  where id=p_request_id and profile_id=v_profile_id;

  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values('privacy-deletion-completed:'||p_request_id::text,'privacy.deletion.completed','data_request',p_request_id::text,
    jsonb_build_object('requestId',p_request_id,'profileId',v_profile_id,'completedAt',now()))
  on conflict(event_key) do nothing;
  delete from public.privacy_deletion_jobs where data_request_id=p_request_id;
  return 'completed';
end;
$privacy_finish$;
revoke all on function public.finish_privacy_deletion(uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.finish_privacy_deletion(uuid,text,boolean,text) to service_role;
