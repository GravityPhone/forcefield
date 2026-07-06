-- Campaign managers were locked out of turf. 20260705160000 handed them the
-- old-admin feature set (turf included — /turf routes them in), but the turfs
-- write policies and set_turf_segments() still checked
-- my_role() in ('team_lead', 'admin'), so every create/assign/edit from a
-- campaign manager died on RLS ("Could not save the turf"). Widen all four
-- checks to the roles the router actually admits.

drop policy "leads and admins create turfs" on public.turfs;
create policy "leads and admins create turfs"
  on public.turfs for insert to authenticated
  with check (public.my_role() in ('team_lead', 'campaign_manager', 'admin'));

drop policy "leads and admins update turfs" on public.turfs;
create policy "leads and admins update turfs"
  on public.turfs for update to authenticated
  using (public.my_role() in ('team_lead', 'campaign_manager', 'admin'));

drop policy "leads and admins delete turfs" on public.turfs;
create policy "leads and admins delete turfs"
  on public.turfs for delete to authenticated
  using (public.my_role() in ('team_lead', 'campaign_manager', 'admin'));

create or replace function public.set_turf_segments(target_turf_id uuid, segments jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  stamped integer;
begin
  if public.my_role() not in ('team_lead', 'campaign_manager', 'admin') then
    raise exception 'Only squad leaders, campaign managers, and admins can cut turf';
  end if;
  if not exists (select 1 from public.turfs where id = target_turf_id) then
    raise exception 'Turf not found';
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

  -- Free this turf's previous doors, then claim matches. Doors already in
  -- ANOTHER turf are left alone — an address belongs to one turf, first
  -- claim wins, and deleting that turf releases them (FK set null).
  update public.addresses set turf_id = null, updated_at = now()
  where turf_id = target_turf_id;

  update public.addresses a
  set turf_id = target_turf_id, updated_at = now()
  from public.turf_segments s
  where s.turf_id = target_turf_id
    and a.turf_id is null
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
