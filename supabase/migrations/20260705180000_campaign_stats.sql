-- Campaign-wide progress ("how are WE doing"), visible to everyone working
-- the campaign. Canvassers/squad leaders/campaign managers get their own
-- campaign (resolved through their team); org admins may pass any campaign
-- id to switch between campaigns. Knocks attribute to a campaign through
-- the canvasser's current team → campaign link.
create or replace function public.get_campaign_stats(cid uuid default null)
returns table (
  campaign_id uuid,
  campaign_name text,
  doors bigint,
  signatures bigint,
  doors_7d bigint,
  signatures_7d bigint,
  canvassers bigint
)
language sql stable security definer set search_path = public
as $$
  with target as (
    select case
      -- Only org admins get to pick a campaign; everyone else always
      -- reads their own (their team's) campaign, whatever they pass.
      when cid is not null and public.is_super_admin() then cid
      else (select t.campaign_id from public.teams t where t.id = public.my_team_id())
    end as id
  )
  select
    c.id,
    c.name,
    count(k.id),
    count(k.id) filter (where k.outcome = 'signed'),
    count(k.id) filter (where k.occurred_at > now() - interval '7 days'),
    count(k.id) filter (where k.outcome = 'signed' and k.occurred_at > now() - interval '7 days'),
    count(distinct k.canvasser_id)
  from public.campaigns c
  join target on target.id = c.id
  left join public.teams tm on tm.campaign_id = c.id
  left join public.profiles p on p.team_id = tm.id
  left join public.knock_logs k on k.canvasser_id = p.id
  group by c.id, c.name
$$;

revoke all on function public.get_campaign_stats(uuid) from public;
grant execute on function public.get_campaign_stats(uuid) to authenticated;
