-- Forcefield — Stage 1: roles, teams, profiles, RLS, seed admin.
-- Future tables (households, knock_logs, turfs) come in later migrations;
-- the role helpers below are designed to be reused by their RLS policies.

-- ============================================================
-- Roles & core tables
-- ============================================================

create type public.app_role as enum ('canvasser', 'team_lead', 'admin');

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  display_name text,
  role public.app_role not null default 'canvasser',
  team_id uuid references public.teams (id) on delete set null,
  theme jsonb not null default '{"mode": "light", "accent": "blue"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Role helpers (security definer so RLS policies on profiles
-- can check roles without recursing into profiles' own policies)
-- ============================================================

create or replace function public.my_role()
returns public.app_role
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false);
$$;

create or replace function public.my_team_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select team_id from public.profiles where id = auth.uid();
$$;

-- ============================================================
-- Auto-create a profile when an auth user signs up.
-- Username comes from signup metadata; falls back to the email local part.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Guard: only admins may change role or team assignment.
-- (auth.uid() is null in the SQL editor / service contexts — those are trusted.)
-- ============================================================

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
    if auth.uid() is not null and not public.is_admin() then
      raise exception 'Only admins can change roles, teams, or usernames';
    end if;
  end if;
  return new;
end;
$$;

create trigger on_profile_update
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.profiles enable row level security;
alter table public.teams enable row level security;

-- Any logged-in user can see profiles (needed for leaderboards / team views later).
create policy "profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

-- Users can update their own profile (display name, theme); admins can update anyone.
-- The guard trigger above prevents non-admins from touching role/team/username.
create policy "users update own profile, admins update any"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create policy "admins can delete profiles"
  on public.profiles for delete
  to authenticated
  using (public.is_admin());

create policy "teams are readable by authenticated users"
  on public.teams for select
  to authenticated
  using (true);

create policy "admins manage teams"
  on public.teams for insert
  to authenticated
  with check (public.is_admin());

create policy "admins update teams"
  on public.teams for update
  to authenticated
  using (public.is_admin());

create policy "admins delete teams"
  on public.teams for delete
  to authenticated
  using (public.is_admin());

-- ============================================================
-- Seed: demo team + initial admin account
--   username: admin       password: forcefield-admin
-- (Change the password before any real rollout.)
-- ============================================================

insert into public.teams (name) values ('Demo Team');

do $$
declare
  admin_id uuid := gen_random_uuid();
begin
  -- The token columns must be '' rather than their NULL default — Supabase's
  -- auth server errors with "Database error querying schema" trying to read
  -- a NULL into these on login. Only manual inserts hit this; normal signups
  -- go through GoTrue, which already sets them correctly.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current,
    reauthentication_token, phone_change, phone_change_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    admin_id,
    'authenticated',
    'authenticated',
    'admin@example.com',
    extensions.crypt('forcefield-admin', extensions.gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}',
    '{"username": "admin"}',
    now(),
    now(),
    '', '', '', '', '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(),
    admin_id,
    admin_id::text,
    'email',
    jsonb_build_object('sub', admin_id::text, 'email', 'admin@example.com', 'email_verified', true),
    now(),
    now(),
    now()
  );

  -- The signup trigger created the profile; elevate it.
  update public.profiles set role = 'admin' where id = admin_id;
end;
$$;
