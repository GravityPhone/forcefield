-- Unread tracking was comparing two device-clock timestamps: the client
-- stamped both chat_messages.created_at and chat_reads.last_read_at with
-- its own clock. Any skew between devices (or between a device and the
-- server) could date a message in the future or a read-mark in the past,
-- leaving rooms stuck "unread" after they'd been read. Fix: the server
-- clock stamps reads via this RPC (and clients stop sending created_at on
-- message inserts — the column default now() takes over).
create or replace function public.mark_chat_read(cid uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into public.chat_reads (chat_id, user_id, last_read_at)
  values (cid, auth.uid(), now())
  on conflict (chat_id, user_id) do update set last_read_at = now();
end;
$$;

revoke all on function public.mark_chat_read(uuid) from public;
grant execute on function public.mark_chat_read(uuid) to authenticated;

-- Repair any already-stuck rows: a read-mark older than the newest message
-- in its chat may be legitimate skew damage; rooms will self-heal on next
-- open, and historical messages shouldn't nag people who were active before
-- read-tracking existed (2026-07-05) — so baseline everyone to "read now".
update public.chat_reads set last_read_at = now();
