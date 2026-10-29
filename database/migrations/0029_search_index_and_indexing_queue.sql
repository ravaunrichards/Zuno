-- Durable public-only PostgreSQL full-text search and trigger-driven indexing.
create table if not exists public.search_documents (
  entity_type text not null check(entity_type in ('profile','post','community','event')),
  entity_id uuid not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '',
  body text not null default '',
  tags text[] not null default '{}'::text[],
  visibility text not null default 'public' check(visibility='public'),
  metadata jsonb not null default '{}'::jsonb,
  source_created_at timestamptz not null default now(),
  source_updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple'::regconfig,coalesce(title,'')),'A') ||
    setweight(to_tsvector('simple'::regconfig,coalesce(body,'')),'B') ||
    setweight(to_tsvector('simple'::regconfig,coalesce(array_to_string(tags,' '),'')),'C')
  ) stored,
  indexed_at timestamptz not null default now(),
  primary key(entity_type,entity_id)
);
create index if not exists search_documents_vector_idx on public.search_documents using gin(search_vector);
create index if not exists search_documents_owner_idx on public.search_documents(owner_id,entity_type);
create index if not exists search_documents_updated_idx on public.search_documents(source_updated_at desc);
alter table public.search_documents enable row level security;
revoke all on public.search_documents from public,anon,authenticated;
grant select,insert,update,delete on public.search_documents to service_role;

