-- Hunt mode wants a per-outcome breakdown per door (a 2x3 color-coded grid
-- matching the six Talk-mode buttons), not just a total/signed/reached
-- summary. Views can't have columns inserted before existing ones via
-- CREATE OR REPLACE, so drop and recreate with the full column set.
drop view if exists public.household_knock_summary;

create view public.household_knock_summary
  with (security_invoker = true) as
  select
    household_id,
    count(*) as total_knocks,
    count(*) filter (where outcome = 'signed') as signed_count,
    count(*) filter (where outcome = 'didnt_sign') as didnt_sign_count,
    count(*) filter (where outcome = 'maybe') as maybe_count,
    count(*) filter (where outcome = 'not_home') as not_home_count,
    count(*) filter (where outcome = 'skip') as skip_count,
    count(*) filter (where outcome = 'hostile') as hostile_count,
    bool_or(outcome <> 'not_home') as reached
  from public.knock_logs
  where household_id is not null
  group by household_id;
