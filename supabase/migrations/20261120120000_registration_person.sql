-- The Site tab on Canvass looks a name up on the voter roll before logging
-- (2026-11-20). When the person IS on the roll, the log keeps who it was, so
-- the site's list for the day can say "Already registered: Dana Reyes" and
-- the same name is not looked up twice.
--
-- Null for everybody who is not on the roll, which is every new registrant:
-- the rule that nothing about the form is stored still holds. This is a
-- pointer at a row the voter file already has, never a new record of a person.
alter table public.registration_logs
  add column person_id uuid references public.persons (id) on delete set null;

create index registration_logs_person_idx on public.registration_logs (person_id)
  where person_id is not null;
