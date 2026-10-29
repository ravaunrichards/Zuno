-- Durable, service-role-only processing and short-lived private results for data exports.
alter table public.data_requests
  add column if not exists attempt_count integer not null default 0,
  add column if not exists run_after timestamptz not null default now(),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists result_expires_at timestamptz,
  add column if not exists result_byte_size bigint,
  add column if not exists result_sha256 text,
  add column if not exists last_error_code text;

alter table public.data_requests drop constraint if exists data_requests_attempt_count_check;
alter table public.data_requests add constraint data_requests_attempt_count_check check(attempt_count between 0 and 3) not valid;
alter table public.data_requests drop constraint if exists data_requests_result_byte_size_check;
alter table public.data_requests add constraint data_requests_result_byte_size_check check(result_byte_size is null or result_byte_size>0) not valid;
alter table public.data_requests drop constraint if exists data_requests_result_sha256_check;
alter table public.data_requests add constraint data_requests_result_sha256_check check(result_sha256 is null or result_sha256 ~ '^[a-f0-9]{64}$') not valid;

create index if not exists data_requests_export_claim_idx
  on public.data_requests(run_after,requested_at)
  where request_type='export' and state in ('submitted','processing');

create or replace function public.claim_privacy_export(p_worker text)
returns setof public.data_requests
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_request public.data_requests%rowtype;
begin
  if coalesce(length(trim(p_worker)),0)<1 or length(p_worker)>120 then raise exception 'INVALID_WORKER_ID'; end if;

  update public.data_requests
  set state='failed',locked_at=null,locked_by=null,updated_at=now(),
      resolution_code='EXPORT_ATTEMPTS_EXHAUSTED',last_error_code='EXPORT_ATTEMPTS_EXHAUSTED'
  where request_type='export' and state='processing' and attempt_count>=3
    and (locked_at is null or locked_at<now()-interval '10 minutes');

  select * into v_request
  from public.data_requests d
  where d.request_type='export'
    and d.attempt_count<3
    and d.run_after<=now()
    and (
      d.state='submitted'
      or (d.state='processing' and (d.locked_at is null or d.locked_at<now()-interval '10 minutes'))
    )
  order by d.requested_at
  for update skip locked
  limit 1;

  if not found then return; end if;

  update public.data_requests d
  set state='processing',attempt_count=d.attempt_count+1,locked_at=now(),locked_by=p_worker,
      updated_at=now(),last_error_code=null
  where d.id=v_request.id
  returning d.* into v_request;

  return next v_request;
end;
$$;
revoke all on function public.claim_privacy_export(text) from public;
revoke all on function public.claim_privacy_export(text) from anon;
revoke all on function public.claim_privacy_export(text) from authenticated;
grant execute on function public.claim_privacy_export(text) to service_role;

create or replace function public.finish_privacy_export(
  p_request_id uuid,
  p_worker text,
  p_success boolean,
  p_storage_path text default null,
  p_byte_size bigint default null,
  p_sha256 text default null,
  p_error_code text default null
) returns text
language plpgsql security definer
set search_path=public,pg_temp as $$
declare
  v_request public.data_requests%rowtype;
  v_next_state text;
  v_safe_error text;
begin
  select * into v_request
  from public.data_requests d
  where d.id=p_request_id and d.request_type='export' and d.state='processing' and d.locked_by=p_worker
  for update;
  if not found then raise exception 'PRIVACY_EXPORT_LEASE_NOT_OWNED'; end if;

  if coalesce(p_success,false) then
    if p_storage_path is distinct from ('privacy-exports/'||v_request.profile_id::text||'/'||v_request.id::text||'.json')
       or p_byte_size is null or p_byte_size<=0 or p_byte_size>104857600
       or p_sha256 !~ '^[a-f0-9]{64}$' then
      raise exception 'PRIVACY_EXPORT_RESULT_INVALID';
    end if;
    update public.data_requests set state='completed',result_storage_path=p_storage_path,
      result_expires_at=now()+interval '7 days',result_byte_size=p_byte_size,result_sha256=p_sha256,
      completed_at=now(),updated_at=now(),resolution_code=null,last_error_code=null,
      locked_at=null,locked_by=null
    where id=p_request_id;
    insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
    values('privacy-export-completed:'||p_request_id::text,'privacy.export.completed','data_request',p_request_id::text,
      jsonb_build_object('requestId',p_request_id,'profileId',v_request.profile_id,'byteSize',p_byte_size,'expiresAt',now()+interval '7 days'))
    on conflict(event_key) do nothing;
    return 'completed';
  end if;

  v_safe_error:=left(coalesce(nullif(p_error_code,''),'PRIVACY_EXPORT_FAILED'),100);
  v_next_state:=case when v_request.attempt_count>=3 then 'failed' else 'submitted' end;
  update public.data_requests set state=v_next_state,run_after=now()+make_interval(secs=>least(3600,30*power(2,greatest(0,attempt_count-1))::integer)),
    updated_at=now(),locked_at=null,locked_by=null,last_error_code=v_safe_error,
    resolution_code=case when v_next_state='failed' then 'EXPORT_PROCESSING_FAILED' else null end
  where id=p_request_id;
  return v_next_state;
end;
$$;
revoke all on function public.finish_privacy_export(uuid,text,boolean,text,bigint,text,text) from public;
revoke all on function public.finish_privacy_export(uuid,text,boolean,text,bigint,text,text) from anon;
revoke all on function public.finish_privacy_export(uuid,text,boolean,text,bigint,text,text) from authenticated;
grant execute on function public.finish_privacy_export(uuid,text,boolean,text,bigint,text,text) to service_role;
