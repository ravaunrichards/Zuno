-- ZUNO operational infrastructure: outbox, background jobs, webhook attempts, idempotency and service health.
create table if not exists event_outbox (
 id uuid primary key default gen_random_uuid(),
 event_key text not null unique,
 event_type text not null,
 aggregate_type text not null,
 aggregate_id text not null,
 payload jsonb not null,
 available_at timestamptz not null default now(),
 published_at timestamptz,
 attempt_count integer not null default 0 check(attempt_count>=0),
 last_error_code text,
 created_at timestamptz not null default now()
);
create index if not exists event_outbox_pending_idx on event_outbox(available_at,created_at) where published_at is null;
create table if not exists background_jobs (
 id uuid primary key default gen_random_uuid(),
 queue text not null,
 job_type text not null,
 payload jsonb not null default '{}'::jsonb,
 state text not null default 'queued' check(state in ('queued','running','succeeded','retrying','dead_letter','cancelled')),
 attempts integer not null default 0 check(attempts>=0),
 max_attempts integer not null default 5 check(max_attempts>0),
 run_after timestamptz not null default now(),
 locked_at timestamptz,
 locked_by text,
 last_error_code text,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 check(attempts<=max_attempts)
);
create index if not exists background_jobs_claim_idx on background_jobs(queue,run_after,created_at) where state in ('queued','retrying');
create table if not exists background_job_attempts (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references background_jobs(id) on delete cascade,
 attempt_number integer not null check(attempt_number>0),
 state text not null check(state in ('running','succeeded','failed','timed_out')),
 started_at timestamptz not null default now(),
 ended_at timestamptz,
 error_code text,
 diagnostic jsonb not null default '{}'::jsonb,
 unique(job_id,attempt_number)
);
create table if not exists provider_webhook_attempts (
 id uuid primary key default gen_random_uuid(),
 provider text not null,
 provider_event_id text not null,
 attempt_number integer not null check(attempt_number>0),
 state text not null check(state in ('received','signature_failed','processed','retrying','failed')),
 error_code text,
 occurred_at timestamptz not null default now(),
 unique(provider,provider_event_id,attempt_number)
);
create table if not exists api_idempotency_keys (
 id uuid primary key default gen_random_uuid(),
 scope text not null,
 idempotency_key text not null,
 request_hash text not null,
 state text not null default 'started' check(state in ('started','completed','failed')),
 response_status integer,
 response_body jsonb,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default(now()+interval '48 hours'),
 unique(scope,idempotency_key)
);
create index if not exists api_idempotency_expiry_idx on api_idempotency_keys(expires_at);
create table if not exists feature_flag_definitions (
 flag_key text primary key,
 description text not null,
 default_enabled boolean not null default false,
 sensitive boolean not null default false,
 updated_at timestamptz not null default now()
);
create table if not exists feature_flag_overrides (
 flag_key text not null references feature_flag_definitions(flag_key) on delete cascade,
 environment text not null,
 enabled boolean not null,
 updated_by uuid references profiles(id) on delete set null,
 updated_at timestamptz not null default now(),
 primary key(flag_key,environment)
);
create table if not exists service_health_events (
 id uuid primary key default gen_random_uuid(),
 service_name text not null,
 check_name text not null,
 state text not null check(state in ('healthy','degraded','unavailable','unknown')),
 detail_code text,
 checked_at timestamptz not null default now()
);
create index if not exists service_health_events_recent_idx on service_health_events(service_name,checked_at desc);
create table if not exists notification_delivery_attempts (
 id uuid primary key default gen_random_uuid(),
 notification_id uuid not null references notifications(id) on delete cascade,
 channel text not null check(channel in ('in_app','push','email','sms')),
 provider_message_id text,
 state text not null default 'queued' check(state in ('queued','sent','delivered','failed','suppressed')),
 attempt_number integer not null default 0 check(attempt_number>=0),
 last_error_code text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(channel,provider_message_id)
);
create index if not exists notification_delivery_pending_idx on notification_delivery_attempts(state,created_at) where state in ('queued','failed');

alter table event_outbox enable row level security;
alter table background_jobs enable row level security;
alter table background_job_attempts enable row level security;
alter table provider_webhook_attempts enable row level security;
alter table api_idempotency_keys enable row level security;
alter table feature_flag_definitions enable row level security;
alter table feature_flag_overrides enable row level security;
alter table service_health_events enable row level security;
alter table notification_delivery_attempts enable row level security;
-- Service-owned operational tables have no direct client policies.

create or replace function claim_background_job(p_worker text,p_queues text[])
returns setof background_jobs
language plpgsql security definer
set search_path=public,pg_temp as $$
declare v_job public.background_jobs%rowtype;
begin
 if coalesce(length(trim(p_worker)),0)=0 then raise exception 'INVALID_WORKER_ID'; end if;
 select * into v_job from public.background_jobs j
 where j.queue=any(p_queues) and j.state in ('queued','retrying') and j.run_after<=now() and j.attempts<j.max_attempts
 order by j.run_after,j.created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.background_jobs set state='running',attempts=attempts+1,locked_at=now(),locked_by=p_worker
 where id=v_job.id returning * into v_job;
 insert into public.background_job_attempts(job_id,attempt_number,state) values(v_job.id,v_job.attempts,'running');
 return next v_job;
end;
$$;
create or replace function finish_background_job(p_job_id uuid,p_worker text)
returns boolean language plpgsql security definer
set search_path=public,pg_temp as $$
declare v_attempt integer;
begin
 update public.background_jobs set state='succeeded',completed_at=now(),locked_at=null,locked_by=null
 where id=p_job_id and state='running' and locked_by=p_worker returning attempts into v_attempt;
 if not found then return false; end if;
 update public.background_job_attempts set state='succeeded',ended_at=now()
 where job_id=p_job_id and attempt_number=v_attempt and state='running';
 return true;
end;
$$;
create or replace function fail_background_job(p_job_id uuid,p_worker text,p_error_code text)
returns text language plpgsql security definer
set search_path=public,pg_temp as $$
declare v_attempt integer; v_max integer; v_next text;
begin
 select attempts,max_attempts into v_attempt,v_max from public.background_jobs
 where id=p_job_id and state='running' and locked_by=p_worker for update;
 if not found then raise exception 'JOB_LEASE_NOT_OWNED'; end if;
 v_next:=case when v_attempt>=v_max then 'dead_letter' else 'retrying' end;
 update public.background_jobs set state=v_next,run_after=now()+least(interval '5 minutes',interval '1 second'*power(2,least(v_attempt-1,12))),
 locked_at=null,locked_by=null,last_error_code=left(coalesce(p_error_code,'UNKNOWN'),120)
 where id=p_job_id;
 update public.background_job_attempts set state='failed',ended_at=now(),error_code=left(coalesce(p_error_code,'UNKNOWN'),120)
 where job_id=p_job_id and attempt_number=v_attempt and state='running';
 return v_next;
end;
$$;
revoke all on function claim_background_job(text,text[]) from public;
revoke all on function finish_background_job(uuid,text) from public;
revoke all on function fail_background_job(uuid,text,text) from public;
grant execute on function claim_background_job(text,text[]) to service_role;
grant execute on function finish_background_job(uuid,text) to service_role;
grant execute on function fail_background_job(uuid,text,text) to service_role;

-- Ranking workers must compute weekly/monthly windows in America/Jamaica and retain closed periods.
