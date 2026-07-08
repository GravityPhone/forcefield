-- Turf dispatch across days (2026-07-07). Squads stay one-day crews; TURF is
-- the durable library. Pointing a turf at a crew ("dispatch") becomes a
-- first-class daily act with two server-side legs:
--
--  * turf_assignments — append-only history of who each top-level turf was
--    dispatched to, written by trigger whenever its squad_id/assignee_id
--    changes (including to nothing: an all-null row records "pulled off the
--    board"). Squad names are snapshotted because day-squad rows are
--    deletable; "Jul 6 — Kool krew" must survive cleanup.
--
--  * Re-dispatching a turf DISSOLVES its sub-turfs. The per-member door
--    splits ("<name>'s doors") are the old crew's internal division; when the
--    turf moves to a new squad or person they delete, and the existing
--    release_subturf_doors_on_delete trigger (20260706140000) hands every
--    door back to the parent. Without this, yesterday's splits follow their
--    assignees into whatever squad they join today.
--
-- Client semantics that ride on this (no further schema): Squad page and
-- Hunt show only turf dispatched to a TODAY squad, to the viewer directly,
-- or sub-turfs whose parent still is; turf left pointing at a past day's
-- squad is nobody's until re-dispatched, and /turf flags it "not out today".
-- The DB-side sub-cut guards (can_lead_subcut / can_member_subcut) stay
-- date-agnostic on purpose: squad_date values are client-local days, so a
-- server-side current_date check would lock evening crews out around UTC
-- midnight. Re-dispatching is what actually revokes the old crew's rights.

create table public.turf_assignments (
  id uuid primary key default gen_random_uuid(),
  turf_id uuid not null references public.turfs (id) on delete cascade,
  squad_id uuid references public.squads (id) on delete set null,
  -- Snapshot at write time; the FK may null out later without erasing history.
  squad_name text,
  assignee_id uuid references public.profiles (id) on delete set null,
  -- The work day: the squad's own squad_date when dispatched to a squad
  -- (exact); the server date for person assignments (can run a few hours
  -- ahead of an Ohio evening — fine for a history line).
  assigned_on date not null default current_date,
  assigned_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index turf_assignments_turf_idx
  on public.turf_assignments (turf_id, created_at);

alter table public.turf_assignments enable row level security;

-- Read-only to the app: rows are written only by the trigger below
-- (security definer), so no insert/update/delete policies for user roles.
create policy "turf assignment history is readable by authenticated users"
  on public.turf_assignments for select to authenticated using (true);

-- Append one history row for a top-level turf's (re/un)assignment.
-- Sub-turfs are deliberately not logged — they're a crew's intra-day door
-- split, churned constantly by the Squad page's Assign-doors mode.
create or replace function public.log_turf_assignment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  sname text;
  sdate date;
begin
  if new.squad_id is not null then
    select name, squad_date into sname, sdate
    from public.squads where id = new.squad_id;
  end if;
  insert into public.turf_assignments
    (turf_id, squad_id, squad_name, assignee_id, assigned_on, assigned_by)
  values
    (new.id, new.squad_id, sname, new.assignee_id,
     coalesce(sdate, current_date), auth.uid());
  return new;
end;
$$;

create trigger log_turf_assignment_on_insert
  after insert on public.turfs
  for each row
  when (new.parent_turf_id is null
        and (new.squad_id is not null or new.assignee_id is not null))
  execute function public.log_turf_assignment();

create trigger log_turf_assignment_on_update
  after update on public.turfs
  for each row
  when (new.parent_turf_id is null
        and (old.squad_id is distinct from new.squad_id
             or old.assignee_id is distinct from new.assignee_id))
  execute function public.log_turf_assignment();

-- Re-dispatch dissolves the old crew's door splits. Deleting the children
-- fires release_subturf_doors_on_delete first, so their doors land back on
-- this parent before the rows go away. Security definer: the FK's ON DELETE
-- SET NULL can fire this via a squad deletion, where the deleter's own RLS
-- may not reach the child turfs.
create or replace function public.dissolve_subturfs_on_reassign()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.turfs where parent_turf_id = new.id;
  return new;
end;
$$;

create trigger dissolve_subturfs_on_reassign
  after update on public.turfs
  for each row
  when (new.parent_turf_id is null
        and (old.squad_id is distinct from new.squad_id
             or old.assignee_id is distinct from new.assignee_id))
  execute function public.dissolve_subturfs_on_reassign();

-- Backfill: every currently-assigned top-level turf gets its assignment as
-- the first history row, dated by the assigned squad's day (or the turf's
-- last touch for person-assigned turf).
insert into public.turf_assignments
  (turf_id, squad_id, squad_name, assignee_id, assigned_on, assigned_by)
select t.id, t.squad_id, s.name, t.assignee_id,
       coalesce(s.squad_date, t.updated_at::date), t.created_by
from public.turfs t
left join public.squads s on s.id = t.squad_id
where t.parent_turf_id is null
  and (t.squad_id is not null or t.assignee_id is not null);
