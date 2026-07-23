-- Honest turf segments (2026-07-23).
--
-- An address structurally belongs to AT MOST ONE turf — membership is the
-- single addresses.turf_id column, so "a door in two turfs" has never been
-- possible at the data level. What WAS possible: a turf's stored
-- turf_segments ranges could overlap doors owned by another turf. The claim
-- step skips those doors ("first claim wins"), but the segment rows still
-- declared the full swept range — so the turf list overstated what a turf
-- owned, and a later re-save of that turf could silently annex doors freed
-- in the meantime.
--
-- Fix: after claiming, set_turf_segments rewrites the target turf's segment
-- rows FROM the doors it actually claimed — ranges trim to claimed doors and
-- split around house numbers whose doors all stayed with someone else. A
-- turf's stored definition now never covers another turf's doors.
--
-- Deliberately unchanged: a sub-turf's doors still fall inside its PARENT's
-- stored ranges (the parent's rows aren't touched when a sub-turf claims
-- from its pool) — dissolution has to return them, that overlap is the
-- design. And auth gates are identical to 20260706160000.

create or replace function public.set_turf_segments(target_turf_id uuid, segments jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  stamped integer;
  parent_id uuid;
begin
  select parent_turf_id into parent_id
  from public.turfs where id = target_turf_id;
  if not found then
    raise exception 'Turf not found';
  end if;

  -- auth.uid() is null in the SQL editor / service contexts — trusted, same
  -- as every guard since init_auth_roles.
  if auth.uid() is null or public.my_role() in ('campaign_manager', 'admin') then
    null;
  elsif public.my_role() = 'team_lead'
        and parent_id is not null
        and public.can_lead_subcut(parent_id) then
    null;
  elsif public.my_role() = 'canvasser'
        and parent_id is not null
        and public.can_member_subcut(parent_id) then
    null;
  else
    raise exception 'Only campaign managers cut turf; squad leaders (or, when a squad has none, its members) can only sub-cut inside turf assigned to them';
  end if;

  delete from public.turf_segments where turf_id = target_turf_id;

  insert into public.turf_segments (turf_id, street_name, city, range_start, range_end, parity)
  select
    target_turf_id,
    upper(btrim(s.street_name)),
    nullif(upper(btrim(coalesce(s.city, ''))), ''),
    s.range_start,
    s.range_end,
    coalesce(s.parity, 'both')
  from jsonb_to_recordset(coalesce(segments, '[]'::jsonb))
    as s(street_name text, city text, range_start integer, range_end integer, parity text);

  -- Free this turf's previous doors: back to the parent for a sub-turf,
  -- unassigned for a top-level turf (parent_id is null then, same UPDATE).
  update public.addresses set turf_id = parent_id, updated_at = now()
  where turf_id = target_turf_id;

  -- Claim matches from this turf's pool: `is not distinct from` makes that
  -- the unassigned pool (parent_id null) or the parent's doors (parent_id
  -- set) with one predicate.
  update public.addresses a
  set turf_id = target_turf_id, updated_at = now()
  from public.turf_segments s
  where s.turf_id = target_turf_id
    and a.turf_id is not distinct from parent_id
    -- Same normalization as the client's streetNameOf()/houseNumber().
    and upper(btrim(regexp_replace(a.street, '^\d+\s*', ''))) = s.street_name
    and coalesce((substring(a.street from '^\d{1,9}'))::integer, 0)
        between s.range_start and s.range_end
    and (
      s.parity = 'both'
      or (coalesce((substring(a.street from '^\d{1,9}'))::integer, 0) % 2 = 0)
         = (s.parity = 'even')
    )
    and (s.city is null or upper(a.city) = s.city);

  get diagnostics stamped = row_count;

  -- Rewrite the stored segments from the claimed doors. One statement so
  -- every CTE shares the same snapshot: `seg` reads the swept rows, `wipe`
  -- drops them, and the INSERT stores the trimmed truth. A house number
  -- counts as claimed when ANY of its doors is ours (units can split);
  -- numbers whose doors ALL belong elsewhere break a range in two.
  with seg as (
    select s.id, s.street_name, s.city, s.parity, s.range_start, s.range_end
    from public.turf_segments s
    where s.turf_id = target_turf_id
  ),
  doors as (
    select seg.id as seg_id, seg.street_name, seg.city, seg.parity,
           coalesce((substring(a.street from '^\d{1,9}'))::integer, 0) as n,
           bool_or(a.turf_id = target_turf_id) as claimed
    from seg
    join public.addresses a
      on upper(btrim(regexp_replace(a.street, '^\d+\s*', ''))) = seg.street_name
     and coalesce((substring(a.street from '^\d{1,9}'))::integer, 0)
         between seg.range_start and seg.range_end
     and (
       seg.parity = 'both'
       or (coalesce((substring(a.street from '^\d{1,9}'))::integer, 0) % 2 = 0)
          = (seg.parity = 'even')
     )
     and (seg.city is null or upper(a.city) = seg.city)
    group by seg.id, seg.street_name, seg.city, seg.parity,
             coalesce((substring(a.street from '^\d{1,9}'))::integer, 0)
  ),
  runs as (
    select seg_id, street_name, city, parity, n, claimed,
           count(*) filter (where not claimed)
             over (partition by seg_id order by n) as breaks
    from doors
  ),
  honest as (
    select street_name, city, parity, min(n) as range_start, max(n) as range_end
    from runs
    where claimed
    group by seg_id, street_name, city, parity, breaks
  ),
  wipe as (
    delete from public.turf_segments where turf_id = target_turf_id
  )
  insert into public.turf_segments (turf_id, street_name, city, range_start, range_end, parity)
  select distinct target_turf_id, street_name, city, range_start, range_end, parity
  from honest;

  update public.turfs set updated_at = now() where id = target_turf_id;

  return stamped;
end;
$$;
