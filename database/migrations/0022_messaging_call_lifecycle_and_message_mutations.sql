-- Durable, access-controlled audio/video calls and sender-owned message edits.
create or replace function public.enforce_message_identity_immutability()
returns trigger
language plpgsql security definer
set search_path=public,pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.conversation_id is distinct from old.conversation_id
     or new.sender_id is distinct from old.sender_id
     or new.created_at is distinct from old.created_at then
    raise exception 'MESSAGE_IDENTITY_IMMUTABLE';
  end if;
  if old.deleted_at is not null
     and (new.body is distinct from old.body
       or new.attachments is distinct from old.attachments
       or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'MESSAGE_ALREADY_DELETED';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_message_identity_immutability() from public,anon,authenticated;
drop trigger if exists messages_identity_immutable on public.messages;
create trigger messages_identity_immutable
before update on public.messages
for each row execute function public.enforce_message_identity_immutability();

create index if not exists call_participants_active_idx
  on public.call_participants(call_id,last_state) where last_state='joined' and left_at is null;
create index if not exists call_sessions_state_created_idx on public.call_sessions(state,created_at desc);

drop policy if exists messages_sender_update on public.messages;
create policy messages_sender_update on public.messages for update
 using(sender_id=public.current_profile_id() and public.is_conversation_member(conversation_id))
 with check(sender_id=public.current_profile_id() and public.is_conversation_member(conversation_id));

create or replace function public.create_call_session(
 p_call_id uuid,p_conversation_id uuid,p_initiated_by uuid,p_call_type text,p_invited_profile_ids uuid[]
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ids uuid[]; v_count integer; v_provider_room text; v_member uuid;
begin
 if p_call_id is null or p_initiated_by is null then raise exception 'CALL_IDENTITY_REQUIRED'; end if;
 if p_call_type not in ('audio','video') then raise exception 'CALL_TYPE_INVALID'; end if;
 if not exists(select 1 from public.conversation_members where conversation_id=p_conversation_id and profile_id=p_initiated_by) then
  raise exception 'CALL_CONVERSATION_ACCESS_DENIED';
 end if;
 select array_agg(member_id order by member_id) into v_ids from (
  select distinct id as member_id from unnest(coalesce(p_invited_profile_ids,'{}'::uuid[])||array[p_initiated_by]) as invitees(id)
 ) d;
 v_count:=coalesce(cardinality(v_ids),0);
 if v_count<2 or v_count>8 then raise exception 'CALL_PARTICIPANT_COUNT_INVALID'; end if;
 if (select count(*) from public.conversation_members where conversation_id=p_conversation_id and profile_id=any(v_ids))<>v_count then raise exception 'CALL_INVITE_NOT_CONVERSATION_MEMBER'; end if;
 if exists(select 1 from public.blocks b where
  (b.blocker_id=any(v_ids) and b.blocked_id=any(v_ids) and b.blocker_id<>b.blocked_id)) then raise exception 'CALL_BLOCK_RELATION_EXISTS'; end if;
 perform pg_advisory_xact_lock(hashtextextended('zuno-call:'||p_conversation_id::text,0));
 if exists(select 1 from public.call_sessions where conversation_id=p_conversation_id and state in ('created','ringing','active')) then
  raise exception 'CALL_ALREADY_ACTIVE';
 end if;
 v_provider_room:='zuno-call-'||replace(p_call_id::text,'-','');
 insert into public.call_sessions(id,conversation_id,initiated_by,provider,provider_room,call_type,state,started_at)
 values(p_call_id,p_conversation_id,p_initiated_by,'livekit',v_provider_room,p_call_type,'ringing',now());
 foreach v_member in array v_ids loop
  insert into public.call_participants(call_id,profile_id,invited_at,joined_at,last_state)
  values(p_call_id,v_member,now(),case when v_member=p_initiated_by then now() else null end,
   case when v_member=p_initiated_by then 'joined' else 'ringing' end);
 end loop;
 insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
 values('call-created:'||p_call_id::text,'call.created','call_session',p_call_id::text,
  jsonb_build_object('callId',p_call_id,'conversationId',p_conversation_id,'initiatedBy',p_initiated_by,'callType',p_call_type))
 on conflict(event_key) do nothing;
 return p_call_id;
end;
$$;
revoke all on function public.create_call_session(uuid,uuid,uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.create_call_session(uuid,uuid,uuid,text,uuid[]) to service_role;

create or replace function public.join_call_session(p_call_id uuid,p_profile_id uuid)
returns table(call_id uuid,provider_room text,call_type text,state text,participant_count integer)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_call public.call_sessions%rowtype; v_part public.call_participants%rowtype; v_count integer;
begin
 select * into v_call from public.call_sessions where id=p_call_id for update;
 if not found then raise exception 'CALL_NOT_FOUND'; end if;
 select * into v_part from public.call_participants where call_id=p_call_id and profile_id=p_profile_id for update;
 if not found then raise exception 'CALL_INVITATION_REQUIRED'; end if;
 if v_part.last_state in ('declined','missed','left') or v_part.left_at is not null then raise exception 'CALL_PARTICIPATION_CLOSED'; end if;
 if v_call.state not in ('ringing','active') then raise exception 'CALL_NOT_JOINABLE'; end if;
 select count(*) into v_count from public.call_participants where call_id=p_call_id and left_at is null and last_state='joined';
 if v_part.last_state<>'joined' and v_count>=8 then raise exception 'CALL_FULL'; end if;
 update public.call_participants set joined_at=coalesce(joined_at,now()),left_at=null,last_state='joined' where call_id=p_call_id and profile_id=p_profile_id;
 update public.call_sessions set state='active',started_at=coalesce(started_at,now()) where id=p_call_id;
 return query select c.id,c.provider_room,c.call_type,c.state,
  (select count(*)::integer from public.call_participants cp where cp.call_id=c.id and cp.left_at is null and cp.last_state='joined')
 from public.call_sessions c where c.id=p_call_id;
end;
$$;
revoke all on function public.join_call_session(uuid,uuid) from public,anon,authenticated;
grant execute on function public.join_call_session(uuid,uuid) to service_role;

create or replace function public.leave_call_session(p_call_id uuid,p_profile_id uuid,p_decline boolean)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_call public.call_sessions%rowtype; v_part public.call_participants%rowtype; v_active integer;
begin
 select * into v_call from public.call_sessions where id=p_call_id for update;
 if not found then raise exception 'CALL_NOT_FOUND'; end if;
 select * into v_part from public.call_participants where call_id=p_call_id and profile_id=p_profile_id for update;
 if not found then raise exception 'CALL_PARTICIPANT_NOT_FOUND'; end if;
 if v_part.left_at is not null or v_part.last_state in ('left','declined','missed') then return 'left'; end if;
 update public.call_participants set left_at=now(),last_state=case when p_decline and joined_at is null then 'declined' else 'left' end where call_id=p_call_id and profile_id=p_profile_id;
 select count(*) into v_active from public.call_participants where call_id=p_call_id and left_at is null and last_state='joined';
 if v_active=0 then update public.call_sessions set state='ended',ended_at=coalesce(ended_at,now()) where id=p_call_id and state in ('created','ringing','active');
 else update public.call_sessions set state='active' where id=p_call_id and state='ringing'; end if;
 return 'left';
end;
$$;
revoke all on function public.leave_call_session(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.leave_call_session(uuid,uuid,boolean) to service_role;
