-- Admins run the org, they're never part of a campaign/team/squad. Take
-- existing admins off their team, and auto-clear team_id whenever someone
-- is made an admin (the users UI also hides team/squad pickers for admins).

update public.profiles set team_id = null where role = 'admin';

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
      raise exception 'Only admins can change roles, teams, or usernames';
    end if;
  end if;
  -- Admins never belong to a team.
  if new.role = 'admin' then
    new.team_id := null;
  end if;
  return new;
end;
$$;