create table if not exists public.search_index_jobs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check(entity_type in ('profile','post','community','event')),
  entity_id uuid not null,
  operation text not null check(operation in ('upsert','delete')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check(state in ('queued','processing','retrying','completed','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists search_index_jobs_claim_idx on public.search_index_jobs(run_after,created_at)
  where state in ('queued','retrying','processing');
alter table public.search_index_jobs enable row level security;
revoke all on public.search_index_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.search_index_jobs to service_role;

create or replace function public.enqueue_public_search_change()
returns trigger language plpgsql security definer
set search_path=public,pg_temp as $search_enqueue$
declare
  v_row jsonb;
  v_entity_type text;
  v_entity_id uuid;
  v_owner_id uuid;
  v_title text:='';
  v_body text:='';
  v_visibility text:='private';
  v_metadata jsonb:='{}'::jsonb;
  v_created_at timestamptz:=now();
  v_updated_at timestamptz:=now();
  v_visible boolean:=false;
  v_operation text:='delete';
  v_payload jsonb;
begin
  v_row:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_entity_id:=nullif(v_row->>'id','')::uuid;
  v_updated_at:=coalesce(nullif(v_row->>'updated_at','')::timestamptz,nullif(v_row->>'created_at','')::timestamptz,now());
  v_created_at:=coalesce(nullif(v_row->>'created_at','')::timestamptz,now());

  case tg_table_name
    when 'profiles' then
      v_entity_type:='profile'; v_owner_id:=v_entity_id;
      v_title:=coalesce(v_row->>'username','');
      v_body:=concat_ws(' ',coalesce(v_row->>'display_name',''),coalesce(v_row->>'bio',''));
      v_visible:=tg_op<>'DELETE' and v_row->>'visibility'='public' and coalesce((v_row->>'is_deleted')::boolean,false)=false;
      v_metadata:=jsonb_build_object('displayName',coalesce(v_row->>'display_name',v_row->>'username'),'isVerified',coalesce((v_row->>'is_verified')::boolean,false));
    when 'posts' then
      v_entity_type:='post'; v_owner_id:=nullif(v_row->>'author_id','')::uuid;
      v_title:=coalesce(v_row->>'kind','post'); v_body:=coalesce(v_row->>'caption','');
      v_visible:=tg_op<>'DELETE' and v_row->>'audience'='public' and nullif(v_row->>'deleted_at','') is null;
      v_metadata:=jsonb_build_object('kind',coalesce(v_row->>'kind','text'),'audience',coalesce(v_row->>'audience','public'));
    when 'communities' then
      v_entity_type:='community'; v_owner_id:=nullif(v_row->>'owner_id','')::uuid;
      v_title:=coalesce(v_row->>'name','');
      v_visible:=tg_op<>'DELETE' and v_row->>'access'='public';
      v_metadata:=jsonb_build_object('access',coalesce(v_row->>'access','public'));
    when 'events' then
      v_entity_type:='event'; v_owner_id:=nullif(v_row->>'host_id','')::uuid;
      v_title:=coalesce(v_row->>'title',''); v_body:=coalesce(v_row->>'description','');
      v_visible:=tg_op<>'DELETE';
      v_metadata:=jsonb_build_object('startsAt',v_row->>'starts_at','endsAt',v_row->>'ends_at','timezone',coalesce(v_row->>'tz','America/Jamaica'));
    else raise exception 'SEARCH_TRIGGER_TABLE_UNSUPPORTED';
  end case;

  if v_entity_id is null or v_owner_id is null then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if v_visible then v_operation:='upsert'; v_visibility:='public'; end if;
  v_payload:=jsonb_build_object(
    'ownerId',v_owner_id,'title',left(v_title,300),'body',left(v_body,12000),
    'tags','[]'::jsonb,'visibility',v_visibility,'metadata',v_metadata,
    'createdAt',v_created_at,'updatedAt',v_updated_at
  );

  insert into public.search_index_jobs(entity_type,entity_id,operation,payload)
  values(v_entity_type,v_entity_id,v_operation,v_payload);
  if tg_op='DELETE' then return old; else return new; end if;
end;
$search_enqueue$;
revoke all on function public.enqueue_public_search_change() from public,anon,authenticated;

drop trigger if exists profiles_search_index_enqueue on public.profiles;
create trigger profiles_search_index_enqueue after insert or update or delete on public.profiles
for each row execute function public.enqueue_public_search_change();
drop trigger if exists posts_search_index_enqueue on public.posts;
create trigger posts_search_index_enqueue after insert or update or delete on public.posts
for each row execute function public.enqueue_public_search_change();
drop trigger if exists communities_search_index_enqueue on public.communities;
create trigger communities_search_index_enqueue after insert or update or delete on public.communities
for each row execute function public.enqueue_public_search_change();
drop trigger if exists events_search_index_enqueue on public.events;
create trigger events_search_index_enqueue after insert or update or delete on public.events
for each row execute function public.enqueue_public_search_change();

create or replace function public.claim_search_index_job(p_worker text)
returns setof public.search_index_jobs
language plpgsql security definer set search_path=public,pg_temp as $search_claim$
declare v_job public.search_index_jobs%rowtype;
begin
  if coalesce(length(trim(p_worker)),0)<1 or length(p_worker)>120 then raise exception 'INVALID_WORKER_ID'; end if;
  update public.search_index_jobs set state='failed',locked_at=null,locked_by=null,
    last_error_code='SEARCH_INDEX_ATTEMPTS_EXHAUSTED',updated_at=now()
  where state='processing' and attempts>=5 and (locked_at is null or locked_at<now()-interval '10 minutes');
  select * into v_job from public.search_index_jobs j
  where j.attempts<5 and j.run_after<=now()
    and (j.state in ('queued','retrying') or (j.state='processing' and (j.locked_at is null or j.locked_at<now()-interval '10 minutes')))
  order by j.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.search_index_jobs set state='processing',attempts=attempts+1,locked_at=now(),
    locked_by=p_worker,updated_at=now(),last_error_code=null
  where id=v_job.id returning * into v_job;
  return next v_job;
end;
$search_claim$;
revoke all on function public.claim_search_index_job(text) from public,anon,authenticated;
grant execute on function public.claim_search_index_job(text) to service_role;

create or replace function public.finish_search_index_job(p_job_id uuid,p_worker text,p_success boolean,p_error_code text default null)
returns text
language plpgsql security definer set search_path=public,pg_temp as $search_finish$
declare
  v_job public.search_index_jobs%rowtype;
  v_next text;
  v_owner uuid;
  v_title text;
  v_body text;
  v_tags text[];
  v_visibility text;
  v_metadata jsonb;
  v_created_at timestamptz;
  v_updated_at timestamptz;
begin
  select * into v_job from public.search_index_jobs
  where id=p_job_id and state='processing' and locked_by=p_worker for update;
  if not found then raise exception 'SEARCH_INDEX_LEASE_NOT_OWNED'; end if;

  if coalesce(p_success,false) then
    if v_job.operation='delete' then
      delete from public.search_documents where entity_type=v_job.entity_type and entity_id=v_job.entity_id;
    else
      v_owner:=nullif(v_job.payload->>'ownerId','')::uuid;
      v_title:=left(coalesce(v_job.payload->>'title',''),300);
      v_body:=left(coalesce(v_job.payload->>'body',''),12000);
      v_visibility:=coalesce(v_job.payload->>'visibility','private');
      v_metadata:=coalesce(v_job.payload->'metadata','{}'::jsonb);
      v_created_at:=coalesce(nullif(v_job.payload->>'createdAt','')::timestamptz,now());
      v_updated_at:=coalesce(nullif(v_job.payload->>'updatedAt','')::timestamptz,now());
      select coalesce(array_agg(t.value),'{}'::text[]) into v_tags
      from jsonb_array_elements_text(coalesce(v_job.payload->'tags','[]'::jsonb)) as t(value);
      if v_owner is null or v_visibility<>'public' then raise exception 'SEARCH_DOCUMENT_PAYLOAD_INVALID'; end if;
      if exists(select 1 from public.profiles p where p.id=v_owner and (p.is_deleted or p.visibility<>'public')) then
        delete from public.search_documents where entity_type=v_job.entity_type and entity_id=v_job.entity_id;
      else
        insert into public.search_documents(entity_type,entity_id,owner_id,title,body,tags,visibility,metadata,source_created_at,source_updated_at)
        values(v_job.entity_type,v_job.entity_id,v_owner,v_title,v_body,v_tags,'public',v_metadata,v_created_at,v_updated_at)
        on conflict(entity_type,entity_id) do update set owner_id=excluded.owner_id,title=excluded.title,
          body=excluded.body,tags=excluded.tags,visibility=excluded.visibility,metadata=excluded.metadata,
          source_created_at=excluded.source_created_at,source_updated_at=excluded.source_updated_at,indexed_at=now();
      end if;
    end if;
    update public.search_index_jobs set state='completed',locked_at=null,locked_by=null,last_error_code=null,updated_at=now()
    where id=p_job_id;
    return 'completed';
  end if;

  v_next:=case when v_job.attempts>=5 then 'failed' else 'retrying' end;
  update public.search_index_jobs set state=v_next,
    run_after=now()+make_interval(secs=>least(1800,5*power(2,greatest(0,attempts-1))::integer)),
    locked_at=null,locked_by=null,last_error_code=left(coalesce(nullif(p_error_code,''),'SEARCH_INDEX_FAILED'),100),updated_at=now()
  where id=p_job_id;
  return v_next;
end;
$search_finish$;
revoke all on function public.finish_search_index_job(uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.finish_search_index_job(uuid,text,boolean,text) to service_role;

create or replace function public.search_public_documents(
  p_query text,p_type text,p_viewer_id uuid,p_limit integer default 20,p_offset integer default 0
) returns table(
  entity_type text,entity_id uuid,owner_id uuid,title text,body text,tags text[],metadata jsonb,created_at timestamptz,score real
)
language plpgsql stable security definer set search_path=public,pg_temp as $search_query$
declare v_tsquery tsquery; v_like text;
begin
  if p_viewer_id is null or not exists(select 1 from public.profiles where id=p_viewer_id and not is_deleted) then raise exception 'SEARCH_VIEWER_REQUIRED'; end if;
  if coalesce(length(trim(p_query)),0)<2 or length(p_query)>200 then raise exception 'INVALID_SEARCH_QUERY'; end if;
  if p_type not in ('all','profiles','posts','communities','events') then raise exception 'INVALID_SEARCH_TYPE'; end if;
  v_tsquery:=websearch_to_tsquery('simple'::regconfig,left(trim(p_query),200));
  v_like:='%'||replace(replace(left(trim(p_query),200),'%',''), '_','')||'%';
  return query
  select d.entity_type,d.entity_id,d.owner_id,d.title,d.body,d.tags,d.metadata,d.source_created_at,
    ts_rank_cd(d.search_vector,v_tsquery)::real
  from public.search_documents d
  where d.visibility='public'
    and (p_type='all' or (p_type='profiles' and d.entity_type='profile')
      or (p_type='posts' and d.entity_type='post') or (p_type='communities' and d.entity_type='community')
      or (p_type='events' and d.entity_type='event'))
    and (d.search_vector@@v_tsquery or d.title ilike v_like or d.body ilike v_like)
    and not exists(select 1 from public.profiles p where p.id=d.owner_id and (p.is_deleted or p.visibility<>'public'))
    and not exists(select 1 from public.blocks b where
      (b.blocker_id=p_viewer_id and b.blocked_id=d.owner_id) or (b.blocker_id=d.owner_id and b.blocked_id=p_viewer_id))
  order by ts_rank_cd(d.search_vector,v_tsquery) desc,d.source_created_at desc
  limit greatest(1,least(coalesce(p_limit,20),50))
  offset greatest(0,least(coalesce(p_offset,0),1000));
end;
$search_query$;
revoke all on function public.search_public_documents(text,text,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.search_public_documents(text,text,uuid,integer,integer) to service_role;

insert into public.search_index_jobs(entity_type,entity_id,operation,payload)
select 'profile',p.id,'upsert',jsonb_build_object(
  'ownerId',p.id,'title',left(p.username,300),'body',left(concat_ws(' ',p.display_name,p.bio),12000),
  'tags','[]'::jsonb,'visibility','public','metadata',jsonb_build_object('displayName',coalesce(p.display_name,p.username),'isVerified',p.is_verified),
  'createdAt',p.created_at,'updatedAt',p.updated_at)
from public.profiles p where p.visibility='public' and not p.is_deleted
  and not exists(select 1 from public.search_index_jobs j where j.entity_type='profile' and j.entity_id=p.id and j.state in ('queued','processing','retrying'));
insert into public.search_index_jobs(entity_type,entity_id,operation,payload)
select 'post',p.id,'upsert',jsonb_build_object(
  'ownerId',p.author_id,'title',left(p.kind,300),'body',left(coalesce(p.caption,''),12000),
  'tags','[]'::jsonb,'visibility','public','metadata',jsonb_build_object('kind',p.kind,'audience',p.audience),
  'createdAt',p.created_at,'updatedAt',p.created_at)
from public.posts p where p.audience='public' and p.deleted_at is null
  and not exists(select 1 from public.search_index_jobs j where j.entity_type='post' and j.entity_id=p.id and j.state in ('queued','processing','retrying'));
insert into public.search_index_jobs(entity_type,entity_id,operation,payload)
select 'community',c.id,'upsert',jsonb_build_object(
  'ownerId',c.owner_id,'title',left(c.name,300),'body','','tags','[]'::jsonb,'visibility','public',
  'metadata',jsonb_build_object('access',c.access),'createdAt',c.created_at,'updatedAt',c.created_at)
from public.communities c where c.access='public'
  and not exists(select 1 from public.search_index_jobs j where j.entity_type='community' and j.entity_id=c.id and j.state in ('queued','processing','retrying'));
insert into public.search_index_jobs(entity_type,entity_id,operation,payload)
select 'event',e.id,'upsert',jsonb_build_object(
  'ownerId',e.host_id,'title',left(e.title,300),'body',left(coalesce(e.description,''),12000),
  'tags','[]'::jsonb,'visibility','public',
  'metadata',jsonb_build_object('startsAt',e.starts_at,'endsAt',e.ends_at,'timezone',e.tz),
  'createdAt',e.created_at,'updatedAt',e.created_at)
from public.events e
where not exists(select 1 from public.search_index_jobs j where j.entity_type='event' and j.entity_id=e.id and j.state in ('queued','processing','retrying'));
