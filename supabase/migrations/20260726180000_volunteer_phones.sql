-- A number to call the volunteer back on (2026-07-26).
--
-- The "Wants to volunteer" mark (20260726150000) records that somebody would
-- knock doors; this records how to reach them about it. Without it the list on
-- /volunteers is a list of names nobody can act on, which is the same problem
-- the list itself was built to fix.
--
-- ITS OWN TABLE, NOT A COLUMN ON volunteer_interest — the same reasoning that
-- kept member_phones off profiles (20260712120000). volunteer_interest is
-- org-readable (`using (true)`) so every canvasser in the org can see who's on
-- the list, which is right; RLS is row-level, so a phone column there would be
-- readable by all of them too. A member of the public who handed their number
-- to one canvasser at their door did not hand it to sixty phones.
--
-- The FK points at volunteer_interest, not persons, and cascades: a number
-- given so somebody could be called about volunteering has no meaning once
-- that mark is taken back, so the button's undo removes both. (RI actions
-- bypass RLS, so the cascade fires whoever removes the mark.)
--
-- No offline queue, same as the mark itself and appointments: a knock can be
-- replayed silently, but a phone number that didn't save is worth saying out
-- loud while the person is still standing there.

create table public.volunteer_phones (
  person_id uuid primary key
    references public.volunteer_interest (person_id) on delete cascade,
  -- Same loose shape check as member_phones — digits plus the punctuation
  -- people actually type, enough to make a working tel: link. Not E.164
  -- validation; this is typed one-handed on a porch.
  phone text not null check (phone ~ '^\+?[0-9() .-]{7,20}$'),
  -- Who took it down. Also the read gate below, so a canvasser can fix what
  -- they just typed without opening anyone else's numbers.
  recorded_by uuid not null references public.profiles (id) on delete cascade,
  updated_at timestamptz not null default now()
);

create index volunteer_phones_recorded_by_idx on public.volunteer_phones (recorded_by);

alter table public.volunteer_phones enable row level security;

-- Deliberately NOT org-readable like the mark it hangs off. Whoever wrote it
-- down (to correct a typo at the door) and managers (is_admin() = admin +
-- campaign_manager, who do the calling) — nobody else.
create policy "volunteer phones readable by recorder and managers"
  on public.volunteer_phones for select to authenticated
  using (recorded_by = auth.uid() or public.is_admin());

create policy "canvassers record a volunteer phone"
  on public.volunteer_phones for insert to authenticated
  with check (recorded_by = auth.uid() or public.is_admin());

-- Unlike volunteer_interest, this one IS editable — a number can be
-- mistyped, and a wrong number is worse than none.
create policy "recorder or manager fixes a volunteer phone"
  on public.volunteer_phones for update to authenticated
  using (recorded_by = auth.uid() or public.is_admin())
  with check (recorded_by = auth.uid() or public.is_admin());

create policy "recorder or manager removes a volunteer phone"
  on public.volunteer_phones for delete to authenticated
  using (recorded_by = auth.uid() or public.is_admin());

-- Second wall, same as member_phones / member_locations: the admin AI reaches
-- the database through service_role, and a member of the public's phone number
-- is not something to answer questions with.
revoke all on table public.volunteer_phones from service_role;

comment on table public.volunteer_phones is
  'Callback number for someone on the volunteer list. Separate table so it is readable only by whoever took it down and by managers — volunteer_interest itself is org-readable. Cascades when the volunteer mark is removed.';
