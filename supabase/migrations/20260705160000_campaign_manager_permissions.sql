-- Campaign managers get every feature admins had until now (turf, AI chat,
-- leaderboard settings, campaigns, bulletins, chat moderation…); true admins
-- keep user management (roles/teams/usernames) exclusively. Plus: two new
-- leadership rooms per team — squad leaders' room and managers' room.

-- --- Role helpers -----------------------------------------------------------

-- True org admin only — gates user management.
create or replace function public.is_super_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false);
$$;

-- Historical name, widened meaning: every policy that gated "admin features"
-- via is_admin() now covers campaign managers too (they inherit the whole
-- pre-2026-07-05 admin feature set). User management checks is_super_admin.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.profiles where id = auth.uid()) in ('admin', 'campaign_manager'),
    false
  );
$$;

create or replace function public.my_role()
returns public.app_role
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- --- User management stays true-admin-only ----------------------------------

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
  return new;
end;
$$;

drop policy "users update own profile, admins update any" on public.profiles;
create policy "users update own profile, admins update any"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_super_admin())
  with check (id = auth.uid() or public.is_super_admin());

drop policy "admins can delete profiles" on public.profiles;
create policy "admins can delete profiles"
  on public.profiles for delete
  to authenticated
  using (public.is_super_admin());

-- --- Leadership rooms per team ----------------------------------------------
-- 'team_leads'    — squad leaders + campaign managers on the team
-- 'team_managers' — campaign managers on the team
-- (True admins can enter any team room, same as before.)

alter table public.chats drop constraint chats_kind_check;
alter table public.chats add constraint chats_kind_check
  check (kind in ('global', 'squad', 'dm', 'team', 'team_leads', 'team_managers'));

-- A team now owns up to three rooms — one per kind.
drop index public.chats_one_per_team_idx;
create unique index chats_one_per_team_kind_idx
  on public.chats (team_id, kind) where team_id is not null;

insert into public.chats (kind, name, team_id)
select 'team_leads', t.name || ' Squad Leaders', t.id
from public.teams t
where not exists (select 1 from public.chats c where c.team_id = t.id and c.kind = 'team_leads');

insert into public.chats (kind, name, team_id)
select 'team_managers', t.name || ' Managers', t.id
from public.teams t
where not exists (select 1 from public.chats c where c.team_id = t.id and c.kind = 'team_managers');

create or replace function public.handle_new_team()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.chats (kind, name, team_id) values
    ('team', new.name, new.id),
    ('team_leads', new.name || ' Squad Leaders', new.id),
    ('team_managers', new.name || ' Managers', new.id);
  return new;
end;
$$;

-- Implicit membership by team + role. Every chat policy that consults
-- is_team_chat_member (chats/messages/reactions/unread counts) picks the
-- new kinds up automatically.
create or replace function public.is_team_chat_member(cid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.chats c
    where c.id = cid
      and c.kind in ('team', 'team_leads', 'team_managers')
      and (
        public.is_super_admin()
        or (
          c.team_id = public.my_team_id()
          and (
            c.kind = 'team'
            or (c.kind = 'team_leads'
                and public.my_role() in ('team_lead', 'campaign_manager', 'admin'))
            or (c.kind = 'team_managers'
                and public.my_role() in ('campaign_manager', 'admin'))
          )
        )
      )
  );
$$;
