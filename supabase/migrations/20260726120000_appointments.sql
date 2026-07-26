-- Appointments (2026-07-26): the follow-up behind the outcome button formerly
-- labeled "Maybe", now "Come back another time".
--
-- Tapping it logs the same `maybe` knock it always did (the enum value never
-- moved — see src/lib/outcomes.ts), and then OFFERS a time to come back. The
-- offer is optional at the door and optional campaign-wide: a campaign
-- manager turns the whole thing on or off and sets how long a window is.
--
-- Two tables:
--   appointment_settings — singleton knobs (leaderboard_settings pattern:
--     everyone reads because every client renders per them, is_admin() writes,
--     which covers campaign managers AND admins — historical name).
--   appointments — one row per "come back at X". Deliberately NOT stamped with
--     squad/turf the way knock_logs is: an appointment is looked at through
--     the door it belongs to, and addresses already carries city + turf_id, so
--     analytics joins rather than snapshots. Nothing here dissolves nightly.
--
-- Whether an appointment was KEPT is derived from knock_logs at read time (a
-- knock at that door inside the window), never stored — same reasoning as
-- door status: the knock log is the fact, everything else is a reading of it.
-- `status` therefore only records the one thing knocks can't say, which is
-- that a human called it off.

create table public.appointment_settings (
  id boolean primary key default true check (id),
  -- Off until a campaign manager turns it on. With it off, the outcome button
  -- still logs exactly as before — it just never asks about a time.
  enabled boolean not null default false,
  -- How long a come-back window is. "Between 4 and 6" is the default because
  -- a two-hour window is what a canvasser can honestly promise.
  window_minutes int not null default 120 check (window_minutes between 15 and 480),
  -- The span of the day windows are offered across, in local hours.
  day_start_hour int not null default 9 check (day_start_hour between 0 and 23),
  day_end_hour int not null default 21 check (day_end_hour between 1 and 24),
  updated_at timestamptz not null default now(),
  constraint appointment_settings_day check (day_end_hour > day_start_hour)
);

insert into public.appointment_settings default values;

alter table public.appointment_settings enable row level security;

create policy "appointment settings are readable by authenticated users"
  on public.appointment_settings for select to authenticated using (true);
create policy "managers update appointment settings"
  on public.appointment_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.addresses (id) on delete cascade,
  -- Who you're coming back for, when a name was picked from the roster. Null
  -- is normal: you spoke to whoever opened the door.
  person_id uuid references public.persons (id) on delete set null,
  canvasser_id uuid not null references public.profiles (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- 'canceled' is the only state a knock can't imply. Kept / missed / still
  -- to come are all read off knock_logs and the clock.
  status text not null default 'scheduled' check (status in ('scheduled', 'canceled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_window check (ends_at > starts_at)
);

create index appointments_starts_idx on public.appointments (starts_at);
create index appointments_household_idx on public.appointments (household_id, starts_at desc);
create index appointments_canvasser_idx on public.appointments (canvasser_id, starts_at desc);

alter table public.appointments enable row level security;

-- Readable org-wide, like knock_logs: the point of writing one down is that
-- whoever is on that street tomorrow can pick it up, not just the person who
-- booked it. Writes stay with the canvasser who made the promise (plus
-- managers, who dispatch).
create policy "appointments are readable by authenticated users"
  on public.appointments for select to authenticated using (true);
create policy "canvassers insert their own appointments"
  on public.appointments for insert to authenticated
  with check (canvasser_id = auth.uid() or public.is_admin());
create policy "canvassers update their own appointments"
  on public.appointments for update to authenticated
  using (canvasser_id = auth.uid() or public.is_admin())
  with check (canvasser_id = auth.uid() or public.is_admin());
create policy "canvassers delete their own appointments"
  on public.appointments for delete to authenticated
  using (canvasser_id = auth.uid() or public.is_admin());
