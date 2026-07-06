-- Turf roles corrected (2026-07-06): cutting and assigning turf is a
-- CAMPAIGN MANAGER job — squad leaders lose the org-wide cutter they've had
-- since 20260705120000. What squad leaders get instead is SUB-TURFS: cuts
-- made INSIDE a turf already assigned to them (directly, or via a squad
-- they're on), for dividing the crew's assignment door by door.
--
-- A sub-turf is an ordinary turfs row with parent_turf_id set, so Hunt
-- shading, squad-page progress, and squad/canvasser assignment all keep
-- working unchanged. Its doors are carved OUT of the parent's doors
-- (addresses.turf_id moves from parent to child) and return to the parent
-- when the sub-turf is deleted or re-cut smaller.

alter table public.turfs
  add column parent_turf_id uuid references public.turfs (id) on delete set null;

create index turfs_parent_idx on public.turfs (parent_turf_id)
  where parent_turf_id is not null;

-- Can the caller sub-cut inside this parent turf? True when the parent is
-- top-level (one level of nesting only) and assigned to the caller — by
-- name, or via membership in the squad it's assigned to. The squad row
-- itself is the assignment target, so no date filtering: membership in THAT
-- squad is the credential. Security definer so RLS policies below can call
-- it on turfs without recursing into turfs policies.
create or replace function public.can_lead_subcut(parent uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.turfs p
    where p.id = parent
      and p.parent_turf_id is null
      and (
        p.assignee_id = auth.uid()
        or (p.squad_id is not null and exists (
          select 1 from public.squad_members sm
          where sm.squad_id = p.squad_id and sm.user_id = auth.uid()
        ))
      )
  );
$$;

grant execute on function public.can_lead_subcut(uuid) to authenticated;

-- --- Top-level turf writes: campaign managers + admins only -----------------

drop policy "leads and admins create turfs" on public.turfs;
drop policy "leads and admins update turfs" on public.turfs;
drop policy "leads and admins delete turfs" on public.turfs;

create policy "managers create turfs"
  on public.turfs for insert to authenticated
  with check (public.my_role() in ('campaign_manager', 'admin'));

create policy "managers update turfs"
  on public.turfs for update to authenticated
  using (public.my_role() in ('campaign_manager', 'admin'))
  with check (public.my_role() in ('campaign_manager', 'admin'));

create policy "managers delete turfs"
  on public.turfs for delete to authenticated
  using (public.my_role() in ('campaign_manager', 'admin'));

-- --- Squad leaders: sub-turfs inside turf that's theirs ---------------------

create policy "leads create subturfs inside their turf"
  on public.turfs for insert to authenticated
  with check (
    public.my_role() = 'team_lead'
    and parent_turf_id is not null
    and public.can_lead_subcut(parent_turf_id)
  );

create policy "leads update subturfs inside their turf"
  on public.turfs for update to authenticated
  using (
    public.my_role() = 'team_lead'
    and parent_turf_id is not null
    and public.can_lead_subcut(parent_turf_id)
  )
  with check (
    public.my_role() = 'team_lead'
    and parent_turf_id is not null
    and public.can_lead_subcut(parent_turf_id)
  );

create policy "leads delete subturfs inside their turf"
  on public.turfs for delete to authenticated
  using (
    public.my_role() = 'team_lead'
    and parent_turf_id is not null
    and public.can_lead_subcut(parent_turf_id)
  );

-- --- Deleting a sub-turf hands its doors back to the parent -----------------
-- (Runs before the row goes away; the addresses FK's ON DELETE SET NULL then
-- finds nothing left pointing at the sub-turf. Deleting a top-level turf
-- keeps the old behavior: its own doors go unassigned via the FK, and any
-- children become top-level via parent_turf_id's SET NULL.)

create or replace function public.release_subturf_doors()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.addresses
  set turf_id = old.parent_turf_id, updated_at = now()
  where turf_id = old.id;
  return old;
end;
$$;

create trigger release_subturf_doors_on_delete
  before delete on public.turfs
  for each row when (old.parent_turf_id is not null)
  execute function public.release_subturf_doors();

-- --- set_turf_segments: role scoping + parent-aware door pool ---------------
-- Campaign managers/admins cut anything. Squad leaders only re-cut sub-turfs
-- inside turf that's theirs. A sub-turf claims doors from ITS PARENT's pool
-- (and releases back to the parent); a top-level turf claims unassigned
-- doors as before. Doors in any other turf stay put — first claim wins.

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
  else
    raise exception 'Only campaign managers cut turf; squad leaders can only sub-cut inside turf assigned to them';
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
