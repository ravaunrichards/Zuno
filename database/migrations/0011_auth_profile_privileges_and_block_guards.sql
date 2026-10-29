-- ZUNO auth profile provisioning, PostgREST table privileges and direct-message block enforcement.
-- Supabase Auth users are the identity source; profile rows are created only by this trusted trigger.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp as $$
declare
  v_username text;
  v_display_name text;
begin
  v_username:=lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username',''), '[^a-z0-9_.]', '', 'g'));
  v_display_name:=left(trim(coalesce(new.raw_user_meta_data->>'display_name','')),80);
  if v_username !~ '^[a-z0-9_.]{3,30}$'
     or exists(select 1 from public.profiles p where p.username=v_username) then
    v_username:='user_'||left(replace(new.id::text,'-',''),25);
  end if;
  insert into public.profiles(auth_user_id,username,display_name,visibility)
  values(new.id,v_username,nullif(v_display_name,''),'public')
  on conflict(auth_user_id) do nothing;
  insert into public.roles(profile_id,role)
  select p.id,'user' from public.profiles p where p.auth_user_id=new.id
  on conflict(profile_id,role) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Grant only the table operations expected by the RLS policies. RLS is still
-- mandatory; SQL privileges alone must never authorize cross-user access.
grant usage on schema public to anon,authenticated,service_role;
grant select on public.profiles,public.posts,public.comments,public.reactions,public.events,public.live_rooms,public.gift_definitions,public.hashtags,public.post_hashtags,public.ad_placements,public.marketplace_listings,public.listing_inventory,public.coin_packages,public.creator_subscription_tiers,public.creator_earning_policies to anon,authenticated;
grant select,insert,update on public.profiles to authenticated;
grant select,insert,update,delete on public.posts to authenticated;
grant select,insert,update,delete on public.comments to authenticated;
grant select,insert,delete on public.reactions to authenticated;
grant select,insert,delete on public.follows to authenticated;
grant select,insert,delete on public.blocks to authenticated;
grant select on public.roles to authenticated;
grant select on public.conversations,public.conversation_members,public.messages to authenticated;
grant insert,update,delete on public.messages to authenticated;
grant select,update on public.notifications to authenticated;
grant select,insert,update,delete on public.communities to authenticated;
grant select,insert,update,delete on public.community_members to authenticated;
grant select,insert,update,delete on public.community_channels,public.community_posts,public.community_post_reactions,public.community_event_rsvps to authenticated;
grant select,insert,update on public.events to authenticated;
grant select on public.live_rooms,public.live_participants,public.guest_requests,public.live_chat_messages,public.live_polls,public.live_poll_options,public.live_poll_votes,public.live_questions,public.live_room_moderators to authenticated;
grant select,insert,update,delete on public.guest_requests,public.live_chat_messages,public.live_poll_votes,public.live_questions to authenticated;
grant select,insert,update,delete on public.media_assets,public.post_bookmarks,public.post_reposts,public.post_view_events,public.post_share_events,public.stories,public.story_views,public.story_replies,public.feed_preferences,public.message_reactions,public.message_read_receipts,public.muted_profiles,public.restricted_profiles,public.notification_preferences to authenticated;
grant select on public.creator_subscriptions,public.creator_subscription_entitlements,public.gift_deliveries,public.gifter_progress,public.gifter_level_thresholds,public.gifter_milestone_history,public.ranking_aggregates to authenticated;
grant select on public.payment_orders,public.refund_records,public.commerce_orders,public.commerce_order_items,public.commerce_shipments,public.commerce_refunds,public.moderation_appeals,public.privacy_consents,public.data_requests,public.recommendation_feedback to authenticated;
grant insert on public.moderation_appeals,public.privacy_consents,public.data_requests,public.recommendation_feedback to authenticated;
grant select,insert,update,delete on public.marketplace_listings to authenticated;
grant select on public.ad_campaigns,public.ad_creatives to authenticated;
grant insert,update on public.ad_campaigns,public.ad_creatives to authenticated;

-- Ordinary client roles never receive direct write privileges to cash/coin ledger,
-- payouts, provider webhook events, idempotency keys, jobs, or append-only audit.
revoke all on public.wallet_accounts,public.ledger_entries,public.ledger_postings,public.creator_earnings,public.creator_earning_entries,public.payouts,public.payment_webhook_events,public.payment_reconciliation_runs,public.payout_reconciliation_records,public.refund_records,public.gift_deliveries,public.event_outbox,public.background_jobs,public.background_job_attempts,public.provider_webhook_attempts,public.api_idempotency_keys,public.feature_flag_definitions,public.feature_flag_overrides,public.service_health_events,public.notification_delivery_attempts,public.audit_events,public.moderation_actions from anon,authenticated;
grant select on public.refund_records,public.gift_deliveries to authenticated;
grant select on public.creator_earning_entries,public.gifter_milestone_history to authenticated;

-- Direct conversations cannot be used to contact a profile across a block relation.
drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert with check (
  sender_id=current_profile_id()
  and is_conversation_member(conversation_id)
  and (
    exists(select 1 from conversations c where c.id=conversation_id and c.is_group=true)
    or not exists(
      select 1 from conversation_members cm
      join blocks b on
        (b.blocker_id=current_profile_id() and b.blocked_id=cm.profile_id)
        or (b.blocker_id=cm.profile_id and b.blocked_id=current_profile_id())
      where cm.conversation_id=messages.conversation_id and cm.profile_id<>current_profile_id()
    )
  )
);

-- The PostgREST role is not allowed to assign roles to itself or to another user.
revoke insert,update,delete on public.roles from anon,authenticated;
