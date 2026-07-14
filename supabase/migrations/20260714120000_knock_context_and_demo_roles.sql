-- Knock context stamping + demo role switching.
--
-- 1) knock_logs learns WHICH squad and WHICH turf a knock happened under.
--    Squads live one day and turf is re-cut/re-dispatched all the time, so
--    "join through addresses.turf_id at query time" only ever answers "what
--    turf is that door in NOW". Stamping at insert time is what makes
--    turf/squad analytics honest across days. Names are snapshotted too:
--    sub-turfs dissolve on re-dispatch and squads get wiped, and history
--    should not go blank when the row it pointed at disappears.
--
-- 2) demo_set_own_role(): the public demo needs visitors to try out every
--    role without an admin standing by. A narrow security-definer lane lets
--    a signed-in non-admin move themselves between canvasser / team_lead /
--    campaign_manager — never to or from admin. guard_profile_privileges
--    gets a matching transaction-local escape hatch (a GUC only this
--    function sets), so the guard stays intact for every other path.

-- ============================================================
-- 1) Knock context columns
-- ============================================================

alter table public.knock_logs
  add column squad_id uuid references public.squads (id) on delete set null,
  add column squad_name text,
  add column turf_id uuid references public.turfs (id) on delete set null,
  add column turf_name text;

create index knock_logs_squad_idx on public.knock_logs (squad_id)
  where squad_id is not null;
create index knock_logs_turf_idx on public.knock_logs (turf_id)
  where turf_id is not null;

-- Stamp turf + squad on every new knock. Turf resolves to the TOP-LEVEL
-- turf: doors sitting in a "<name>'s doors" sub-turf report the parent —
-- sub-turfs dissolve on every re-dispatch, and analytics grouped by them
-- would shatter into per-day fragments.
--
-- Squad match: the squad whose squad_date equals the knock's local day and
-- whose roster includes the canvasser. squad_date is a CLIENT-local day (see
-- 20260707120000), so the knock timestamp converts through the campaign's
-- home timezone — Union County, OH. If a canvasser somehow sits in two
-- squads that day, the most recently joined wins.
create or replace function public.stamp_knock_context()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_squad record;
begin
  if new.turf_id is null and new.household_id is not null then
    select coalesce(parent.id, t.id), coalesce(parent.name, t.name)
      into new.turf_id, new.turf_name
    from addresses a
    join turfs t on t.id = a.turf_id
    left join turfs parent on parent.id = t.parent_turf_id
    where a.id = new.household_id;
  end if;

  if new.squad_id is null then
    select s.id, s.name into v_squad
    from squad_members sm
    join squads s on s.id = sm.squad_id
    where sm.user_id = new.canvasser_id
      and s.squad_date = (new.occurred_at at time zone 'America/New_York')::date
    order by sm.joined_at desc
    limit 1;
    if found then
      new.squad_id := v_squad.id;
      new.squad_name := v_squad.name;
    end if;
  end if;

  return new;
end;
$$;

create trigger stamp_knock_context
  before insert on public.knock_logs
  for each row execute function public.stamp_knock_context();

-- Backfill the existing (largely simulated) history. Turf is best-effort —
-- the door's CURRENT top-level turf, since nothing recorded the turf of
-- record at knock time. Squads backfill exactly: the simulator built real
-- per-day squads with correct memberships and joined_at times.

update public.knock_logs k
set turf_id = coalesce(parent.id, t.id),
    turf_name = coalesce(parent.name, t.name)
from public.addresses a
join public.turfs t on t.id = a.turf_id
left join public.turfs parent on parent.id = t.parent_turf_id
where a.id = k.household_id
  and k.turf_id is null;

update public.knock_logs k
set squad_id = s.id,
    squad_name = s.name
from public.squads s
join public.squad_members sm on sm.squad_id = s.id
where k.squad_id is null
  and sm.user_id = k.canvasser_id
  and s.squad_date = (k.occurred_at at time zone 'America/New_York')::date;

-- ============================================================
-- 2) Demo role switching
-- ============================================================

-- The full guard from 20260706120000, plus one new lane at the top of the
-- privileged-change check: a transaction-local GUC that only
-- demo_set_own_role() sets, allowing a self-service role change between the
-- three non-admin roles. Everything else (team/username protection, the CM
-- lane, admins-never-on-teams) is unchanged.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  if (new.role is distinct from old.role
      or new.team_id is distinct from old.team_id
      or new.username is distinct from old.username) then
    if auth.uid() is not null and not public.is_super_admin() then
      -- Demo lane: demo_set_own_role() flags the transaction; only a pure
      -- role move between non-admin roles on your own row fits through.
      if coalesce(current_setting('forcefield.demo_role_swap', true), '') = 'on'
         and old.id = auth.uid()
         and old.role <> 'admin'
         and new.role in ('canvasser', 'team_lead', 'campaign_manager')
         and new.team_id is not distinct from old.team_id
         and new.username is not distinct from old.username then
        null; -- allowed
      -- Campaign managers get a narrow lane: change the role/team of a
      -- non-admin, never to or from admin, and never touch the username.
      -- is_admin() here means campaign_manager — super admins already passed
      -- the check above.
      elsif not (public.is_admin()
              and old.role <> 'admin'
              and new.role <> 'admin'
              and new.username is not distinct from old.username) then
        raise exception 'Only admins can change roles, teams, or usernames';
      end if;
    end if;
  end if;
  -- Admins never belong to a team.
  if new.role = 'admin' then
    new.team_id := null;
  end if;
  return new;
end;
$$;

-- Self-service role switch for the demo. Signed-in non-admins only, and only
-- between the three working roles — admin is unreachable in both directions.
create or replace function public.demo_set_own_role(new_role public.app_role)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  current_role_v public.app_role;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if new_role not in ('canvasser', 'team_lead', 'campaign_manager') then
    raise exception 'That role is not available from the demo switcher';
  end if;
  select role into current_role_v from profiles where id = auth.uid();
  if current_role_v is null then
    raise exception 'No profile found';
  end if;
  if current_role_v = 'admin' then
    raise exception 'Admin accounts cannot demo-switch roles';
  end if;
  -- Transaction-local (the `true` arg): the guard's escape hatch closes
  -- again the moment this transaction ends.
  perform set_config('forcefield.demo_role_swap', 'on', true);
  update profiles set role = new_role where id = auth.uid();
end;
$$;
