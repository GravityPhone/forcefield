-- Persistent admin AI chats, with a browsable history (2026-07-26).
--
-- /admin/chat held its whole conversation in a Vue ref, so a reload lost it.
-- These two tables are the store behind a ChatGPT-style history: reopen,
-- rename, delete, new chat.
--
-- THE `ai_` PREFIX IS LOAD-BEARING. `chats` / `chat_messages` / `chat_members`
-- / `chat_reads` already exist and belong to the USER-TO-USER chat feature.
-- Nothing here touches those.
--
-- Persistence is entirely client-side reads and writes: netlify/functions/chat.ts
-- is stateless across turns (the client posts the full history every send), so
-- it needed no changes and holds no reference to these tables.

create table public.ai_chats (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  -- Derived from the first user message, trimmed. Renaming it is a plain
  -- update; naming a chat never costs an API call against the admin's key.
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The history list is "mine, newest first" and nothing else.
create index ai_chats_owner_idx on public.ai_chats (owner_id, updated_at desc);

create table public.ai_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.ai_chats (id) on delete cascade,
  -- Position in the conversation, 0-based. The view's edit button is a REWIND
  -- — it pulls a user message back into the input and drops it plus everything
  -- after it — so the stored side has to be able to drop a tail: delete where
  -- seq >= n. Ordering by created_at could not do that unambiguously.
  seq integer not null,
  role text not null check (role in ('user', 'assistant')),
  -- The text AFTER extractFollowups() has stripped the ```followups trailer,
  -- because that is what the view renders and what goes back on the wire.
  text text not null,
  -- The tool-trace chips under an answer ("Searched database" ×3). Part of the
  -- answer, not decoration.
  activity jsonb,
  -- The three tap-to-send follow-ups. Stored SEPARATELY precisely because
  -- `text` is the stripped version — strip the block and they are gone unless
  -- they are kept here.
  suggestions jsonb,
  created_at timestamptz not null default now(),
  unique (chat_id, seq)
);
-- The (chat_id, seq) unique constraint is the read index too: every query is
-- "this chat, in order".

-- Infographic and turf-plan cards are re-derived from `text` at render time
-- (splitSegments in src/lib/infographic.ts), so there is deliberately no
-- column for card specs — storing them would be a second copy that can drift.

alter table public.ai_chats enable row level security;
alter table public.ai_chat_messages enable row level security;

-- OWNER ONLY, both tables. No org read, no manager override, no is_admin()
-- bypass: a manager's conversation with the assistant is theirs. This is the
-- one place in the app where a campaign manager's data is private from other
-- campaign managers, and that is the point.
create policy "owners read their own ai chats"
  on public.ai_chats for select to authenticated
  using (owner_id = auth.uid());
create policy "owners start ai chats"
  on public.ai_chats for insert to authenticated
  with check (owner_id = auth.uid());
create policy "owners rename their ai chats"
  on public.ai_chats for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners delete their ai chats"
  on public.ai_chats for delete to authenticated
  using (owner_id = auth.uid());

-- Messages inherit ownership from their chat rather than carrying a duplicate
-- owner_id: one source of truth, and the exists() is a primary-key lookup.
create policy "owners read their ai chat messages"
  on public.ai_chat_messages for select to authenticated
  using (
    exists (
      select 1 from public.ai_chats c
      where c.id = ai_chat_messages.chat_id and c.owner_id = auth.uid()
    )
  );
create policy "owners write their ai chat messages"
  on public.ai_chat_messages for insert to authenticated
  with check (
    exists (
      select 1 from public.ai_chats c
      where c.id = ai_chat_messages.chat_id and c.owner_id = auth.uid()
    )
  );
-- Rewinding deletes a tail; nothing ever edits a stored message in place, so
-- there is no UPDATE policy and therefore no UPDATE.
create policy "owners rewind their ai chat messages"
  on public.ai_chat_messages for delete to authenticated
  using (
    exists (
      select 1 from public.ai_chats c
      where c.id = ai_chat_messages.chat_id and c.owner_id = auth.uid()
    )
  );

-- The list sorts by updated_at, so a new message has to move its chat to the
-- top. SECURITY INVOKER on purpose: the update runs under the caller, whose
-- own "rename" policy already allows exactly this row, and the insert that
-- fired the trigger was vetted by the insert policy above.
create or replace function public.touch_ai_chat()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.ai_chats set updated_at = now() where id = new.chat_id;
  return new;
end;
$$;

create trigger ai_chat_messages_touch
  after insert on public.ai_chat_messages
  for each row execute function public.touch_ai_chat();

-- The assistant must never be able to read anyone's chat history — including
-- its own transcripts. Since 20260713120000 the SQL tool runs as `ai_reader`,
-- an ALLOW-LIST role, so an ungranted table is already unreachable; this is
-- the second wall, and it matches the REVOKEs that migration put on
-- admin_settings / message_reactions / chat_reads. netlify/functions/chat.ts
-- still holds a service_role client for the RPC hop.
revoke all on table public.ai_chats from service_role;
revoke all on table public.ai_chat_messages from service_role;

comment on table public.ai_chats is
  'One saved conversation with the admin AI assistant. Owner-only, always — no org read, no manager override. Distinct from public.chats, which is the user-to-user chat feature.';
comment on table public.ai_chat_messages is
  'Turns of an ai_chats conversation, ordered by seq. `text` is post-extractFollowups (stripped), which is why `suggestions` is its own column. Editing a message rewinds by deleting seq >= n.';
