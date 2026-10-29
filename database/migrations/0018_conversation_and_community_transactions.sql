-- Transactional creation of conversations and communities.
create or replace function public.create_conversation(
  p_creator_profile_id uuid,
  p_member_profile_ids uuid[],
  p_is_group boolean,
  p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_members uuid[];
  v_member_count integer;
  v_profile_count integer;
  v_request_hash text;
  v_existing_hash text;
  v_response jsonb;
  v_conversation_id uuid;
begin
  if p_creator_profile_id is null then raise exception 'CONVERSATION_CREATOR_REQUIRED'; end if;
  if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>180 then
    raise exception 'CONVERSATION_IDEMPOTENCY_KEY_INVALID';
  end if;
  select array_agg(member_id order by member_id) into v_members
  from (
    select distinct member_id
    from unnest(coalesce(p_member_profile_ids,'{}'::uuid[]) || array[p_creator_profile_id]) as members(member_id)
    where member_id is not null
  ) unique_members;
  v_member_count:=coalesce(cardinality(v_members),0);
  if p_is_group and (v_member_count<2 or v_member_count>250) then raise exception 'GROUP_MEMBER_COUNT_INVALID'; end if;
  if not coalesce(p_is_group,false) and v_member_count<>2 then raise exception 'DIRECT_CONVERSATION_REQUIRES_TWO_MEMBERS'; end if;
  select count(*) into v_profile_count from public.profiles where id=any(v_members);
  if v_profile_count<>v_member_count then raise exception 'CONVERSATION_MEMBER_NOT_FOUND'; end if;
  v_request_hash:=md5(coalesce(p_is_group,false)::text||':'||array_to_string(v_members,','));

  perform pg_advisory_xact_lock(hashtextextended('conversation:'||p_creator_profile_id::text||':'||p_idempotency_key,0));
  select request_hash,response_body into v_existing_hash,v_response
  from public.api_idempotency_keys
  where scope='conversation:'||p_creator_profile_id::text and idempotency_key=p_idempotency_key
  for update;
  if found then
    if v_existing_hash<>v_request_hash then raise exception 'CONVERSATION_IDEMPOTENCY_CONFLICT'; end if;
    if v_response ? 'conversationId' then return (v_response->>'conversationId')::uuid; end if;
    raise exception 'CONVERSATION_CREATION_IN_PROGRESS';
  end if;

  insert into public.api_idempotency_keys(scope,idempotency_key,request_hash,state)
  values('conversation:'||p_creator_profile_id::text,p_idempotency_key,v_request_hash,'started');

  if not coalesce(p_is_group,false) and exists(
    select 1 from public.blocks b
    where (b.blocker_id=v_members[1] and b.blocked_id=v_members[2])
       or (b.blocker_id=v_members[2] and b.blocked_id=v_members[1])
  ) then raise exception 'DIRECT_MESSAGE_BLOCKED'; end if;

  if not coalesce(p_is_group,false) then
    select c.id into v_conversation_id
    from public.conversations c
    join public.conversation_members cm on cm.conversation_id=c.id
    where c.is_group=false and cm.profile_id=any(v_members)
    group by c.id
    having count(*)=v_member_count
       and count(*) filter(where cm.profile_id=any(v_members))=v_member_count
       and (select count(*) from public.conversation_members all_members where all_members.conversation_id=c.id)=v_member_count
    limit 1;
  end if;

  if v_conversation_id is null then
    insert into public.conversations(is_group) values(coalesce(p_is_group,false)) returning id into v_conversation_id;
    insert into public.conversation_members(conversation_id,profile_id,role)
      select v_conversation_id,member_id,case when member_id=p_creator_profile_id then 'owner' else 'member' end
      from unnest(v_members) as members(member_id);
    insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values(
      'conversation-created:'||p_creator_profile_id::text||':'||p_idempotency_key,
      'conversation.created','conversation',v_conversation_id::text,
      jsonb_build_object('conversationId',v_conversation_id,'creatorProfileId',p_creator_profile_id,'isGroup',coalesce(p_is_group,false))
    ) on conflict(event_key) do nothing;
  end if;

  update public.api_idempotency_keys
  set state='completed',response_status=201,response_body=jsonb_build_object('conversationId',v_conversation_id)
  where scope='conversation:'||p_creator_profile_id::text and idempotency_key=p_idempotency_key;
  return v_conversation_id;
end;
$$;
revoke all on function public.create_conversation(uuid,uuid[],boolean,text) from public;
revoke all on function public.create_conversation(uuid,uuid[],boolean,text) from anon;
revoke all on function public.create_conversation(uuid,uuid[],boolean,text) from authenticated;
grant execute on function public.create_conversation(uuid,uuid[],boolean,text) to service_role;

create or replace function public.create_community_with_owner(
  p_community_id uuid,
  p_owner_profile_id uuid,
  p_name text,
  p_access text,
  p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_hash text;
  v_existing_hash text;
  v_response jsonb;
  v_id uuid;
begin
  if p_community_id is null or p_owner_profile_id is null then raise exception 'COMMUNITY_IDENTITY_REQUIRED'; end if;
  if coalesce(length(trim(p_name)),0)<2 or length(p_name)>120 then raise exception 'INVALID_COMMUNITY_NAME'; end if;
  if p_access not in ('public','private','invite') then raise exception 'INVALID_COMMUNITY_ACCESS'; end if;
  if coalesce(length(trim(p_idempotency_key)),0)<16 or length(p_idempotency_key)>180 then
    raise exception 'COMMUNITY_IDEMPOTENCY_KEY_INVALID';
  end if;
  v_hash:=md5(trim(p_name)||':'||p_access);
  perform pg_advisory_xact_lock(hashtextextended('community:'||p_owner_profile_id::text||':'||p_idempotency_key,0));
  select request_hash,response_body into v_existing_hash,v_response
  from public.api_idempotency_keys
  where scope='community:'||p_owner_profile_id::text and idempotency_key=p_idempotency_key
  for update;
  if found then
    if v_existing_hash<>v_hash then raise exception 'COMMUNITY_IDEMPOTENCY_CONFLICT'; end if;
    if v_response ? 'communityId' then return (v_response->>'communityId')::uuid; end if;
    raise exception 'COMMUNITY_CREATION_IN_PROGRESS';
  end if;

  insert into public.api_idempotency_keys(scope,idempotency_key,request_hash,state)
  values('community:'||p_owner_profile_id::text,p_idempotency_key,v_hash,'started');
  insert into public.communities(id,owner_id,name,access)
  values(p_community_id,p_owner_profile_id,trim(p_name),p_access)
  returning id into v_id;
  insert into public.community_members(community_id,profile_id,role) values(v_id,p_owner_profile_id,'owner');
  insert into public.community_channels(community_id,slug,name,description,channel_type,created_by)
  values(v_id,'general','General','Community discussions','chat',p_owner_profile_id);
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values(
    'community-created:'||p_owner_profile_id::text||':'||p_idempotency_key,
    'community.created','community',v_id::text,
    jsonb_build_object('communityId',v_id,'ownerProfileId',p_owner_profile_id,'access',p_access)
  ) on conflict(event_key) do nothing;
  update public.api_idempotency_keys
  set state='completed',response_status=201,response_body=jsonb_build_object('communityId',v_id)
  where scope='community:'||p_owner_profile_id::text and idempotency_key=p_idempotency_key;
  return v_id;
end;
$$;
revoke all on function public.create_community_with_owner(uuid,uuid,text,text,text) from public;
revoke all on function public.create_community_with_owner(uuid,uuid,text,text,text) from anon;
revoke all on function public.create_community_with_owner(uuid,uuid,text,text,text) from authenticated;
grant execute on function public.create_community_with_owner(uuid,uuid,text,text,text) to service_role;
