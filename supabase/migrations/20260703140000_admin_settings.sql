-- Persist the admin's own Anthropic API key server-side instead of browser
-- localStorage, so it survives across devices/browsers for that account.
--
-- Deliberately NOT a column on profiles: profiles has a "readable by any
-- authenticated user" SELECT policy (needed for chat/leaderboards), so any
-- column added there is visible to everyone via `select=column_name`
-- filtered to that admin's row. A dedicated table scoped to owner_id keeps
-- the key visible only to the admin who owns it.
create table public.admin_settings (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  anthropic_api_key text,
  updated_at timestamptz not null default now()
);

alter table public.admin_settings enable row level security;

create policy "admins read own settings"
  on public.admin_settings for select to authenticated
  using (owner_id = auth.uid() and public.is_admin());
create policy "admins upsert own settings"
  on public.admin_settings for insert to authenticated
  with check (owner_id = auth.uid() and public.is_admin());
create policy "admins update own settings"
  on public.admin_settings for update to authenticated
  using (owner_id = auth.uid() and public.is_admin())
  with check (owner_id = auth.uid() and public.is_admin());
