-- Retryable external notification delivery queue and profile timezone for quiet hours.
alter table public.notification_preferences add column if not exists timezone text not null default 'America/Jamaica';
alter table public.notification_preferences add constraint notification_preferences_timezone_length
 check(length(timezone) between 1 and 100) not valid;

alter table public.notification_delivery_attempts add column if not exists run_after timestamptz not null default now();
alter table public.notification_delivery_attempts add column if not exists locked_at timestamptz;
alter table public.notification_delivery_attempts add column if not exists locked_by text;
create index if not exists notification_delivery_claim_idx
 on public.notification_delivery_attempts(run_after,created_at)
 where state='queued' and channel in ('push','email');

create or replace function public.create_in_app_delivery_attempt()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.notification_delivery_attempts(notification_id,channel,state,attempt_number,run_after)
 values(new.id,'in_app','delivered',1,now())
 on conflict(notification_id,channel,attempt_number) do nothing;
 insert into public.notification_delivery_attempts(notification_id,channel,state,attempt_number,run_after)
 values(new.id,'push','queued',1,now()),(new.id,'email','queued',1,now())
 on conflict(notification_id,channel,attempt_number) do nothing;
 return new;
end;
$$;
drop trigger if exists notifications_in_app_delivery on public.notifications;
create trigger notifications_in_app_delivery after insert on public.notifications
for each row execute function public.create_in_app_delivery_attempt();

create or replace function public.claim_notification_delivery(p_worker text)
returns setof public.notification_delivery_attempts
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_attempt public.notification_delivery_attempts%rowtype;
begin
 if coalesce(length(trim(p_worker)),0)<1 or length(p_worker)>120 then raise exception 'INVALID_WORKER_ID'; end if;
 select d.* into v_attempt from public.notification_delivery_attempts d
 where d.channel in ('push','email') and d.state='queued' and d.run_after<=now()
   and (d.locked_at is null or d.locked_at<now()-interval '3 minutes')
 order by d.run_after,d.created_at
 for update skip locked limit 1;
 if not found then return; end if;
 update public.notification_delivery_attempts d set locked_at=now(),locked_by=p_worker
 where d.id=v_attempt.id returning d.* into v_attempt;
 return next v_attempt;
end;
$$;
revoke all on function public.claim_notification_delivery(text) from public;
revoke all on function public.claim_notification_delivery(text) from anon;
revoke all on function public.claim_notification_delivery(text) from authenticated;
grant execute on function public.claim_notification_delivery(text) to service_role;

create or replace function public.finish_notification_delivery(
 p_attempt_id uuid,
 p_worker text,
 p_result_state text,
 p_provider_message_id text default null,
 p_error_code text default null,
 p_retry_after_seconds integer default 300
) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_attempt public.notification_delivery_attempts%rowtype;
begin
 select d.* into v_attempt from public.notification_delivery_attempts d
 where d.id=p_attempt_id and d.locked_by=p_worker and d.channel in ('push','email') and d.state='queued'
 for update;
 if not found then return false; end if;
 if p_result_state='deferred' then
   update public.notification_delivery_attempts
   set run_after=now()+make_interval(secs=>greatest(30,least(coalesce(p_retry_after_seconds,300),3600))),
       locked_at=null,locked_by=null,updated_at=now()
   where id=v_attempt.id;
   return true;
 end if;
 if p_result_state in ('sent','delivered','suppressed') then
   update public.notification_delivery_attempts
   set state=p_result_state,provider_message_id=p_provider_message_id,
       last_error_code=left(p_error_code,100),locked_at=null,locked_by=null,updated_at=now()
   where id=v_attempt.id;
   return true;
 end if;
 if p_result_state='failed' then
   update public.notification_delivery_attempts
   set state='failed',last_error_code=left(coalesce(nullif(p_error_code,''),'NOTIFICATION_PROVIDER_FAILED'),100),
       locked_at=null,locked_by=null,updated_at=now()
   where id=v_attempt.id;
   if v_attempt.attempt_number<5 then
     insert into public.notification_delivery_attempts(notification_id,channel,state,attempt_number,run_after,last_error_code)
     values(v_attempt.notification_id,v_attempt.channel,'queued',v_attempt.attempt_number+1,
       now()+make_interval(secs=>least(300,(5*power(2,least(v_attempt.attempt_number,6)))::integer)),
       left(coalesce(nullif(p_error_code,''),'NOTIFICATION_PROVIDER_FAILED'),100))
     on conflict(notification_id,channel,attempt_number) do nothing;
   end if;
   return true;
 end if;
 raise exception 'INVALID_NOTIFICATION_DELIVERY_RESULT_STATE';
end;
$$;
revoke all on function public.finish_notification_delivery(uuid,text,text,text,text,integer) from public;
revoke all on function public.finish_notification_delivery(uuid,text,text,text,text,integer) from anon;
revoke all on function public.finish_notification_delivery(uuid,text,text,text,text,integer) from authenticated;
grant execute on function public.finish_notification_delivery(uuid,text,text,text,text,integer) to service_role;
