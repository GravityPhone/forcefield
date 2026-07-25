-- Squad leaders can hand door-claiming to the crew (2026-07-24).
--
-- Splitting a squad's turf is normally the squad leader's job (team_lead
-- sub-cuts) or a campaign manager's. 20260706160000 opened one escape hatch:
-- a squad with NO ranked member lets any member sub-cut, so a leaderless crew
-- isn't stuck all knocking the same street.
--
-- The field asked for a second one. Days go chaotic — the lead is three
-- streets away, or just wants people picking their own stretch instead of
-- waiting on them. So a squad now carries a `member_claim` switch: flip it on
-- and every member of that squad may sub-cut inside the squad's turf, ranked
-- members present or not. Default OFF — the leader does the dividing until
-- they say otherwise, and the switch dies with the squad at midnight like
-- everything else about a day crew.
--
-- Deliberately NOT a per-person permission: the unit that goes out together
-- is the squad, and the leader is deciding how THIS day runs.

alter table public.squads
  add column if not exists member_claim boolean not null default false;

comment on column public.squads.member_claim is
  'Squad leader deferred door-claiming to the crew: any member may sub-cut this squad''s turf (see can_member_subcut). Resets with the squad at midnight.';

-- --- can_member_subcut: honor the switch -----------------------------------
-- Same shape as 20260706160000, with the "nobody outranks a canvasser" test
-- becoming one of TWO ways in. Still security definer so the turfs policies
-- can call it without recursing, and so it can read profiles.role past RLS.

create or replace function public.can_member_subcut(parent uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.turfs p
    join public.squads sq on sq.id = p.squad_id
    where p.id = parent
      and p.parent_turf_id is null
      and p.squad_id is not null
      -- caller is on the squad this turf is assigned to
      and exists (
        select 1 from public.squad_members sm
        where sm.squad_id = p.squad_id and sm.user_id = auth.uid()
      )
      and (
        -- the leader handed claiming to the crew for the day...
        sq.member_claim
        -- ...or there's no leader on this crew to do the dividing at all.
        or not exists (
          select 1 from public.squad_members sm2
          join public.profiles pr on pr.id = sm2.user_id
          where sm2.squad_id = p.squad_id
            and pr.role in ('team_lead', 'campaign_manager', 'admin')
        )
      )
  );
$$;

grant execute on function public.can_member_subcut(uuid) to authenticated;

-- --- Flipping the switch ---------------------------------------------------
-- The squads UPDATE policy is creator-or-admin, and widening it would hand
-- every squad member the name and chat_id too. So the switch gets its own
-- narrow RPC: a squad leader / campaign manager / admin (on the squad, or
-- ranked highly enough to run it from outside), or the crew's creator.

create or replace function public.set_squad_member_claim(target_squad_id uuid, allow boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  ok boolean;
begin
  -- auth.uid() is null in the SQL editor / service contexts — trusted, same
  -- as every guard since init_auth_roles.
  select
    auth.uid() is null
    or public.my_role() in ('campaign_manager', 'admin')
    or exists (select 1 from public.squads s where s.id = target_squad_id and s.created_by = auth.uid())
    or (
      public.my_role() = 'team_lead'
      and exists (
        select 1 from public.squad_members sm
        where sm.squad_id = target_squad_id and sm.user_id = auth.uid()
      )
    )
  into ok;

  if not ok then
    raise exception 'Only a squad leader (or the crew that started this squad) can hand out door claiming';
  end if;

  update public.squads set member_claim = allow where id = target_squad_id;
  if not found then
    raise exception 'Squad not found';
  end if;

  return allow;
end;
$$;

grant execute on function public.set_squad_member_claim(uuid, boolean) to authenticated;
