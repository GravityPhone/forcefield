-- Per-door knock summary for Hunt mode: "2 knocks", "3/4 signed", and a
-- reached/not-reached flag (reached = at least one knock outcome other than
-- not_home — any actual contact, successful or not).
create view public.household_knock_summary
  with (security_invoker = true) as
  select
    household_id,
    count(*) as total_knocks,
    count(*) filter (where outcome = 'signed') as signed_count,
    bool_or(outcome <> 'not_home') as reached
  from public.knock_logs
  where household_id is not null
  group by household_id;
