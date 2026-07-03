-- Being added to a new DM/squad only showed up after a manual reload —
-- chat_members was never added to the Realtime publication, so there was no
-- live signal to refresh the room list when someone added you to a chat.
alter publication supabase_realtime add table public.chat_members;
