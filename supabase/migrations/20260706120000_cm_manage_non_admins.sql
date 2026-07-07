-- Campaign managers manage the whole non-admin roster. A CM runs a campaign —
-- every canvasser, squad leader, and fellow campaign manager on it — so they
-- may set any non-admin's role (to any non-admin role) and move them between
-- teams/squads. Two hard limits stay, enforced here in the DB (not just the
-- UI): a CM can never edit an admin account, and can never mint one. Renaming
-- users (username) and deleting accounts remain true-admin-only.

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
      -- Campaign managers get a narrow lane: change the role/team of a
      -- non-admin, never to or from admin, and never touch the username.
      -- is_admin() here means campaign_manager — super admins already passed
      -- the check above.
      if not (public.is_admin()
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

-- RLS mirrors the trigger: managers may UPDATE non-admin rows. `using` guards
-- the old row (target isn't currently an admin), `with check` guards the new
-- row (target isn't being made an admin). The trigger above still blocks the
-- username edits a manager can't make within that lane.
drop policy "users update own profile, admins update any" on public.profiles;
create policy "users update own profile, managers update non-admins"
  on public.profiles for update
  to authenticated
  using (
    id = auth.uid()
    or public.is_super_admin()
    or (public.is_admin() and role <> 'admin')
  )
  with check (
    id = auth.uid()
    or public.is_super_admin()
    or (public.is_admin() and role <> 'admin')
  );
