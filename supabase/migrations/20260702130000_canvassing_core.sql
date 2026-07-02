-- Forcefield Stage 2: canvassing core — addresses, persons, knock logs.
-- Applied via the Supabase Management API (no CLI on this machine).

-- Trigram indexes power the live search-as-you-type ILIKE queries.
create extension if not exists pg_trgm with schema extensions;

-- Closed domain, matches the six fixed Talk-mode buttons. Enum like app_role.
create type public.knock_outcome as enum
  ('signed', 'didnt_sign', 'maybe', 'not_home', 'skip', 'hostile');

-- Household / address. turf_id stays a bare uuid until the turfs table ships
-- in the turf-assignment stage; adding the FK later is a one-line alter.
create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  street text not null,
  unit text,
  city text not null,
  county text,
  zip text,
  lat double precision,
  lng double precision,
  turf_id uuid,
  data_source text not null default 'manual'
    check (data_source in ('csv_import', 'minivan', 'demo', 'manual')),
  registered_voter boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Person. household_id is nullable — a street/parking-lot walk-up can have a
-- name with no address on file. Multiple persons per address form the roster.
create table public.persons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  household_id uuid references public.addresses (id) on delete set null,
  voter_file_id text,
  registered_voter boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Knock log — the core event. person_id/household_id both nullable so an
-- anonymous walk-up can be logged in two taps. client_id is generated on the
-- device so the offline queue can replay safely (upsert dedupes on it).
-- canvasser_id cascades on profile delete: acceptable at demo scale.
create table public.knock_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique,
  person_id uuid references public.persons (id) on delete set null,
  household_id uuid references public.addresses (id) on delete set null,
  canvasser_id uuid not null references public.profiles (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  outcome public.knock_outcome not null,
  notes text,
  created_at timestamptz not null default now()
);

-- Search + lookup indexes.
create index addresses_street_trgm on public.addresses
  using gin (street extensions.gin_trgm_ops);
create index addresses_city_trgm on public.addresses
  using gin (city extensions.gin_trgm_ops);
create index persons_name_trgm on public.persons
  using gin (name extensions.gin_trgm_ops);
create index persons_household_idx on public.persons (household_id);
create index knock_logs_household_idx on public.knock_logs (household_id, occurred_at desc);
create index knock_logs_person_idx on public.knock_logs (person_id, occurred_at desc);
create unique index persons_voter_file_id_key on public.persons (voter_file_id)
  where voter_file_id is not null;

-- Latest outcome per household → Hunt-tab pin colors. A view (not a
-- denormalized column) stays correct when offline knocks replay out of order.
-- security_invoker so it runs under the caller's RLS, not the owner's.
create view public.household_latest_knock
  with (security_invoker = true) as
  select distinct on (household_id) household_id, outcome, occurred_at
  from public.knock_logs
  where household_id is not null
  order by household_id, occurred_at desc;

-- Row-level security.
alter table public.addresses enable row level security;
alter table public.persons enable row level security;
alter table public.knock_logs enable row level security;

-- Addresses: every canvasser needs to search/browse them; only admins mutate
-- (rows arrive via import scripts using the service role, which bypasses RLS).
create policy "addresses are readable by authenticated users"
  on public.addresses for select to authenticated using (true);
create policy "admins insert addresses"
  on public.addresses for insert to authenticated with check (public.is_admin());
create policy "admins update addresses"
  on public.addresses for update to authenticated using (public.is_admin());
create policy "admins delete addresses"
  on public.addresses for delete to authenticated using (public.is_admin());

-- Persons: same shape as addresses.
create policy "persons are readable by authenticated users"
  on public.persons for select to authenticated using (true);
create policy "admins insert persons"
  on public.persons for insert to authenticated with check (public.is_admin());
create policy "admins update persons"
  on public.persons for update to authenticated using (public.is_admin());
create policy "admins delete persons"
  on public.persons for delete to authenticated using (public.is_admin());

-- Knock logs: readable org-wide (leaderboards now, admin AI chat later — the
-- spec calls for real-time read access, so don't lock reads down per-team).
-- Canvassers may only insert their own logs.
create policy "knock logs are readable by authenticated users"
  on public.knock_logs for select to authenticated using (true);
create policy "canvassers insert their own knock logs"
  on public.knock_logs for insert to authenticated
  with check (canvasser_id = auth.uid() or public.is_admin());
create policy "admins update knock logs"
  on public.knock_logs for update to authenticated using (public.is_admin());
create policy "admins delete knock logs"
  on public.knock_logs for delete to authenticated using (public.is_admin());
