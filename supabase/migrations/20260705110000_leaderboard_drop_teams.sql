-- Everyone in the org works one campaign as (effectively) one team, so the
-- team standings board and the per-canvasser Team column were noise — squads
-- (day crews) are the group standings that actually mean something. Drop the
-- team view and rebuild the canvasser view without the teams join.

drop view if exists public.team_leaderboard;

-- `create or replace view` can't remove columns — drop and recreate.
drop view if exists public.canvasser_leaderboard;

create view public.canvasser_leaderboard
  with (security_invoker = true) as
  select
    p.id as canvasser_id,
    p.username,
    p.display_name,
    count(k.id) as doors_knocked,
    count(k.id) filter (where k.outcome = 'signed') as signatures
  from public.profiles p
  left join public.knock_logs k on k.canvasser_id = p.id
  group by p.id, p.username, p.display_name;
