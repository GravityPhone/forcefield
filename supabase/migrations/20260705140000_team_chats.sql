-- Team chats: every team gets a standing chat room its members are
-- automatically in (no chat_members rows — membership IS profiles.team_id,
-- mirroring how the global room works). Also: everyone currently in the app
-- goes on the "UBI" team, and new signups land there by default.
--
-- Like the other chat tables, nothing here is granted to ai_readonly.

-- --- Allow the new kind and tie a chat to a team (at most one per team).
alter table public.chats drop constraint chats_kind_check;
alter table public.chats add constraint chats_kind_check
  check (kind in ('global', 'squad', 'dm', 'team'));
alter table public.chats add column team_id uuid references public.teams (id) on delete cascade;
create unique index chats_one_per_team_idx on public.chats (team_id) where team_id is not null;

-- --- The UBI team, with everybody on it.
insert into public.teams (name) values ('UBI') on conflict (name) do nothing;
update public.profiles set team_id = (select id from public.teams where name = 'UBI');

-- New signups default onto UBI (admins can reassign later).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, team_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    (select id from public.teams where name = 'UBI')
  );
  return new;
end;
$$;

-- --- One chat per team: backfill existing teams, trigger for future ones.
insert into public.chats (kind, name, team_id)
select 'team', t.name, t.id
from public.teams t
where not exists (select 1 from public.chats c where c.team_id = t.id);

create or replace function public.handle_new_team()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.chats (kind, name, team_id) values ('team', new.name, new.id);
  return new;
end;
$$;

create trigger on_team_created
  after insert on public.teams
  for each row execute function public.handle_new_team();

-- --- Access: your team's chat (admins see all team chats). Security definer
-- like the other chat helpers so policies don't recurse.
create or replace function public.is_team_chat_member(cid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.chats c
    where c.id = cid
      and c.kind = 'team'
      and (c.team_id = public.my_team_id() or public.is_admin())
  );
$$;

-- Permissive policies OR together with the existing global/squad/dm ones.
create policy "team chats visible to their team"
  on public.chats for select to authenticated
  using (public.is_team_chat_member(id));
create policy "team members read team messages"
  on public.chat_messages for select to authenticated
  using (public.is_team_chat_member(chat_id));
create policy "team members send team messages"
  on public.chat_messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_team_chat_member(chat_id));
create policy "team members see team reactions"
  on public.message_reactions for select to authenticated
  using (public.is_team_chat_member(chat_id));
create policy "team members react in team chats"
  on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.is_team_chat_member(chat_id));

-- Unread counts now cover team chats too.
create or replace function public.get_unread_counts()
returns table (chat_id uuid, unread bigint)
language sql stable security definer set search_path = public
as $$
  select c.id, count(m.id)
  from public.chats c
  join public.chat_messages m on m.chat_id = c.id
  left join public.chat_reads r on r.chat_id = c.id and r.user_id = auth.uid()
  where (c.kind = 'global' or public.is_chat_member(c.id) or public.is_team_chat_member(c.id))
    and m.sender_id <> auth.uid()
    and m.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz)
  group by c.id
$$;
