-- Bug fix: creating a DM via `insert(...).select().single()` (INSERT ...
-- RETURNING) failed with "new row violates row-level security policy" even
-- though the WITH CHECK on the insert itself passed. Reason: Postgres also
-- gates the RETURNING row against the table's SELECT policy, and a brand-new
-- DM has no chat_members row yet — that's inserted in a separate step right
-- after the chat itself. Squads worked fine (unconditionally visible), but
-- DMs require is_chat_member(id), which is false at that exact instant.
--
-- Fix: the creator can always see a chat they just created, independent of
-- whether their membership row exists yet. This is also the semantically
-- correct behavior on its own — a creator should never lose access to a
-- chat they made.
drop policy "global and squad chats are visible, dms to members" on public.chats;
create policy "chats are visible to global/squad, members, or the creator"
  on public.chats for select to authenticated
  using (
    kind in ('global', 'squad')
    or public.is_chat_member(id)
    or created_by = auth.uid()
  );
