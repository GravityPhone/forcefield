-- One row per street, for the turf cutter's SEARCH LIST only (2026-07-27).
--
-- The cutter searches streets, and 22,746 doors collapse to about 1,500 of
-- them. Building that list on the client meant downloading every door first:
-- 23 pages past PostgREST's 1000-row cap before the box could answer a single
-- keystroke. This is the same list, computed where the rows already are, and it
-- arrives in two requests.
--
-- THE VIEW IS DISPLAY-ONLY, AND THAT CONTAINMENT IS THE WHOLE DESIGN.
-- Street names and house numbers are parsed out of the addresses.street TEXT in
-- JavaScript (streetNameOf / houseNumber in lib/streetWalk.ts), and this file
-- re-implements that parsing in SQL. Two implementations of one rule can drift.
-- So this one may feed the search list and NOTHING else: claiming doors,
-- computing segments, door counts and turf membership all keep going through
-- the client parsing and the set_turf_segments RPC exactly as they did. Any
-- drift is then at worst a cosmetic mismatch in a search row, never a wrong
-- turf cut. Do not reach for this view to decide what a turf holds.
--
-- Equivalence was verified against all 22,746 rows before it shipped
-- (scripts/verify-street-summary.mjs, re-runnable): name, city, count, lo and
-- hi match the client's own summaries exactly, on every street. Run it again if
-- either side of the parsing changes.
--
-- A plain view, not a materialized one: the aggregate is a single scan of a
-- 22.7k-row table, the text it reads changes only on a voter-file import
-- (turf saves rewrite turf_id, geocoding writes lat/lng, neither touches
-- street or city), and a matview would add a refresh obligation nobody owns,
-- whose failure mode is silently hiding newly imported streets.
--
-- security_invoker so the caller's own RLS on addresses still applies: without
-- it a view runs with its owner's rights and would hand out rows the reader is
-- not allowed to see.

create or replace view public.street_summary
with (security_invoker = true) as
select
  -- streetNameOf: drop the leading house number and any space after it, trim,
  -- uppercase. [0-9] rather than \d, and the explicit whitespace set on btrim,
  -- so this matches JavaScript's ASCII-only semantics rather than the
  -- database's locale-dependent ones.
  upper(btrim(regexp_replace(a.street, '^[0-9]+[[:space:]]*', ''), E' \t\n\r\f\v')) as street_name,
  a.city,
  count(*)::int as door_count,
  -- houseNumber: the leading digits, or 0 when there are none.
  min(coalesce(substring(a.street from '^[0-9]+')::int, 0))::int as lo,
  max(coalesce(substring(a.street from '^[0-9]+')::int, 0))::int as hi
from public.addresses a
-- The client skips a row whose street is only a number (`if (!name) continue`),
-- so it is absent from its summaries; this keeps the two sets identical.
where btrim(regexp_replace(a.street, '^[0-9]+[[:space:]]*', ''), E' \t\n\r\f\v') <> ''
group by 1, 2;

comment on view public.street_summary is
  'One row per street for the turf cutter search list. DISPLAY ONLY: never use for door claiming, segments or turf membership, which parse street text client-side (see lib/streetWalk.ts).';

-- Every reader of addresses can read this; it derives nothing they could not
-- compute themselves from rows they already have. Deliberately NOT granted to
-- ai_reader: the assistant can already aggregate addresses directly, and a new
-- relation stays unreachable to it unless somebody adds it on purpose.
grant select on public.street_summary to authenticated;
