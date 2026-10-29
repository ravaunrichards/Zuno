-- ZUNO LIVE lifecycle, persisted participation, guest requests and poll creation.
-- LiveKit credentials/tokens are still issued only by the authenticated API server.

alter table public.guest_requests drop constraint if exists guest_requests_room_id_requester_id_state_key;
create unique index if not exists guest_requests_one_pending_idx
  on public.guest_requests(room_id,requester_id) where state='pending';
create index if not exists live_participants_active_room_idx
  on public.live_participants(room_id,role) where left_at is null;
create index if not exists guest_requests_pending_room_idx
  on public.guest_requests(room_id,created_at) where state='pending';

create or replace function public.create_live_room(
  p_room_id uuid,
  p_host_profile_id uuid,
  p_title text,
  p_category text,
  p_is_private boolean
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room_id uuid;
begin
  if p_room_id is null or p_host_profile_id is null then raise exception 'LIVE_ROOM_REQUEST_INVALID'; end if;
  if coalesce(length(trim(p_title)),0)<2 or length(trim(p_title))>120 then raise exception 'LIVE_ROOM_TITLE_INVALID'; end if;
  if coalesce(length(trim(p_category)),0)<2 or length(trim(p_category))>80 then raise exception 'LIVE_ROOM_CATEGORY_INVALID'; end if;
  if not exists(select 1 from public.profiles where id=p_host_profile_id) then raise exception 'LIVE_HOST_NOT_FOUND'; end if;
  insert into public.live_rooms(id,host_id,title,category,state,is_private,started_at,ended_at)
    values(p_room_id,p_host_profile_id,trim(p_title),trim(p_category),'scheduled',coalesce(p_is_private,false),null,null)
    returning id into v_room_id;
  insert into public.live_participants(room_id,profile_id,role,joined_at,left_at)
    values(v_room_id,p_host_profile_id,'host',now(),null)
    on conflict(room_id,profile_id) do update set role='host',joined_at=now(),left_at=null;
  insert into public.live_room_events(room_id,event_type,payload)
    values(v_room_id,'room.created',jsonb_build_object('hostProfileId',p_host_profile_id,'private',coalesce(p_is_private,false)));
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('live-room-created:'||v_room_id::text,'live.room.created','live_room',v_room_id::text,
      jsonb_build_object('roomId',v_room_id,'hostProfileId',p_host_profile_id))
    on conflict(event_key) do nothing;
  return v_room_id;
end;
$$;
revoke all on function public.create_live_room(uuid,uuid,text,text,boolean) from public;
revoke all on function public.create_live_room(uuid,uuid,text,text,boolean) from anon;
revoke all on function public.create_live_room(uuid,uuid,text,text,boolean) from authenticated;
grant execute on function public.create_live_room(uuid,uuid,text,text,boolean) to service_role;

create or replace function public.start_live_room(p_room_id uuid,p_host_profile_id uuid)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room public.live_rooms%rowtype;
begin
  select * into v_room from public.live_rooms where id=p_room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.host_id<>p_host_profile_id then raise exception 'LIVE_HOST_REQUIRED'; end if;
  if v_room.state='ended' then raise exception 'LIVE_ROOM_ENDED'; end if;
  if v_room.state='live' then return 'live'; end if;
  update public.live_rooms set state='live',started_at=coalesce(started_at,now()),ended_at=null where id=p_room_id;
  insert into public.live_room_events(room_id,event_type,payload)
    values(p_room_id,'room.started',jsonb_build_object('hostProfileId',p_host_profile_id));
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('live-room-started:'||p_room_id::text,'live.room.started','live_room',p_room_id::text,jsonb_build_object('roomId',p_room_id))
    on conflict(event_key) do nothing;
  return 'live';
end;
$$;
revoke all on function public.start_live_room(uuid,uuid) from public;
revoke all on function public.start_live_room(uuid,uuid) from anon;
revoke all on function public.start_live_room(uuid,uuid) from authenticated;
grant execute on function public.start_live_room(uuid,uuid) to service_role;

create or replace function public.end_live_room(p_room_id uuid,p_host_profile_id uuid)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room public.live_rooms%rowtype;
begin
  select * into v_room from public.live_rooms where id=p_room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.host_id<>p_host_profile_id then raise exception 'LIVE_HOST_REQUIRED'; end if;
  if v_room.state='ended' then return 'ended'; end if;
  update public.live_rooms set state='ended',ended_at=now() where id=p_room_id;
  update public.live_participants set left_at=coalesce(left_at,now()) where room_id=p_room_id and left_at is null;
  update public.guest_requests set state='rejected',resolved_at=now() where room_id=p_room_id and state='pending';
  update public.live_polls set state='closed',closed_at=now() where room_id=p_room_id and state='open';
  insert into public.live_room_events(room_id,event_type,payload)
    values(p_room_id,'room.ended',jsonb_build_object('hostProfileId',p_host_profile_id));
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('live-room-ended:'||p_room_id::text,'live.room.ended','live_room',p_room_id::text,jsonb_build_object('roomId',p_room_id))
    on conflict(event_key) do nothing;
  return 'ended';
end;
$$;
revoke all on function public.end_live_room(uuid,uuid) from public;
revoke all on function public.end_live_room(uuid,uuid) from anon;
revoke all on function public.end_live_room(uuid,uuid) from authenticated;
grant execute on function public.end_live_room(uuid,uuid) to service_role;

create or replace function public.join_live_room(p_room_id uuid,p_profile_id uuid)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room public.live_rooms%rowtype;
  v_role text;
begin
  select * into v_room from public.live_rooms where id=p_room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.state<>'live' then raise exception 'LIVE_ROOM_NOT_LIVE'; end if;
  if exists(select 1 from public.blocks b where
    (b.blocker_id=p_profile_id and b.blocked_id=v_room.host_id)
    or (b.blocker_id=v_room.host_id and b.blocked_id=p_profile_id)) then
    raise exception 'LIVE_BLOCK_RELATION_EXISTS';
  end if;
  select role into v_role from public.live_participants
    where room_id=p_room_id and profile_id=p_profile_id and left_at is null;
  if found then return v_role; end if;
  if v_room.is_private and not exists(
    select 1 from public.guest_requests
    where room_id=p_room_id and requester_id=p_profile_id and state='accepted'
  ) then raise exception 'LIVE_ROOM_ACCESS_DENIED'; end if;
  insert into public.live_participants(room_id,profile_id,role,joined_at,left_at)
    values(p_room_id,p_profile_id,'viewer',now(),null)
    on conflict(room_id,profile_id) do update set role='viewer',joined_at=now(),left_at=null;
  insert into public.live_room_events(room_id,event_type,payload)
    values(p_room_id,'participant.joined',jsonb_build_object('profileId',p_profile_id,'role','viewer'));
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('live-joined:'||p_room_id::text||':'||p_profile_id::text||':'||txid_current()::text,
      'live.participant.joined','live_room',p_room_id::text,jsonb_build_object('roomId',p_room_id,'profileId',p_profile_id,'role','viewer'));
  return 'viewer';
end;
$$;
revoke all on function public.join_live_room(uuid,uuid) from public;
revoke all on function public.join_live_room(uuid,uuid) from anon;
revoke all on function public.join_live_room(uuid,uuid) from authenticated;
grant execute on function public.join_live_room(uuid,uuid) to service_role;

create or replace function public.leave_live_room(p_room_id uuid,p_profile_id uuid)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room public.live_rooms%rowtype;
  v_role text;
begin
  select * into v_room from public.live_rooms where id=p_room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.host_id=p_profile_id then raise exception 'LIVE_HOST_MUST_END_ROOM'; end if;
  update public.live_participants set left_at=coalesce(left_at,now())
    where room_id=p_room_id and profile_id=p_profile_id and left_at is null returning role into v_role;
  if v_role is null then return 'left'; end if;
  insert into public.live_room_events(room_id,event_type,payload)
    values(p_room_id,'participant.left',jsonb_build_object('profileId',p_profile_id,'role',v_role));
  return 'left';
end;
$$;
revoke all on function public.leave_live_room(uuid,uuid) from public;
revoke all on function public.leave_live_room(uuid,uuid) from anon;
revoke all on function public.leave_live_room(uuid,uuid) from authenticated;
grant execute on function public.leave_live_room(uuid,uuid) to service_role;

create or replace function public.create_live_guest_request(p_room_id uuid,p_requester_profile_id uuid)
returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room public.live_rooms%rowtype;
  v_id uuid;
begin
  select * into v_room from public.live_rooms where id=p_room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.state<>'live' then raise exception 'LIVE_ROOM_NOT_LIVE'; end if;
  if v_room.host_id=p_requester_profile_id then raise exception 'LIVE_HOST_CANNOT_REQUEST';
  end if;
  if exists(select 1 from public.blocks b where
    (b.blocker_id=p_requester_profile_id and b.blocked_id=v_room.host_id)
    or (b.blocker_id=v_room.host_id and b.blocked_id=p_requester_profile_id)) then
    raise exception 'LIVE_BLOCK_RELATION_EXISTS';
  end if;
  if exists(select 1 from public.live_participants where room_id=p_room_id and profile_id=p_requester_profile_id and left_at is null and role in ('host','guest')) then
    raise exception 'LIVE_ALREADY_PUBLISHING';
  end if;
  select id into v_id from public.guest_requests
    where room_id=p_room_id and requester_id=p_requester_profile_id and state='pending' limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.guest_requests(room_id,requester_id,state,created_at)
    values(p_room_id,p_requester_profile_id,'pending',now())
    returning id into v_id;
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('live-guest-request:'||v_id::text,'live.guest.requested','guest_request',v_id::text,
      jsonb_build_object('roomId',p_room_id,'requesterProfileId',p_requester_profile_id))
    on conflict(event_key) do nothing;
  return v_id;
end;
$$;
revoke all on function public.create_live_guest_request(uuid,uuid) from public;
revoke all on function public.create_live_guest_request(uuid,uuid) from anon;
revoke all on function public.create_live_guest_request(uuid,uuid) from authenticated;
grant execute on function public.create_live_guest_request(uuid,uuid) to service_role;

create or replace function public.accept_live_guest_request(p_request_id uuid,p_host_profile_id uuid)
returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_request public.guest_requests%rowtype;
  v_room public.live_rooms%rowtype;
  v_speakers integer;
begin
  select * into v_request from public.guest_requests where id=p_request_id for update;
  if not found then raise exception 'LIVE_GUEST_REQUEST_NOT_FOUND'; end if;
  select * into v_room from public.live_rooms where id=v_request.room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.host_id<>p_host_profile_id then raise exception 'LIVE_HOST_REQUIRED'; end if;
  if v_room.state<>'live' then raise exception 'LIVE_ROOM_NOT_LIVE'; end if;
  if v_request.state='accepted' then
    return v_request.requester_id;
  end if;
  if v_request.state<>'pending' then raise exception 'LIVE_GUEST_REQUEST_NOT_PENDING'; end if;
  if v_request.created_at < now()-interval '2 minutes' then
    update public.guest_requests set state='expired',resolved_at=now() where id=p_request_id;
    raise exception 'LIVE_GUEST_REQUEST_EXPIRED';
  end if;
  if exists(select 1 from public.blocks b where
    (b.blocker_id=v_request.requester_id and b.blocked_id=v_room.host_id)
    or (b.blocker_id=v_room.host_id and b.blocked_id=v_request.requester_id)) then raise exception 'LIVE_BLOCK_RELATION_EXISTS'; end if;
  select count(*) into v_speakers from public.live_participants
    where room_id=v_room.id and left_at is null and role in ('host','guest');
  if v_speakers>=8 then raise exception 'LIVE_ROOM_FULL'; end if;
  update public.guest_requests set state='accepted',resolved_at=now() where id=p_request_id;
  insert into public.live_participants(room_id,profile_id,role,joined_at,left_at)
    values(v_room.id,v_request.requester_id,'guest',now(),null)
    on conflict(room_id,profile_id) do update set role='guest',joined_at=now(),left_at=null;
  insert into public.live_room_events(room_id,event_type,payload)
    values(v_room.id,'guest.accepted',jsonb_build_object('requestId',p_request_id,'profileId',v_request.requester_id));
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('live-guest-accepted:'||p_request_id::text,'live.guest.accepted','guest_request',p_request_id::text,
      jsonb_build_object('roomId',v_room.id,'requesterProfileId',v_request.requester_id))
    on conflict(event_key) do nothing;
  return v_request.requester_id;
end;
$$;
revoke all on function public.accept_live_guest_request(uuid,uuid) from public;
revoke all on function public.accept_live_guest_request(uuid,uuid) from anon;
revoke all on function public.accept_live_guest_request(uuid,uuid) from authenticated;
grant execute on function public.accept_live_guest_request(uuid,uuid) to service_role;

create or replace function public.reject_live_guest_request(p_request_id uuid,p_host_profile_id uuid)
returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_request public.guest_requests%rowtype;
  v_room public.live_rooms%rowtype;
begin
  select * into v_request from public.guest_requests where id=p_request_id for update;
  if not found then raise exception 'LIVE_GUEST_REQUEST_NOT_FOUND'; end if;
  select * into v_room from public.live_rooms where id=v_request.room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.host_id<>p_host_profile_id then raise exception 'LIVE_HOST_REQUIRED'; end if;
  if v_request.state='rejected' then return 'rejected'; end if;
  if v_request.state<>'pending' then raise exception 'LIVE_GUEST_REQUEST_NOT_PENDING'; end if;
  update public.guest_requests set state='rejected',resolved_at=now() where id=p_request_id;
  insert into public.live_room_events(room_id,event_type,payload)
    values(v_room.id,'guest.rejected',jsonb_build_object('requestId',p_request_id,'profileId',v_request.requester_id));
  return 'rejected';
end;
$$;
revoke all on function public.reject_live_guest_request(uuid,uuid) from public;
revoke all on function public.reject_live_guest_request(uuid,uuid) from anon;
revoke all on function public.reject_live_guest_request(uuid,uuid) from authenticated;
grant execute on function public.reject_live_guest_request(uuid,uuid) to service_role;

create or replace function public.create_live_poll(
 p_room_id uuid,p_host_profile_id uuid,p_question text,p_options text[],p_closes_at timestamptz
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_room public.live_rooms%rowtype;
  v_poll_id uuid;
  v_option text;
  v_pos integer:=0;
begin
  select * into v_room from public.live_rooms where id=p_room_id for update;
  if not found then raise exception 'LIVE_ROOM_NOT_FOUND'; end if;
  if v_room.host_id<>p_host_profile_id then raise exception 'LIVE_HOST_REQUIRED'; end if;
  if v_room.state<>'live' then raise exception 'LIVE_ROOM_NOT_LIVE'; end if;
  if coalesce(length(trim(p_question)),0)<1 or length(trim(p_question))>500 then raise exception 'LIVE_POLL_QUESTION_INVALID'; end if;
  if p_options is null or array_length(p_options,1)<2 or array_length(p_options,1)>8 then raise exception 'LIVE_POLL_OPTION_COUNT_INVALID'; end if;
  if p_closes_at is not null and p_closes_at<=now() then raise exception 'LIVE_POLL_CLOSE_TIME_INVALID'; end if;
  if exists(select 1 from unnest(p_options) o where coalesce(length(trim(o)),0)<1 or length(trim(o))>200) then raise exception 'LIVE_POLL_OPTION_INVALID'; end if;
  if (select count(distinct lower(trim(o))) from unnest(p_options) o)<>array_length(p_options,1) then raise exception 'LIVE_POLL_OPTIONS_DUPLICATE'; end if;
  insert into public.live_polls(room_id,host_id,question,state,closes_at)
    values(p_room_id,p_host_profile_id,trim(p_question),'open',p_closes_at) returning id into v_poll_id;
  foreach v_option in array p_options loop
    insert into public.live_poll_options(poll_id,label,position)
      values(v_poll_id,trim(v_option),v_pos);
    v_pos:=v_pos+1;
  end loop;
  insert into public.live_room_events(room_id,event_type,payload)
    values(p_room_id,'poll.created',jsonb_build_object('pollId',v_poll_id,'hostProfileId',p_host_profile_id));
  return v_poll_id;
end;
$$;
revoke all on function public.create_live_poll(uuid,uuid,text,text[],timestamptz) from public;
revoke all on function public.create_live_poll(uuid,uuid,text,text[],timestamptz) from anon;
revoke all on function public.create_live_poll(uuid,uuid,text,text[],timestamptz) from authenticated;
grant execute on function public.create_live_poll(uuid,uuid,text,text[],timestamptz) to service_role;

create or replace function public.get_live_room_summaries(p_room_ids uuid[])
returns table(room_id uuid,viewer_count bigint,speaker_count bigint,pending_guest_requests bigint)
language sql stable security definer
set search_path=public,pg_temp as $$
  select r.id,
    count(lp.profile_id) filter(where lp.left_at is null and lp.role='viewer')::bigint,
    count(lp.profile_id) filter(where lp.left_at is null and lp.role in ('host','guest'))::bigint,
    (select count(*) from public.guest_requests gr where gr.room_id=r.id and gr.state='pending')::bigint
  from public.live_rooms r
  left join public.live_participants lp on lp.room_id=r.id
  where r.id=any(coalesce(p_room_ids,'{}'::uuid[]))
  group by r.id
$$;
revoke all on function public.get_live_room_summaries(uuid[]) from public;
revoke all on function public.get_live_room_summaries(uuid[]) from anon;
revoke all on function public.get_live_room_summaries(uuid[]) from authenticated;
grant execute on function public.get_live_room_summaries(uuid[]) to service_role;
