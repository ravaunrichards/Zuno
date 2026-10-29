-- Bounded, server-authorized aggregate for creator studio; no raw viewer data is returned.
create or replace function public.get_creator_analytics(p_profile_id uuid)
returns table(
 total_posts bigint,
 total_views bigint,
 completed_views bigint,
 watch_time_ms bigint,
 follower_count bigint,
 comment_count bigint,
 reaction_count bigint
)
language sql stable security definer set search_path=public,pg_temp as $$
 with owned_posts as (
   select p.id from public.posts p
   where p.author_id=p_profile_id and p.deleted_at is null
 )
 select
   (select count(*) from owned_posts),
   (select count(*) from public.post_view_events v join owned_posts p on p.id=v.post_id),
   (select count(*) from public.post_view_events v join owned_posts p on p.id=v.post_id where v.completed),
   (select coalesce(sum(v.watch_ms),0) from public.post_view_events v join owned_posts p on p.id=v.post_id),
   (select count(*) from public.follows f where f.followee_id=p_profile_id),
   (select count(*) from public.comments c join owned_posts p on p.id=c.post_id where c.deleted_at is null),
   (select count(*) from public.reactions r join owned_posts p on p.id=r.post_id)
$$;
revoke all on function public.get_creator_analytics(uuid) from public;
revoke all on function public.get_creator_analytics(uuid) from anon;
revoke all on function public.get_creator_analytics(uuid) from authenticated;
grant execute on function public.get_creator_analytics(uuid) to service_role;
