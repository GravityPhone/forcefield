-- Door-status color model: a door is only "done" (green) when EVERY resident
-- has signed; one signature out of three is a partly-signed door the crew
-- should look at again (yellow on the maps). The pins need signed-vs-roster
-- counts wherever they already fetch household_latest_knock, so append them
-- to that view (CREATE OR REPLACE keeps existing grants — ai_reader,
-- authenticated — and column additions at the end are allowed).
create or replace view public.household_latest_knock
  with (security_invoker = true) as
  select
    k.household_id,
    k.outcome,
    k.occurred_at,
    coalesce(s.signed_count, 0) as signed_count,
    coalesce(p.person_count, 0) as person_count
  from (
    select distinct on (household_id) household_id, outcome, occurred_at
    from public.knock_logs
    where household_id is not null
    order by household_id, occurred_at desc
  ) k
  left join (
    -- DISTINCT persons: a signature accidentally logged twice for the same
    -- resident must not fake an "everyone signed" door.
    select household_id, count(distinct person_id)::bigint as signed_count
    from public.knock_logs
    where outcome = 'signed' and household_id is not null and person_id is not null
    group by household_id
  ) s on s.household_id = k.household_id
  left join (
    select household_id, count(*)::bigint as person_count
    from public.persons
    group by household_id
  ) p on p.household_id = k.household_id;

-- Same distinct-persons rule for the summary view's signed_count (it feeds
-- the Scout "2/4 signed" ratio and the street-walk everyone-signed test).
-- Column name/type/position unchanged, so CREATE OR REPLACE is safe.
create or replace view public.household_knock_summary
  with (security_invoker = true) as
  select
    household_id,
    count(*) as total_knocks,
    count(distinct person_id) filter (where outcome = 'signed') as signed_count,
    count(*) filter (where outcome = 'didnt_sign') as didnt_sign_count,
    count(*) filter (where outcome = 'maybe') as maybe_count,
    count(*) filter (where outcome = 'not_home') as not_home_count,
    count(*) filter (where outcome = 'skip') as skip_count,
    count(*) filter (where outcome = 'hostile') as hostile_count,
    bool_or(outcome <> 'not_home') as reached
  from public.knock_logs
  where household_id is not null
  group by household_id;
