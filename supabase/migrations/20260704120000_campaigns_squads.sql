-- Campaigns and squads: the org hierarchy becomes campaign → team → squad.
--
-- Campaigns are the long-lived efforts (e.g. "UBI") that teams are assigned
-- to. Squads are day crews: any user can spin one up, it gets its own squad
-- chat automatically, and it expires at midnight — the app only ever shows
-- squads whose squad_date is today, so "resetting" them needs no cron job.

-- ============================================================
-- Campaigns
-- ============================================================

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 120),
  description text,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.teams
  add column campaign_id uuid references public.campaigns (id) on delete set null;

alter table public.campaigns enable row level security;

create policy "campaigns are readable by authenticated users"
  on public.campaigns for select to authenticated using (true);
create policy "admins create campaigns"
  on public.campaigns for insert to authenticated with check (public.is_admin());
create policy "admins update campaigns"
  on public.campaigns for update to authenticated using (public.is_admin());
create policy "admins delete campaigns"
  on public.campaigns for delete to authenticated using (public.is_admin());

-- ============================================================
-- Squads: day crews with an auto-created squad chat.
-- squad_date scopes a squad to one workday; clients filter to today.
-- ============================================================

create table public.squads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  chat_id uuid references public.chats (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  squad_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table public.squad_members (
  squad_id uuid not null references public.squads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (squad_id, user_id)
);

create index squads_date_idx on public.squads (squad_date);
create index squad_members_user_idx on public.squad_members (user_id);

alter table public.squads enable row level security;
alter table public.squad_members enable row level security;

-- Squads and their rosters are open — the whole point is that teammates can
-- see who's out crewing together today and join in.
create policy "squads are readable by authenticated users"
  on public.squads for select to authenticated using (true);
create policy "users create squads"
  on public.squads for insert to authenticated with check (created_by = auth.uid());
create policy "creators and admins update squads"
  on public.squads for update to authenticated
  using (created_by = auth.uid() or public.is_admin());
create policy "creators and admins delete squads"
  on public.squads for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

create policy "squad rosters are readable by authenticated users"
  on public.squad_members for select to authenticated using (true);
create policy "users join squads, members and admins add people"
  on public.squad_members for insert to authenticated
  with check (
    user_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.squad_members sm
      where sm.squad_id = squad_members.squad_id and sm.user_id = auth.uid()
    )
  );
create policy "users leave squads, admins remove anyone"
  on public.squad_members for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ============================================================
-- RPCs that keep the squad roster and its chat roster in sync — joining a
-- squad must also land you in the squad chat, and creating one must create
-- the chat. Security definer so the pair of inserts is atomic under one
-- set of rules instead of two RLS dances on the client.
-- ============================================================

create or replace function public.create_squad(
  squad_name text,
  member_ids uuid[] default '{}',
  squad_day date default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  trimmed text := trim(squad_name);
  new_chat_id uuid;
  new_squad_id uuid;
  mid uuid;
begin
  if uid is null then
    raise exception 'Must be signed in to create a squad';
  end if;
  if trimmed is null or trimmed = '' then
    raise exception 'Squad needs a name';
  end if;

  insert into public.chats (kind, name, created_by)
    values ('squad', trimmed, uid) returning id into new_chat_id;
  insert into public.squads (name, chat_id, created_by, squad_date)
    values (trimmed, new_chat_id, uid, coalesce(squad_day, current_date))
    returning id into new_squad_id;

  insert into public.squad_members (squad_id, user_id) values (new_squad_id, uid);
  insert into public.chat_members (chat_id, user_id, added_by) values (new_chat_id, uid, uid);

  foreach mid in array coalesce(member_ids, '{}') loop
    if mid <> uid then
      insert into public.squad_members (squad_id, user_id)
        values (new_squad_id, mid) on conflict do nothing;
      insert into public.chat_members (chat_id, user_id, added_by)
        values (new_chat_id, mid, uid) on conflict do nothing;
    end if;
  end loop;

  return new_squad_id;
end;
$$;

create or replace function public.join_squad(target_squad_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  squad_chat_id uuid;
begin
  if uid is null then
    raise exception 'Must be signed in to join a squad';
  end if;
  select chat_id into squad_chat_id from public.squads where id = target_squad_id;
  if not found then
    raise exception 'Squad not found';
  end if;

  insert into public.squad_members (squad_id, user_id)
    values (target_squad_id, uid) on conflict do nothing;
  if squad_chat_id is not null then
    insert into public.chat_members (chat_id, user_id, added_by)
      values (squad_chat_id, uid, uid) on conflict do nothing;
  end if;
end;
$$;

create or replace function public.leave_squad(target_squad_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  squad_chat_id uuid;
begin
  if uid is null then
    raise exception 'Must be signed in';
  end if;
  select chat_id into squad_chat_id from public.squads where id = target_squad_id;
  delete from public.squad_members where squad_id = target_squad_id and user_id = uid;
  if squad_chat_id is not null then
    delete from public.chat_members where chat_id = squad_chat_id and user_id = uid;
  end if;
end;
$$;

-- Live roster updates for the Squads page (postgres_changes respects RLS).
alter publication supabase_realtime add table public.squad_members;

-- ============================================================
-- Seed: the campaign the demo org is already working (the chat composer
-- copy has referenced "your campaign (UBI)" since Stage 2). Existing teams
-- get assigned to it so nothing is left dangling.
-- ============================================================

insert into public.campaigns (name, description)
  values ('UBI', 'Universal Basic Income ballot initiative');

update public.teams
  set campaign_id = (select id from public.campaigns where name = 'UBI')
  where campaign_id is null;
