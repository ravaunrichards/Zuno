-- Privacy consent history, idempotent data-rights requests, appeal retries.
alter table public.privacy_consents
  drop constraint if exists privacy_consents_profile_id_purpose_policy_version_key;
alter table public.privacy_consents add column if not exists idempotency_key text;
create unique index if not exists privacy_consents_profile_idempotency_uq
  on public.privacy_consents(profile_id,idempotency_key) where idempotency_key is not null;
create index if not exists privacy_consents_latest_purpose_idx
  on public.privacy_consents(profile_id,purpose,recorded_at desc);

alter table public.data_requests add column if not exists idempotency_key text;
alter table public.data_requests add column if not exists request_reason text;
alter table public.data_requests add column if not exists updated_at timestamptz not null default now();
create unique index if not exists data_requests_profile_idempotency_uq
  on public.data_requests(profile_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists data_requests_one_open_type_uq
  on public.data_requests(profile_id,request_type)
  where state in ('submitted','reviewing','processing');
create index if not exists data_requests_queue_idx
  on public.data_requests(state,requested_at) where state in ('submitted','reviewing','processing');

alter table public.moderation_appeals add column if not exists idempotency_key text;
alter table public.moderation_appeals add column if not exists updated_at timestamptz not null default now();
create unique index if not exists moderation_appeals_appellant_idempotency_uq
  on public.moderation_appeals(appellant_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists moderation_appeals_one_open_target_uq
  on public.moderation_appeals(appellant_id,target_type,target_id)
  where state in ('submitted','reviewing');

-- Notification preferences remain owner-scoped; defaults are not used as a permission bypass.
alter table public.notification_preferences enable row level security;
drop policy if exists notification_preferences_owner_select on public.notification_preferences;
create policy notification_preferences_owner_select on public.notification_preferences
 for select using(profile_id=public.current_profile_id());
drop policy if exists notification_preferences_owner_insert on public.notification_preferences;
create policy notification_preferences_owner_insert on public.notification_preferences
 for insert with check(profile_id=public.current_profile_id());
drop policy if exists notification_preferences_owner_update on public.notification_preferences;
create policy notification_preferences_owner_update on public.notification_preferences
 for update using(profile_id=public.current_profile_id()) with check(profile_id=public.current_profile_id());

grant select,insert,update on public.notification_preferences to authenticated;
grant select,insert on public.privacy_consents to authenticated;
grant select,insert on public.data_requests to authenticated;
grant select,insert on public.moderation_appeals to authenticated;
