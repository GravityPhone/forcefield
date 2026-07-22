-- Campaign signature goal: a target the whole org is driving toward (the UBI
-- petition needs a fixed number of valid signatures to qualify). Nullable —
-- a campaign without a goal just shows totals, no progress bar.
alter table public.campaigns
  add column if not exists signature_goal integer
  check (signature_goal is null or signature_goal > 0);

comment on column public.campaigns.signature_goal is
  'Target signature count for the campaign (petition qualification threshold). Null = no goal set.';

-- Surface the goal through the stats RPC so every progress card gets it in
-- the same round trip. Return type changes, so drop + recreate.
drop function if exists public.get_campaign_stats(uuid);

create or replace function public.get_campaign_stats(cid uuid default null)
returns table (
  campaign_id uuid,
  campaign_name text,
  doors bigint,
  signatures bigint,
  doors_7d bigint,
  signatures_7d bigint,
  canvassers bigint,
  signature_goal integer
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
    count(distinct k.canvasser_id),
    c.signature_goal
  from public.campaigns c
  join target on target.id = c.id
  left join public.teams tm on tm.campaign_id = c.id
  left join public.profiles p on p.team_id = tm.id
  left join public.knock_logs k on k.canvasser_id = p.id
  group by c.id, c.name, c.signature_goal
$$;

revoke all on function public.get_campaign_stats(uuid) from public;
grant execute on function public.get_campaign_stats(uuid) to authenticated;

-- The demo campaign's target: 8,000 signatures for the UBI petition.
update public.campaigns set signature_goal = 8000 where name = 'UBI';
