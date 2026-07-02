-- User-to-user chat: one global "Everyone" room, user-created squads (open
-- group chats), and PMs (invite-only, members can add more people).
--
-- Membership model: global has NO membership rows — everyone can read/post
-- by virtue of kind = 'global'. Squads and PMs track members in chat_members.

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('global', 'squad', 'dm')),
  name text, -- squads are named; DMs derive a title from member names
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.chat_members (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index chat_members_user_idx on public.chat_members (user_id);
create index chat_messages_chat_idx on public.chat_messages (chat_id, created_at desc);

-- Security-definer helpers (same pattern as is_admin()): policies on
-- chat_members/chat_messages need to consult chats and chat_members without
-- tripping RLS recursion.
create or replace function public.is_chat_member(cid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.chat_members
    where chat_id = cid and user_id = auth.uid()
  );
$$;

create or replace function public.chat_kind(cid uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select kind from public.chats where id = cid;
$$;

create or replace function public.chat_created_by(cid uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select created_by from public.chats where id = cid;
$$;

alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

-- Chats: global + squads are discoverable by everyone; DMs only by members.
create policy "global and squad chats are visible, dms to members"
  on public.chats for select to authenticated
  using (kind in ('global', 'squad') or public.is_chat_member(id));
create policy "users create squads and dms"
  on public.chats for insert to authenticated
  with check (created_by = auth.uid() and kind in ('squad', 'dm'));
create policy "admins update chats"
  on public.chats for update to authenticated using (public.is_admin());
create policy "admins delete chats"
  on public.chats for delete to authenticated using (public.is_admin());

-- Membership: squad rosters are public (so people can see what they'd join);
-- DM rosters only to members.
create policy "squad membership is visible, dm membership to members"
  on public.chat_members for select to authenticated
  using (public.chat_kind(chat_id) = 'squad' or public.is_chat_member(chat_id));
create policy "join squads, creators seed chats, members add people"
  on public.chat_members for insert to authenticated
  with check (
    public.is_admin()
    -- the chat's creator seeds the initial member list (incl. themselves)
    or public.chat_created_by(chat_id) = auth.uid()
    -- any existing member can add anyone (squads and PMs alike)
    or public.is_chat_member(chat_id)
    -- anyone can join a squad on their own
    or (user_id = auth.uid() and public.chat_kind(chat_id) = 'squad')
  );
create policy "users leave chats, admins remove anyone"
  on public.chat_members for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Messages: global is open to all; squads/DMs to members only.
create policy "chat messages are readable by participants"
  on public.chat_messages for select to authenticated
  using (public.chat_kind(chat_id) = 'global' or public.is_chat_member(chat_id));
create policy "participants send messages as themselves"
  on public.chat_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and (public.chat_kind(chat_id) = 'global' or public.is_chat_member(chat_id))
  );
create policy "senders delete own messages, admins any"
  on public.chat_messages for delete to authenticated
  using (sender_id = auth.uid() or public.is_admin());

-- Live message delivery via Supabase Realtime (postgres_changes respects RLS).
alter publication supabase_realtime add table public.chat_messages;

-- The one global room.
insert into public.chats (kind, name) values ('global', 'Everyone');
