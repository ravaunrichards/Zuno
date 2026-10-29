-- Audited moderator report decisions and protected operations overview.
alter table public.moderation_actions add column if not exists report_id uuid references public.reports(id) on delete set null;
alter table public.moderation_actions add column if not exists reason_code text;
alter table public.moderation_actions add column if not exists note text;
alter table public.moderation_actions add column if not exists detail jsonb not null default '{}'::jsonb;
alter table public.reports add column if not exists resolved_at timestamptz;
alter table public.reports add column if not exists resolution_code text;
alter table public.reports add column if not exists resolution_note text;
create index if not exists reports_queue_idx on public.reports(state,created_at) where state in ('open','reviewing','appealed');
create index if not exists moderation_actions_report_idx on public.moderation_actions(report_id,created_at desc);

create or replace function public.get_admin_overview()
returns table(profile_count bigint,post_count bigint,live_room_count bigint,open_report_count bigint,reviewing_report_count bigint,failed_payment_event_count bigint,pending_refund_count bigint,pending_payout_count bigint)
language sql stable security definer set search_path=public,pg_temp as $$
 select
  (select count(*) from public.profiles),
  (select count(*) from public.posts where deleted_at is null),
  (select count(*) from public.live_rooms where state='live'),
  (select count(*) from public.reports where state='open'),
  (select count(*) from public.reports where state='reviewing'),
  (select count(*) from public.payment_webhook_events where processing_state in ('failed','received')),
  (select count(*) from public.refund_records where state in ('requested','approved','processing')),
  (select count(*) from public.payouts where state in ('requested','processing'))
$$;
revoke all on function public.get_admin_overview() from public;
revoke all on function public.get_admin_overview() from anon;
revoke all on function public.get_admin_overview() from authenticated;
grant execute on function public.get_admin_overview() to service_role;

create or replace function public.resolve_moderation_report(
 p_report_id uuid,p_moderator_profile_id uuid,p_decision text,p_reason_code text,p_note text
) returns table(report_id uuid,new_state text,moderation_action_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.reports%rowtype; v_action_id uuid; v_target_id uuid;
begin
 if p_report_id is null or p_moderator_profile_id is null then raise exception 'MODERATION_REQUEST_INVALID'; end if;
 if p_decision is null or p_decision not in ('dismiss','mark_reviewing','remove_content') then raise exception 'MODERATION_DECISION_INVALID'; end if;
 if coalesce(length(trim(p_reason_code)),0)<2 or length(p_reason_code)>80 or p_reason_code !~ '^[A-Za-z0-9_.:-]+$' then raise exception 'MODERATION_REASON_INVALID'; end if;
 if p_note is not null and length(p_note)>500 then raise exception 'MODERATION_NOTE_TOO_LONG'; end if;
 if not exists(select 1 from public.roles where profile_id=p_moderator_profile_id and role in ('moderator','admin')) then raise exception 'MODERATION_ROLE_REQUIRED'; end if;
 select * into v_report from public.reports where id=p_report_id for update;
 if not found then raise exception 'REPORT_NOT_FOUND'; end if;
 if v_report.state not in ('open','reviewing','appealed') then raise exception 'REPORT_ALREADY_RESOLVED'; end if;
 if p_decision='remove_content' then
   if v_report.target_type='post' then
     if v_report.target_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then raise exception 'MODERATION_TARGET_INVALID'; end if;
     v_target_id:=v_report.target_id::uuid; update public.posts set deleted_at=coalesce(deleted_at,now()) where id=v_target_id;
     if not found then raise exception 'MODERATION_TARGET_NOT_FOUND'; end if;
   elsif v_report.target_type='comment' then
     if v_report.target_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then raise exception 'MODERATION_TARGET_INVALID'; end if;
     v_target_id:=v_report.target_id::uuid; update public.comments set deleted_at=coalesce(deleted_at,now()) where id=v_target_id;
     if not found then raise exception 'MODERATION_TARGET_NOT_FOUND'; end if;
   else raise exception 'MODERATION_TARGET_TYPE_UNSUPPORTED';
   end if;
 end if;
 insert into public.moderation_actions(moderator_id,target_type,target_id,action,report_id,reason_code,note,detail)
 values(p_moderator_profile_id,v_report.target_type,v_report.target_id,p_decision,p_report_id,p_reason_code,nullif(trim(p_note),''),jsonb_build_object('previousState',v_report.state))
 returning id into v_action_id;
 update public.reports set state=case p_decision when 'dismiss' then 'dismissed' when 'mark_reviewing' then 'reviewing' else 'actioned' end,
  resolved_at=case when p_decision='mark_reviewing' then null else now() end,
  resolution_code=p_reason_code,resolution_note=nullif(trim(p_note),'') where id=p_report_id;
 insert into public.audit_events(actor_id,action,detail)
 values(p_moderator_profile_id,'moderation.report.'||p_decision,jsonb_build_object('reportId',p_report_id,'targetType',v_report.target_type,'targetId',v_report.target_id,'reasonCode',p_reason_code,'moderationActionId',v_action_id));
 return query select p_report_id,case p_decision when 'dismiss' then 'dismissed' when 'mark_reviewing' then 'reviewing' else 'actioned' end,v_action_id;
end;
$$;
revoke all on function public.resolve_moderation_report(uuid,uuid,text,text,text) from public;
revoke all on function public.resolve_moderation_report(uuid,uuid,text,text,text) from anon;
revoke all on function public.resolve_moderation_report(uuid,uuid,text,text,text) from authenticated;
grant execute on function public.resolve_moderation_report(uuid,uuid,text,text,text) to service_role;
