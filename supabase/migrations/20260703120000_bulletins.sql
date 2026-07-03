-- Campaign bulletin: admin-posted announcements everyone on the campaign can
-- read. Deliberately NOT built on the chats/chat_messages tables — bulletins
-- get a dedicated feed page (not the chat UI), need no membership model, and
-- unlike private chats they SHOULD be readable by the admin AI assistant,
-- whose walled-off REVOKE covers the chat tables specifically. A fresh table
-- inherits service_role's default full grant, so the AI's read-only SQL tool
-- can see announcements with no extra grants.

create table public.bulletins (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles (id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 8000),
  created_at timestamptz not null default now()
);

create index bulletins_created_idx on public.bulletins (created_at desc);

alter table public.bulletins enable row level security;

create policy "bulletins are readable by authenticated users"
  on public.bulletins for select to authenticated using (true);
create policy "admins post bulletins as themselves"
  on public.bulletins for insert to authenticated
  with check (public.is_admin() and author_id = auth.uid());
create policy "admins update bulletins"
  on public.bulletins for update to authenticated using (public.is_admin());
create policy "admins delete bulletins"
  on public.bulletins for delete to authenticated using (public.is_admin());

-- Live delivery so an open bulletin page picks up new announcements.
alter publication supabase_realtime add table public.bulletins;
