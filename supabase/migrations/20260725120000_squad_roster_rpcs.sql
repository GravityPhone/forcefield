-- Putting somebody ELSE on a crew (2026-07-25, two user asks in one).
--
--   1. A campaign manager assigns people to squads from the Squad page.
--   2. A squad leader adds someone to their own crew — "that is if they are
--      not currently in one".
--
-- The squad_members INSERT policy has allowed any member of a squad to add
-- anyone since 20260704120000, so the table was never the obstacle. The
-- problem is that writing that row directly leaves the person out of the
-- squad CHAT: join_squad is the only path that keeps both rosters in sync,
-- and it only ever adds the caller. These two RPCs are join_squad and
-- leave_squad for somebody else, with the gate the asks describe.
--
-- The difference between the two roles is what happens when the person is
-- already out with another crew today. A manager DISPATCHES — they move the
-- person, off the old crew and its chat, onto this one. A squad leader is
-- running one crew, not the day, so for them an already-out person is simply
-- not available; the exception names who has them.

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
    or (
      public.my_role() = 'team_lead'
      and exists (
        select 1 from public.squad_members sm
        where sm.squad_id = target_squad_id and sm.user_id = uid
      )
    );

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
-- The undo for the above, and the same gate: whoever can put someone on a
-- crew can take them off it again. (The squad_members DELETE policy already
-- lets managers do this straight against the table — going through here is
-- what also clears them out of the squad chat.) Removing yourself is
-- leave_squad's job and is allowed here too, so the caller never has to pick
-- between two RPCs.

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
    or public.my_role() in ('campaign_manager', 'admin')
    or squad.created_by = uid
    or (
      public.my_role() = 'team_lead'
      and exists (
        select 1 from public.squad_members sm
        where sm.squad_id = target_squad_id and sm.user_id = uid
      )
    );

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
