-- Volunteer interest (2026-07-26): the one follow-up after a signature.
--
-- Somebody who just signed and would also KNOCK is worth more to a petition
-- than any other thing that could be asked for on a porch — and every extra
-- question at the door costs conversations later in the night. So this is one
-- ask with one answer, deliberately NOT a battery of chips, NOT yard signs,
-- and NOT email or phone capture. Those were all considered and declined.
--
-- Same shape as appointments (20260726120000): the knock is already written
-- before the sheet appears, so answering is optional and closing it costs
-- nothing.
--
-- ONLY A YES IS RECORDED. There's no "they said no" row, because the useful
-- artifact is a list of people who would help, and a signature only happens
-- once per person so there's no re-asking to suppress. A missing row means
-- "not a volunteer", whether that's because they declined or because the
-- canvasser closed the sheet — a distinction nobody can act on.
--
-- Deliberately NOT gated behind a settings switch the way appointments are.
-- That switch exists because the user asked for the whole appointments
-- feature to be hidden by default; nothing here asked for that, and a switch
-- per feature is how a settings page becomes a wall.

create table public.volunteer_interest (
  -- One row per person, so asking twice is idempotent rather than a pile of
  -- duplicates for whoever follows these up.
  person_id uuid primary key references public.persons (id) on delete cascade,
  -- The door the ask happened at. Not necessarily where they're registered —
  -- a signature can be taken at a neighbour's door — and this is the one that
  -- says where somebody actually stood and talked to them.
  household_id uuid references public.addresses (id) on delete set null,
  -- Who asked, so a follow-up call can start with "you met Angie on Tuesday".
  canvasser_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index volunteer_interest_created_idx on public.volunteer_interest (created_at desc);
create index volunteer_interest_canvasser_idx on public.volunteer_interest (canvasser_id);

alter table public.volunteer_interest enable row level security;

-- Readable org-wide, like knock_logs and appointments: the point of writing
-- one down is that somebody other than the canvasser follows it up.
create policy "volunteer interest is readable by authenticated users"
  on public.volunteer_interest for select to authenticated using (true);

-- Anyone canvassing records one against their own name; managers can correct.
create policy "canvassers record volunteer interest"
  on public.volunteer_interest for insert to authenticated
  with check (canvasser_id = auth.uid() or public.is_admin());

-- The undo, for a mis-tap at the door.
create policy "canvassers remove their own volunteer interest"
  on public.volunteer_interest for delete to authenticated
  using (canvasser_id = auth.uid() or public.is_admin());

comment on table public.volunteer_interest is
  'People who signed and said they would also knock doors. One row per person, yes-only — see the migration header for why there is no "declined" state.';
