-- Chat upgrade pack: message reactions, per-user read tracking (unread
-- badges), image/GIF attachments, and an animal avatar per profile.
--
-- NOTE: none of the new chat tables are granted to ai_readonly — private
-- user-to-user chat stays walled off from the admin AI, same as
-- chats/chat_members/chat_messages (see 20260703100000_ai_readonly_query.sql).

-- --- Profile avatar: slug of a Fluent animal SVG shipped in public/avatars/.
alter table public.profiles add column avatar text;

-- --- Attachments: vue-advanced-chat file descriptors [{name,size,type,url}].
-- A message may now be attachment-only (empty body) but never fully empty.
alter table public.chat_messages add column files jsonb;
alter table public.chat_messages drop constraint chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check
  check (char_length(body) <= 4000 and (char_length(body) > 0 or files is not null));

-- --- Reactions -------------------------------------------------------------
-- chat_id is denormalized so realtime subscriptions can filter per-room and
-- RLS can reuse the chat helpers without a join through chat_messages.
create table public.message_reactions (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index message_reactions_chat_idx on public.message_reactions (chat_id);

alter table public.message_reactions enable row level security;

create policy "reactions visible to chat participants"
  on public.message_reactions for select to authenticated
  using (public.chat_kind(chat_id) = 'global' or public.is_chat_member(chat_id));
create policy "participants react as themselves"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = auth.uid()
    and (public.chat_kind(chat_id) = 'global' or public.is_chat_member(chat_id))
  );
create policy "users remove own reactions"
  on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

alter publication supabase_realtime add table public.message_reactions;

-- --- Read tracking ----------------------------------------------------------
create table public.chat_reads (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

alter table public.chat_reads enable row level security;

create policy "users manage own read marks — select"
  on public.chat_reads for select to authenticated using (user_id = auth.uid());
create policy "users manage own read marks — insert"
  on public.chat_reads for insert to authenticated with check (user_id = auth.uid());
create policy "users manage own read marks — update"
  on public.chat_reads for update to authenticated using (user_id = auth.uid());

-- Unread message count per visible chat (only rows with unread > 0). Counts
-- exclude your own messages; a chat never read at all counts everything.
create or replace function public.get_unread_counts()
returns table (chat_id uuid, unread bigint)
language sql stable security definer set search_path = public
as $$
  select c.id, count(m.id)
  from public.chats c
  join public.chat_messages m on m.chat_id = c.id
  left join public.chat_reads r on r.chat_id = c.id and r.user_id = auth.uid()
  where (c.kind = 'global' or public.is_chat_member(c.id))
    and m.sender_id <> auth.uid()
    and m.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz)
  group by c.id
$$;

revoke all on function public.get_unread_counts() from public;
grant execute on function public.get_unread_counts() to authenticated;

-- --- Chat media bucket ------------------------------------------------------
-- Public bucket: message attachments render via plain public URLs. Uploads
-- are limited to authenticated users and capped at 10 MB per object.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-media', 'chat-media', true, 10485760);

create policy "authenticated users upload chat media"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media');
create policy "chat media is publicly readable"
  on storage.objects for select
  using (bucket_id = 'chat-media');
