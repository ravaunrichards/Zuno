-- Optional idempotency keys for client-reported post views and share telemetry.
alter table public.post_view_events add column if not exists idempotency_key text;
alter table public.post_share_events add column if not exists idempotency_key text;
create unique index if not exists post_view_events_viewer_idempotency_uq
  on public.post_view_events(viewer_id,idempotency_key)
  where viewer_id is not null and idempotency_key is not null;
create unique index if not exists post_share_events_actor_idempotency_uq
  on public.post_share_events(actor_id,idempotency_key)
  where actor_id is not null and idempotency_key is not null;
