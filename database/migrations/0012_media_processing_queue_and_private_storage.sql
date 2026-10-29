-- ZUNO queues uploaded media for authenticated, idempotent background validation and processing.
create or replace function public.queue_media_processing_job(
  p_asset_id uuid,
  p_profile_id uuid,
  p_bucket text
) returns uuid
language plpgsql
security definer
set search_path=public,pg_temp as $$
declare
  v_asset public.media_assets%rowtype;
  v_job_id uuid;
begin
  if p_asset_id is null or p_profile_id is null then raise exception 'MEDIA_IDENTITY_REQUIRED'; end if;
  if coalesce(p_bucket,'') !~ '^[a-z0-9_-]{3,63}$' then raise exception 'INVALID_MEDIA_BUCKET'; end if;

  select * into v_asset
  from public.media_assets
  where id=p_asset_id and uploader_id=p_profile_id
  for update;

  if not found then raise exception 'MEDIA_ASSET_NOT_FOUND'; end if;

  if v_asset.state='processing' then
    select id into v_job_id
    from public.background_jobs
    where queue='media'
      and job_type='media.process'
      and payload->>'mediaAssetId'=p_asset_id::text
      and state in ('queued','running','retrying')
    order by created_at desc
    limit 1;
    if v_job_id is not null then return v_job_id; end if;
    raise exception 'MEDIA_PROCESSING_STATE_INCONSISTENT';
  end if;

  if v_asset.state not in ('uploaded','failed') then raise exception 'MEDIA_ASSET_STATE_NOT_QUEUABLE'; end if;
  if v_asset.byte_size<=0 then raise exception 'MEDIA_FILE_SIZE_INVALID'; end if;
  if v_asset.media_type not in ('image','video','audio') then raise exception 'MEDIA_TYPE_NOT_SUPPORTED'; end if;

  update public.media_assets
  set state='processing',updated_at=now()
  where id=v_asset.id;

  insert into public.background_jobs(queue,job_type,payload,state,attempts,max_attempts,run_after)
  values(
    'media',
    'media.process',
    jsonb_build_object(
      'mediaAssetId',v_asset.id,
      'profileId',v_asset.uploader_id,
      'bucket',p_bucket,
      'storagePath',v_asset.storage_path,
      'expectedMimeType',v_asset.mime_type,
      'mediaType',v_asset.media_type,
      'expectedByteSize',v_asset.byte_size,
      'checksumSha256',v_asset.checksum_sha256
    ),
    'queued',0,3,now()
  )
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke all on function public.queue_media_processing_job(uuid,uuid,text) from public;
revoke all on function public.queue_media_processing_job(uuid,uuid,text) from anon;
revoke all on function public.queue_media_processing_job(uuid,uuid,text) from authenticated;
grant execute on function public.queue_media_processing_job(uuid,uuid,text) to service_role;

-- Provision the private Supabase Storage bucket when running inside Supabase.
-- The conditional keeps clean PostgreSQL migration tests independent of the Storage extension.
do $zuno_bucket$
begin
  if to_regclass('storage.buckets') is not null then
    execute $sql$
      insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
      values(
        'zuno-media','zuno-media',false,524288000,
        array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/opus']
      )
      on conflict(id) do update set
        public=false,
        file_size_limit=excluded.file_size_limit,
        allowed_mime_types=excluded.allowed_mime_types
    $sql$;
  end if;
end
$zuno_bucket$;
