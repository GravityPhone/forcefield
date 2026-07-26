-- Live location sharing with your squad (2026-07-26).
--
-- FOREGROUND ONLY, and the schema is honest about it. A web app cannot ping
-- from a pocket: iOS suspends a home-screen PWA's JavaScript the moment it
-- leaves the screen, and Chrome freezes a backgrounded page shortly after and
-- immediately on lock. So a dot here means "where they were when the app was
-- last open", and the client dims and expires it on a clock rather than
-- pretending otherwise.
--
-- Shaped so the Capacitor shells can take over later without a migration: a
-- native background-location plugin writes the same row through the same
-- upsert, and `source` is what tells the two apart.
--
-- THE ROW'S EXISTENCE IS THE OPT-IN. Turning sharing off deletes it, so there
-- is no "sharing = false" state to get out of sync with reality, and nothing
-- server-side implies a phone is still reporting when the app is closed.
-- Which tier a device pings at is a device preference and stays in
-- localStorage — it changes what gets sent, not what anyone may read.

create table public.member_locations (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  -- Metres of uncertainty as reported by the device, so the map can be honest
  -- about a ping taken indoors off wifi.
  accuracy_m double precision,
  -- 'web' today; a native shell says 'native' without a schema change.
  source text not null default 'web' check (source in ('web', 'native')),
  updated_at timestamptz not null default now()
);

create index member_locations_updated_idx on public.member_locations (updated_at desc);

alter table public.member_locations enable row level security;

-- Your squad sees you, and nobody else does. Deliberately NOT org-readable
-- like knock_logs: a knock is a record of work, a live position is a person.
--
-- DATE-AGNOSTIC ON PURPOSE, matching the sub-cut guards (20260706…): squad_date
-- is a CLIENT-local day, so a server-side current_date test would cut out
-- evening crews near UTC midnight. The client filters to today's squad; this
-- policy just answers "have we ever been crewed together".
create policy "squadmates read each other's location"
  on public.member_locations for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.squad_members mine
      join public.squad_members theirs on theirs.squad_id = mine.squad_id
      where mine.user_id = auth.uid()
        and theirs.user_id = member_locations.user_id
    )
  );

-- Only ever your own position. No manager override on purpose — there is no
-- version of this where somebody else places your dot.
create policy "members write their own location"
  on public.member_locations for insert to authenticated
  with check (user_id = auth.uid());
create policy "members update their own location"
  on public.member_locations for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members stop sharing"
  on public.member_locations for delete to authenticated
  using (user_id = auth.uid());

-- Dots move without a refetch.
alter publication supabase_realtime add table public.member_locations;

-- The AI assistant reads through service_role; a live position is not its
-- business (same reasoning as member_phones).
revoke all on table public.member_locations from service_role;

comment on table public.member_locations is
  'Last known position of a member sharing with their squad. Foreground-only on web — the row exists only while sharing is on, and clients dim/expire it by updated_at. Never org-readable.';
