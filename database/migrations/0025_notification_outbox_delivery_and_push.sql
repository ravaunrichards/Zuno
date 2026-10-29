-- Notification delivery, durable outbox leases and social event producers.
alter table public.notifications add column if not exists source_event_key text;
create unique index if not exists notifications_source_event_key_uq
 on public.notifications(source_event_key) where source_event_key is not null;

alter table public.event_outbox add column if not exists locked_at timestamptz;
alter table public.event_outbox add column if not exists locked_by text;
alter table public.event_outbox add column if not exists dead_lettered_at timestamptz;
create index if not exists event_outbox_claim_idx
 on public.event_outbox(available_at,created_at) where published_at is null and dead_lettered_at is null;

-- Browser push endpoints and key material belong to the authenticated profile.
create table if not exists public.push_subscriptions (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references public.profiles(id) on delete cascade,
 endpoint text not null unique,
 p256dh_key text not null,
 auth_key text not null,
 user_agent text,
 created_at timestamptz not null default now(),
 last_used_at timestamptz,
 revoked_at timestamptz
);
create index if not exists push_subscriptions_profile_active_idx
 on public.push_subscriptions(profile_id,created_at desc) where revoked_at is null;
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_owner_select on public.push_subscriptions;
create policy push_subscriptions_owner_select on public.push_subscriptions for select using(profile_id=public.current_profile_id());
drop policy if exists push_subscriptions_owner_insert on public.push_subscriptions;
create policy push_subscriptions_owner_insert on public.push_subscriptions for insert with check(profile_id=public.current_profile_id());
drop policy if exists push_subscriptions_owner_update on public.push_subscriptions;
create policy push_subscriptions_owner_update on public.push_subscriptions for update using(profile_id=public.current_profile_id()) with check(profile_id=public.current_profile_id());
drop policy if exists push_subscriptions_owner_delete on public.push_subscriptions;
create policy push_subscriptions_owner_delete on public.push_subscriptions for delete using(profile_id=public.current_profile_id());
grant select,insert,update,delete on public.push_subscriptions to authenticated;

-- A delivery row records one stateful attempt number per notification/channel;
-- incrementing the attempt number preserves retry history rather than overwriting it.
create unique index if not exists notification_delivery_attempt_number_uq
 on public.notification_delivery_attempts(notification_id,channel,attempt_number);

create or replace function public.claim_event_outbox(p_worker text)
returns setof public.event_outbox
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_event public.event_outbox%rowtype;
begin
 if coalesce(length(trim(p_worker)),0)<1 or length(p_worker)>120 then raise exception 'INVALID_WORKER_ID'; end if;
 select e.* into v_event
 from public.event_outbox e
 where e.published_at is null and e.dead_lettered_at is null and e.available_at<=now()
   and (e.locked_at is null or e.locked_at<now()-interval '5 minutes')
 order by e.available_at,e.created_at
 for update skip locked limit 1;
 if not found then return; end if;
 update public.event_outbox e
 set locked_at=now(),locked_by=p_worker,attempt_count=e.attempt_count+1
 where e.id=v_event.id
 returning e.* into v_event;
 return next v_event;
end;
$$;
revoke all on function public.claim_event_outbox(text) from public;
revoke all on function public.claim_event_outbox(text) from anon;
revoke all on function public.claim_event_outbox(text) from authenticated;
grant execute on function public.claim_event_outbox(text) to service_role;

create or replace function public.finish_event_outbox(
 p_event_id uuid,p_worker text,p_succeeded boolean,p_error_code text default null
) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_attempt integer;
begin
 select attempt_count into v_attempt from public.event_outbox
 where id=p_event_id and locked_by=p_worker and published_at is null for update;
 if not found then return false; end if;
 if p_succeeded then
   update public.event_outbox set published_at=now(),locked_at=null,locked_by=null,last_error_code=null
   where id=p_event_id and locked_by=p_worker and published_at is null;
 else
   update public.event_outbox
   set locked_at=null,locked_by=null,
       last_error_code=left(coalesce(nullif(p_error_code,''),'OUTBOX_PROCESSING_FAILED'),100),
       available_at=now()+make_interval(secs=>least(300,(5*power(2,least(v_attempt,6)))::integer)),
       dead_lettered_at=case when v_attempt>=8 then now() else null end
   where id=p_event_id and locked_by=p_worker and published_at is null;
 end if;
 return true;
