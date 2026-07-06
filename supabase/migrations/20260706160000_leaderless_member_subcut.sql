-- In-squad door assignment, canvasser fallback (2026-07-06).
--
-- Dividing a squad's turf among its members is normally a squad leader's job
-- (team_lead sub-cuts, see 20260706140000) or a campaign manager's (they can
-- cut anything already). But a squad can end up with neither — the lead peels
-- off to run another crew, nobody with rank is on it that day. When that
-- happens the canvassers still need to split the doors up so they aren't all
-- knocking the same street.
--
-- So: if a turf is assigned to a squad and NO member of that squad outranks a
-- plain canvasser, any member of that squad may sub-cut it — the same
-- sub-turf machinery leads use, just with the gate opened to canvassers when
-- there's no one above them to do it. The moment a lead or manager joins the
-- squad, this path closes again (can_member_subcut returns false) and only
-- the team_lead / manager paths apply.

-- Can the caller sub-cut inside this parent turf AS A LEADERLESS MEMBER? True
-- when the parent is a top-level, squad-assigned turf; the caller is on that
-- squad; and that squad has no team_lead / campaign_manager / admin member to
-- do the dividing. Security definer so the RLS policies below can call it on
-- turfs without recursing into turfs' own policies (and so it can read
-- profiles.role past RLS).
create or replace function public.can_member_subcut(parent uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.turfs p
    where p.id = parent
      and p.parent_turf_id is null
      and p.squad_id is not null
      -- caller is on the squad this turf is assigned to
      and exists (
        select 1 from public.squad_members sm
        where sm.squad_id = p.squad_id and sm.user_id = auth.uid()
      )
      -- ...and nobody on that squad outranks a canvasser, so there's no
      -- leader/manager present to do the cutting.
      and not exists (
        select 1 from public.squad_members sm2
        join public.profiles pr on pr.id = sm2.user_id
        where sm2.squad_id = p.squad_id
          and pr.role in ('team_lead', 'campaign_manager', 'admin')
      )
  );
$$;

grant execute on function public.can_member_subcut(uuid) to authenticated;

-- --- Leaderless squad members: sub-turfs inside their squad's turf ----------
-- Mirrors the team_lead sub-turf policies, gated on can_member_subcut instead
-- of can_lead_subcut. Permissive policies are OR'd, so a lead who is also
-- (somehow) matched keeps their own path too.

create policy "leaderless members create subturfs"
  on public.turfs for insert to authenticated
  with check (
    public.my_role() = 'canvasser'
    and parent_turf_id is not null
    and public.can_member_subcut(parent_turf_id)
  );

create policy "leaderless members update subturfs"
  on public.turfs for update to authenticated
  using (
    public.my_role() = 'canvasser'
    and parent_turf_id is not null
    and public.can_member_subcut(parent_turf_id)
  )
  with check (
    public.my_role() = 'canvasser'
    and parent_turf_id is not null
    and public.can_member_subcut(parent_turf_id)
  );

create policy "leaderless members delete subturfs"
  on public.turfs for delete to authenticated
  using (
    public.my_role() = 'canvasser'
    and parent_turf_id is not null
    and public.can_member_subcut(parent_turf_id)
  );

-- --- set_turf_segments: add the leaderless-member branch --------------------
-- Same body as 20260706140000, with one extra elsif so a leaderless squad
-- member's sub-cut passes the role gate (the RPC stamps addresses.turf_id, so
-- the RLS policies above aren't enough on their own — the door-pool write has
-- to allow the caller too).

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

  update public.turfs set updated_at = now() where id = target_turf_id;

  return stamped;
end;
$$;
