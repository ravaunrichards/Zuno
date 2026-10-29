-- Atomic owner-scoped block, mute and restrict operations.
create or replace function public.set_profile_relationship(
 p_owner_profile_id uuid,
 p_target_profile_id uuid,
 p_kind text,
 p_action text,
 p_reason_code text default null
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
begin
 if p_owner_profile_id is null or p_target_profile_id is null then raise exception 'RELATIONSHIP_ID_REQUIRED'; end if;
 if p_owner_profile_id=p_target_profile_id then raise exception 'SELF_RELATIONSHIP_FORBIDDEN'; end if;
 if p_kind not in ('block','mute','restrict') then raise exception 'RELATIONSHIP_KIND_INVALID'; end if;
 if p_action not in ('add','remove') then raise exception 'RELATIONSHIP_ACTION_INVALID'; end if;
 if not exists(select 1 from public.profiles where id=p_owner_profile_id) then raise exception 'RELATIONSHIP_OWNER_NOT_FOUND'; end if;
 if not exists(select 1 from public.profiles where id=p_target_profile_id) then raise exception 'RELATIONSHIP_TARGET_NOT_FOUND'; end if;
 if p_reason_code is not null and (length(p_reason_code)>80 or p_reason_code !~ '^[A-Za-z0-9_.:-]+$') then
   raise exception 'RELATIONSHIP_REASON_INVALID';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('relationship:'||p_owner_profile_id::text||':'||p_target_profile_id::text,0));
 if p_kind='block' then
   if p_action='add' then
     insert into public.blocks(blocker_id,blocked_id) values(p_owner_profile_id,p_target_profile_id)
     on conflict(blocker_id,blocked_id) do nothing;
     delete from public.follows
      where (follower_id=p_owner_profile_id and followee_id=p_target_profile_id)
         or (follower_id=p_target_profile_id and followee_id=p_owner_profile_id);
   else
     delete from public.blocks where blocker_id=p_owner_profile_id and blocked_id=p_target_profile_id;
   end if;
 elsif p_kind='mute' then
   if p_action='add' then
     insert into public.muted_profiles(profile_id,muted_profile_id) values(p_owner_profile_id,p_target_profile_id)
     on conflict(profile_id,muted_profile_id) do nothing;
   else
     delete from public.muted_profiles where profile_id=p_owner_profile_id and muted_profile_id=p_target_profile_id;
   end if;
 else
   if p_action='add' then
     insert into public.restricted_profiles(profile_id,restricted_profile_id,reason_code)
     values(p_owner_profile_id,p_target_profile_id,p_reason_code)
     on conflict(profile_id,restricted_profile_id) do update set reason_code=excluded.reason_code;
   else
     delete from public.restricted_profiles where profile_id=p_owner_profile_id and restricted_profile_id=p_target_profile_id;
   end if;
 end if;
 insert into public.audit_events(actor_id,action,detail)
 values(p_owner_profile_id,'relationship.'||p_kind||'.'||p_action,jsonb_build_object(
   'targetProfileId',p_target_profile_id,'kind',p_kind,
   'reasonCode',case when p_kind='restrict' then p_reason_code else null end
 ));
 return p_action;
end;
$$;
revoke all on function public.set_profile_relationship(uuid,uuid,text,text,text) from public;
revoke all on function public.set_profile_relationship(uuid,uuid,text,text,text) from anon;
revoke all on function public.set_profile_relationship(uuid,uuid,text,text,text) from authenticated;
grant execute on function public.set_profile_relationship(uuid,uuid,text,text,text) to service_role;
