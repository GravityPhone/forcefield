-- Squad leaders manage squads, not just their own (2026-07-28, user ask:
-- "a manager or a squad leader can add and remove people from squads", and
-- "campaign managers and squad leaders need to be able to create and edit
-- squads"). Three changes:
--
--   1. add_squad_member / remove_squad_member drop the "team_lead must be ON
--      the squad" membership test — a squad leader may now place people on
--      and off ANY of today's crews (the roster's Manage sheet is where that
--      happens in practice).
--   2. What does NOT widen: the dispatch power. Only a manager moves somebody
--      who is already out with another crew in one step; a squad leader still
--      gets "Already out with X today" and takes them off that crew first, so
--      a move stays a deliberate act.
--   3. rename_squad — the "edit" half. Its own narrow RPC for the same reason
--      set_squad_member_claim is one: the squads UPDATE policy is
--      creator-or-admin, and widening it would hand out chat_id and the rest
--      of the row. The squad chat was created carrying the squad's name, so a
--      rename follows through to the room.

-- --- Adding -----------------------------------------------------------------

create or replace function public.add_squad_member(target_squad_id uuid, member_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  squad public.squads%rowtype;
  is_manager boolean;
  may_manage boolean;
  other record;
begin
  select * into squad from public.squads where id = target_squad_id;
  if not found then
    raise exception 'Squad not found';
  end if;
  if not exists (select 1 from public.profiles where id = member_id) then
    raise exception 'No such person';
  end if;

  -- auth.uid() is null in the SQL editor / service contexts — trusted, same
  -- as every guard since init_auth_roles.
  is_manager := uid is null or public.my_role() in ('campaign_manager', 'admin');
  may_manage :=
    is_manager
    or squad.created_by = uid
    or public.my_role() = 'team_lead';

  if not may_manage then
    raise exception 'Only a squad leader (or whoever started this crew) can add people to it';
  end if;

  -- Anyone else's crew, on this squad's own day (squads are day-scoped, and
  -- yesterday's rosters are history — they must not block today).
  for other in
    select s.id as squad_id, s.name, s.chat_id
    from public.squad_members sm
    join public.squads s on s.id = sm.squad_id
    where sm.user_id = member_id
      and s.squad_date = squad.squad_date
      and s.id <> target_squad_id
  loop
    if not is_manager then
      raise exception 'Already out with % today', other.name;
    end if;
    delete from public.squad_members where squad_id = other.squad_id and user_id = member_id;
    if other.chat_id is not null then
      delete from public.chat_members where chat_id = other.chat_id and user_id = member_id;
    end if;
  end loop;

  insert into public.squad_members (squad_id, user_id)
    values (target_squad_id, member_id) on conflict do nothing;
  if squad.chat_id is not null then
    insert into public.chat_members (chat_id, user_id, added_by)
      values (squad.chat_id, member_id, coalesce(uid, squad.created_by)) on conflict do nothing;
  end if;
end;
$$;

grant execute on function public.add_squad_member(uuid, uuid) to authenticated;

-- --- Taking back off --------------------------------------------------------

create or replace function public.remove_squad_member(target_squad_id uuid, member_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  squad public.squads%rowtype;
  may_manage boolean;
begin
  select * into squad from public.squads where id = target_squad_id;
  if not found then
    raise exception 'Squad not found';
  end if;

  may_manage :=
    uid is null
    or member_id = uid
    or public.my_role() in ('campaign_manager', 'admin', 'team_lead')
    or squad.created_by = uid;

  if not may_manage then
    raise exception 'Only a squad leader (or whoever started this crew) can take people off it';
  end if;

  delete from public.squad_members where squad_id = target_squad_id and user_id = member_id;
  if squad.chat_id is not null then
    delete from public.chat_members where chat_id = squad.chat_id and user_id = member_id;
  end if;
end;
$$;

grant execute on function public.remove_squad_member(uuid, uuid) to authenticated;

-- --- Renaming ---------------------------------------------------------------

create or replace function public.rename_squad(target_squad_id uuid, new_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  squad public.squads%rowtype;
  trimmed text := trim(new_name);
  may_manage boolean;
begin
  select * into squad from public.squads where id = target_squad_id;
  if not found then
    raise exception 'Squad not found';
  end if;
  if trimmed is null or trimmed = '' then
    raise exception 'Squad needs a name';
  end if;
  if char_length(trimmed) > 80 then
    raise exception 'Squad names run up to 80 characters';
  end if;

  may_manage :=
    uid is null
    or public.my_role() in ('campaign_manager', 'admin', 'team_lead')
    or squad.created_by = uid;

  if not may_manage then
    raise exception 'Only a squad leader or manager can rename a crew';
  end if;

  update public.squads set name = trimmed where id = target_squad_id;
  if squad.chat_id is not null then
    update public.chats set name = trimmed where id = squad.chat_id;
  end if;
end;
$$;

grant execute on function public.rename_squad(uuid, text) to authenticated;
