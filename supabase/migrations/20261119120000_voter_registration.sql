-- Voter registration mode (2026-11-19).
--
-- A campaign is either a PETITION (the app as it has always been) or a voter
-- REGISTRATION drive. Registration work happens in two places, and both land
-- in one table so a report never has to union two sources:
--
--   * at a SITE: a crew stands outside a store or on a campus for a shift.
--     No doors, no map, no roster. One tap per person talked to.
--   * at a DOOR: the same Talk screen, with registration buttons. The visit
--     is still a knock_logs row (so the maps, the walk and the offline queue
--     all keep working untouched), carrying the registration result in
--     knock_logs.reg_result. A trigger mirrors it into registration_logs.
--
-- What is deliberately NOT stored anywhere: the registration form itself.
-- No date of birth, no licence number, no SSN digits, and no reason behind a
-- "not eligible". The paper form or the state's own portal is the legal
-- record; this app counts what happened and stops there.

alter table public.campaigns
  add column mode text not null default 'petition'
  check (mode in ('petition', 'registration'));

-- ------------------------------------------------------------------ sites

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  address text,
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index sites_campaign_idx on public.sites (campaign_id);

-- One row per site per day: who stands where, and when. shift_date is a
-- plain date for the reason squads.squad_date is one: it is a day somebody
-- shows up on, where they are standing, not an instant.
create table public.site_shifts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  shift_date date not null,
  start_time time,
  end_time time,
  goal int check (goal is null or goal >= 0),
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index site_shifts_date_idx on public.site_shifts (shift_date);
create index site_shifts_site_idx on public.site_shifts (site_id, shift_date);

create table public.site_shift_members (
  shift_id uuid not null references public.site_shifts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (shift_id, user_id)
);

create index site_shift_members_user_idx on public.site_shift_members (user_id);

alter table public.sites enable row level security;
alter table public.site_shifts enable row level security;
alter table public.site_shift_members enable row level security;

-- Everyone reads the plan (a canvasser has to find their own shift, and
-- covering for somebody means seeing theirs). Planning is a manager's job:
-- is_admin() is true for campaign managers and admins (historical name).
create policy "sites are readable by authenticated users"
  on public.sites for select to authenticated using (true);
create policy "managers write sites"
  on public.sites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "site shifts are readable by authenticated users"
  on public.site_shifts for select to authenticated using (true);
create policy "managers write site shifts"
  on public.site_shifts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "site crews are readable by authenticated users"
  on public.site_shift_members for select to authenticated using (true);
create policy "managers write site crews"
  on public.site_shift_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------ registration logs

create table public.registration_logs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns (id) on delete set null,
  canvasser_id uuid not null references public.profiles (id) on delete cascade,
  -- Exactly one of these says where it happened: a site shift, or a door
  -- (through the knock that carried it). Both null is allowed and means
  -- "somewhere else", which is better than refusing to count it.
  site_id uuid references public.sites (id) on delete set null,
  shift_id uuid references public.site_shifts (id) on delete set null,
  household_id uuid references public.addresses (id) on delete set null,
  -- Set for door registrations only. Cascade: undoing the knock (tap again
  -- on Talk) removes the registration with it.
  knock_log_id uuid unique references public.knock_logs (id) on delete cascade,
  result text not null check (
    result in ('registered', 'updated', 'already_registered', 'not_eligible', 'declined')
  ),
  occurred_at timestamptz not null default now()
);

create index registration_logs_shift_idx on public.registration_logs (shift_id);
create index registration_logs_canvasser_idx on public.registration_logs (canvasser_id, occurred_at desc);
create index registration_logs_occurred_idx on public.registration_logs (occurred_at);

alter table public.registration_logs enable row level security;

-- Org-readable like knock_logs: it is a record of work. Writes are your own.
create policy "registration logs are readable by authenticated users"
  on public.registration_logs for select to authenticated using (true);
create policy "canvassers insert their own registration logs"
  on public.registration_logs for insert to authenticated
  with check (canvasser_id = auth.uid());
create policy "canvassers delete their own registration logs"
  on public.registration_logs for delete to authenticated
  using (canvasser_id = auth.uid() or public.is_admin());

-- Which campaign a registration belongs to is the canvasser's ACTIVE one at
-- the moment it was logged. Stamped here so no client has to send it (and
-- none can send a wrong one), same idea as stamp_knock_context.
create function public.stamp_registration_campaign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.campaign_id is null then
    select p.campaign_id into new.campaign_id
    from public.profiles p
    where p.id = new.canvasser_id;
  end if;
  return new;
end;
$$;

create trigger stamp_registration_campaign
  before insert on public.registration_logs
  for each row execute function public.stamp_registration_campaign();

-- ------------------------------------------------- door registrations

-- Null on every petition knock. Clients working a petition never send it.
alter table public.knock_logs
  add column reg_result text
  check (
    reg_result is null
    or reg_result in ('registered', 'updated', 'already_registered', 'not_eligible', 'declined')
  );

-- Mirror a door registration into registration_logs. Runs on UPDATE too:
-- Talk swaps an outcome in place by upserting the same client_id, so
-- "Registered" corrected to "Declined" is an update of this column, and
-- corrected to "Not Home" is this column going back to null.
create function public.sync_registration_from_knock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reg_result is null then
    delete from public.registration_logs where knock_log_id = new.id;
  else
    insert into public.registration_logs
      (canvasser_id, household_id, knock_log_id, result, occurred_at)
    values
      (new.canvasser_id, new.household_id, new.id, new.reg_result, new.occurred_at)
    on conflict (knock_log_id) do update
      set result = excluded.result,
          household_id = excluded.household_id,
          occurred_at = excluded.occurred_at;
  end if;
  return new;
end;
$$;

create trigger sync_registration_from_knock
  after insert or update of reg_result, household_id on public.knock_logs
  for each row execute function public.sync_registration_from_knock();
