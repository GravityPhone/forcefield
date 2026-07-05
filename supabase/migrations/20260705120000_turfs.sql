-- Turf assignment: named cuts of geography, defined as street ranges
-- ("100–298 of Walnut St, even side"), assigned to a squad (the day crew
-- figures out how to work it) or to an individual canvasser. Matches the
-- spec's street-range decision — no map polygons.
--
-- Membership is STAMPED onto addresses.turf_id (the column has waited for
-- this FK since Stage 2) rather than computed per query: pins and turf
-- lookups stay a plain indexed column read, and re-stamping only happens on
-- the rare edit, via set_turf_segments() below.

create table public.turfs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  -- Fixed at creation from a client-side palette so every turf keeps a
  -- stable, distinct color on the map across sessions/devices.
  color text not null default '#7c3aed' check (color ~ '^#[0-9a-fA-F]{6}$'),
  squad_id uuid references public.squads (id) on delete set null,
  assignee_id uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Assigned to a squad, or a person, or nobody — never both at once.
  check (squad_id is null or assignee_id is null)
);

create table public.turf_segments (
  id uuid primary key default gen_random_uuid(),
  turf_id uuid not null references public.turfs (id) on delete cascade,
  -- Normalized like the client's streetNameOf(): leading house number
  -- stripped, trimmed, uppercased ("WALNUT ST").
  street_name text not null check (char_length(street_name) between 1 and 120),
  -- Uppercased; null = match the street in any city.
  city text,
  range_start integer not null check (range_start >= 0),
  range_end integer not null,
  parity text not null default 'both' check (parity in ('both', 'even', 'odd')),
  created_at timestamptz not null default now(),
  check (range_end >= range_start)
);

create index turf_segments_turf_idx on public.turf_segments (turf_id);
create index addresses_turf_idx on public.addresses (turf_id) where turf_id is not null;

-- The one-line alter promised back in 20260702130000: deleting a turf frees
-- its doors automatically.
alter table public.addresses
  add constraint addresses_turf_id_fkey
  foreign key (turf_id) references public.turfs (id) on delete set null;

alter table public.turfs enable row level security;
alter table public.turf_segments enable row level security;

-- Everyone can see turf (canvassers need their own turf on the Hunt map);
-- only team leads and admins cut or assign it.
create policy "turfs are readable by authenticated users"
  on public.turfs for select to authenticated using (true);
create policy "leads and admins create turfs"
  on public.turfs for insert to authenticated
  with check (public.my_role() in ('team_lead', 'admin'));
create policy "leads and admins update turfs"
  on public.turfs for update to authenticated
  using (public.my_role() in ('team_lead', 'admin'));
create policy "leads and admins delete turfs"
  on public.turfs for delete to authenticated
  using (public.my_role() in ('team_lead', 'admin'));

create policy "turf segments are readable by authenticated users"
  on public.turf_segments for select to authenticated using (true);
-- Segment writes happen only through set_turf_segments() (security definer),
-- so no insert/update/delete policies for regular roles.

-- Replace a turf's segments and re-stamp addresses.turf_id in one
-- transaction. Security definer because canvassers' RLS can't (and
-- shouldn't) update addresses; the role check is done here instead.
-- `segments` is a jsonb array of
--   { street_name, city, range_start, range_end, parity }.
-- Returns the number of addresses now stamped with this turf.
create or replace function public.set_turf_segments(target_turf_id uuid, segments jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  stamped integer;
begin
  if public.my_role() not in ('team_lead', 'admin') then
    raise exception 'Only team leads and admins can cut turf';
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

grant execute on function public.set_turf_segments(uuid, jsonb) to authenticated;