end;
$$;
revoke all on function public.finish_event_outbox(uuid,text,boolean,text) from public;
revoke all on function public.finish_event_outbox(uuid,text,boolean,text) from anon;
revoke all on function public.finish_event_outbox(uuid,text,boolean,text) from authenticated;
grant execute on function public.finish_event_outbox(uuid,text,boolean,text) to service_role;

-- Social actions write outbox rows in the same transaction as the originating data.
create or replace function public.outbox_comment_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_recipient uuid;
begin
 if new.deleted_at is not null then return new; end if;
 select p.author_id into v_recipient from public.posts p where p.id=new.post_id and p.deleted_at is null;
 if v_recipient is not null and v_recipient<>new.author_id then
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values('social-comment:'||new.id::text,'social.comment.created','comment',new.id::text,
   jsonb_build_object('commentId',new.id,'postId',new.post_id,'actorProfileId',new.author_id,'recipientProfileId',v_recipient))
  on conflict(event_key) do nothing;
 end if;
 return new;
end; $$;
drop trigger if exists comments_notification_outbox on public.comments;
create trigger comments_notification_outbox after insert on public.comments
for each row execute function public.outbox_comment_notification();

create or replace function public.outbox_reaction_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_recipient uuid;
begin
 select p.author_id into v_recipient from public.posts p where p.id=new.post_id and p.deleted_at is null;
 if v_recipient is not null and v_recipient<>new.profile_id then
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values('social-reaction:'||new.id::text,'social.reaction.created','reaction',new.id::text,
   jsonb_build_object('reactionId',new.id,'postId',new.post_id,'reactionKind',new.kind,'actorProfileId',new.profile_id,'recipientProfileId',v_recipient))
  on conflict(event_key) do nothing;
 end if;
 return new;
end; $$;
drop trigger if exists reactions_notification_outbox on public.reactions;
create trigger reactions_notification_outbox after insert on public.reactions
for each row execute function public.outbox_reaction_notification();

create or replace function public.outbox_follow_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.follower_id<>new.followee_id then
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values('social-follow:'||new.follower_id::text||':'||new.followee_id::text,'social.follow.created','follow',new.follower_id::text,
   jsonb_build_object('actorProfileId',new.follower_id,'recipientProfileId',new.followee_id))
  on conflict(event_key) do nothing;
 end if;
 return new;
end; $$;
drop trigger if exists follows_notification_outbox on public.follows;
create trigger follows_notification_outbox after insert on public.follows
for each row execute function public.outbox_follow_notification();

create or replace function public.outbox_message_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_member uuid;
begin
 if new.deleted_at is not null then return new; end if;
 for v_member in select cm.profile_id from public.conversation_members cm
   where cm.conversation_id=new.conversation_id and cm.profile_id<>new.sender_id
 loop
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values('social-message:'||new.id::text||':'||v_member::text,'social.message.created','message',new.id::text,
   jsonb_build_object('messageId',new.id,'conversationId',new.conversation_id,'actorProfileId',new.sender_id,'recipientProfileId',v_member))
  on conflict(event_key) do nothing;
 end loop;
 return new;
end; $$;
drop trigger if exists messages_notification_outbox on public.messages;
create trigger messages_notification_outbox after insert on public.messages
for each row execute function public.outbox_message_notification();

create or replace function public.outbox_subscription_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.state='active' then
  insert into public.event_outbox(event_key,event_type,aggregate_type,aggregate_id,payload)
  values('creator-subscription:'||new.id::text,'creator.subscription.created','creator_subscription',new.id::text,
   jsonb_build_object('subscriptionId',new.id,'actorProfileId',new.subscriber_id,'recipientProfileId',new.creator_id))
  on conflict(event_key) do nothing;
 end if;
 return new;
end; $$;
drop trigger if exists creator_subscriptions_notification_outbox on public.creator_subscriptions;
create trigger creator_subscriptions_notification_outbox after insert on public.creator_subscriptions
for each row execute function public.outbox_subscription_notification();

create or replace function public.create_in_app_delivery_attempt()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.notification_delivery_attempts(notification_id,channel,state,attempt_number)
 values(new.id,'in_app','delivered',1)
 on conflict(notification_id,channel,attempt_number) do nothing;
 return new;
end; $$;
revoke all on function public.create_in_app_delivery_attempt() from public;
drop trigger if exists notifications_in_app_delivery on public.notifications;
create trigger notifications_in_app_delivery after insert on public.notifications
for each row execute function public.create_in_app_delivery_attempt();
