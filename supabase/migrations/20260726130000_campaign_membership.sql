-- Campaign membership: you JOIN a campaign, and you can be in more than one.
--
-- Until now "which campaign am I working" was DERIVED — profiles.team_id →
-- teams.campaign_id — so nobody ever chose one, and nobody could be in two.
-- New accounts land on a chooser they can't get past without picking (the
-- client gates every route on it), and canvassers/squad leaders join more
-- campaigns from /campaign and switch between them there.
--
-- Two pieces:
--   campaign_members       every campaign you belong to
--   profiles.campaign_id   the ONE you're working right now ("active")
--
-- The team link is untouched: a team still belongs to a campaign, and
-- rosters/chats still scope by team. Membership sits on top of that, which is
-- what makes joining a second campaign possible without moving anyone between
-- teams. Nothing else in the app is campaign-scoped (doors, turf, squads and
-- knocks are all org-wide), so switching changes what the Campaign screen
-- reports, not what you can knock.

-- ============================================================
-- Active campaign on the profile. Null = hasn't chosen yet, which is exactly
-- what the client's join-campaign gate keys off — so this column staying
-- nullable is load-bearing, not laziness.
-- ============================================================

alter table public.profiles
  add column if not exists campaign_id uuid references public.campaigns (id) on delete set null;

create index if not exists profiles_campaign_idx on public.profiles (campaign_id);

comment on column public.profiles.campaign_id is
  'The campaign this member is currently working. Must be one they have joined (see campaign_members). Null = they have not chosen yet; the app sends them to the chooser. Always null for admins.';

-- ============================================================
-- campaign_members — org-readable like squad rosters (who else is on this
-- campaign is a fair question), self-service to join.
-- ============================================================

create table if not exists public.campaign_members (
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

create index if not exists campaign_members_user_idx on public.campaign_members (user_id);

alter table public.campaign_members enable row level security;

-- (drop-if-exists on each: this migration is applied by hand through the
-- Management API, so a half-applied run has to be safe to re-run.)
drop policy if exists "campaign rosters are readable by authenticated users" on public.campaign_members;
create policy "campaign rosters are readable by authenticated users"
  on public.campaign_members for select to authenticated using (true);

-- Joining yourself is open — that's the whole feature — but only to a
-- campaign that is still running. Admins (and campaign managers, via
-- is_admin()) may place other people.
drop policy if exists "users join campaigns, managers place people" on public.campaign_members;
create policy "users join campaigns, managers place people"
  on public.campaign_members for insert to authenticated
  with check (
    public.is_admin()
    or (
      user_id = auth.uid()
      and exists (
        select 1 from public.campaigns c
        where c.id = campaign_members.campaign_id and c.is_active
      )
    )
  );

drop policy if exists "users leave campaigns, managers remove people" on public.campaign_members;
create policy "users leave campaigns, managers remove people"
  on public.campaign_members for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ============================================================
-- Guard: the full function from 20260714120000 (role/team/username lanes and
-- the demo role swap, all unchanged) plus two campaign rules —
--   * your active campaign must be one you actually belong to, so
--     profiles.campaign_id and campaign_members can never drift apart
--   * admins belong to no campaign, mirroring the team rule that's been
--     there since 20260705170000
-- ============================================================

create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  if (new.role is distinct from old.role
      or new.team_id is distinct from old.team_id
      or new.username is distinct from old.username) then
    if auth.uid() is not null and not public.is_super_admin() then
      -- Demo lane: demo_set_own_role() flags the transaction; only a pure
      -- role move between non-admin roles on your own row fits through.
      if coalesce(current_setting('forcefield.demo_role_swap', true), '') = 'on'
         and old.id = auth.uid()
         and old.role <> 'admin'
         and new.role in ('canvasser', 'team_lead', 'campaign_manager')
         and new.team_id is not distinct from old.team_id
         and new.username is not distinct from old.username then
        null; -- allowed
      -- Campaign managers get a narrow lane: change the role/team of a
      -- non-admin, never to or from admin, and never touch the username.
      elsif not (public.is_admin()
              and old.role <> 'admin'
              and new.role <> 'admin'
              and new.username is not distinct from old.username) then
        raise exception 'Only admins can change roles, teams, or usernames';
      end if;
    end if;
  end if;

  -- Active campaign must be a joined campaign. (auth.uid() is null in the SQL
  -- editor / service contexts — those are trusted, same as every other lane
  -- here.) The RPCs below insert the membership row first, so they pass.
  if new.campaign_id is distinct from old.campaign_id
     and new.campaign_id is not null
     and auth.uid() is not null then
    if not exists (
      select 1 from public.campaign_members cm
      where cm.campaign_id = new.campaign_id and cm.user_id = new.id
    ) then
      raise exception 'Join that campaign before making it your active one';
    end if;
  end if;

  -- Admins never belong to a team or a campaign.
  if new.role = 'admin' then
    new.team_id := null;
    new.campaign_id := null;
  end if;
  return new;
end;
$$;

-- ============================================================
-- Join / switch. Two RPCs rather than letting the client write both rows,
-- for the same reason join_squad exists: the roster row and the "where am I
-- now" pointer have to move together or the app lies about one of them.
-- ============================================================

-- Join a campaign and make it the active one. Idempotent — calling it for a
-- campaign you're already in just switches you back to it.
create or replace function public.join_campaign(target_campaign_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  running boolean;
  role_v public.app_role;
begin
  if uid is null then
    raise exception 'Must be signed in to join a campaign';
  end if;

  select is_active into running from public.campaigns where id = target_campaign_id;
  if not found then
    raise exception 'That campaign no longer exists';
  end if;
  if not running then
    raise exception 'That campaign is closed';
  end if;

  select role into role_v from public.profiles where id = uid;
  if role_v = 'admin' then
    raise exception 'Admin accounts run the server, not a campaign';
  end if;

  insert into public.campaign_members (campaign_id, user_id)
    values (target_campaign_id, uid)
    on conflict do nothing;
  update public.profiles set campaign_id = target_campaign_id where id = uid;
end;
$$;

-- Switch to a campaign already joined. Deliberately NOT a silent join: a
-- stale client switching to something you left should say so.
create or replace function public.set_active_campaign(target_campaign_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Must be signed in';
  end if;
  if not exists (
    select 1 from public.campaign_members cm
    where cm.campaign_id = target_campaign_id and cm.user_id = uid
  ) then
    raise exception 'You have not joined that campaign';
  end if;
  update public.profiles set campaign_id = target_campaign_id where id = uid;
end;
$$;

revoke all on function public.join_campaign(uuid) from public;
revoke all on function public.set_active_campaign(uuid) from public;
grant execute on function public.join_campaign(uuid) to authenticated;
grant execute on function public.set_active_campaign(uuid) to authenticated;

-- ============================================================
-- Backfill: everybody already working keeps working. Anyone on a team that
-- has a campaign is a member of it, and it's their active one — without this
-- the gate would bounce the entire existing org (59 sim accounts included)
-- to a chooser on next login.
-- ============================================================

insert into public.campaign_members (campaign_id, user_id)
select t.campaign_id, p.id
from public.profiles p
join public.teams t on t.id = p.team_id
where p.role <> 'admin' and t.campaign_id is not null
on conflict do nothing;

update public.profiles p
set campaign_id = t.campaign_id
from public.teams t
where t.id = p.team_id
  and p.role <> 'admin'
  and p.campaign_id is null
  and t.campaign_id is not null;

-- ============================================================
-- Stats follow the active campaign. Membership is direct now, so a knock
-- attributes through the canvasser's own campaign_id, falling back to the old
-- team link for anyone who somehow has no active campaign (a profile whose
-- campaign was deleted, an account mid-chooser). Return shape is unchanged.
-- ============================================================

create or replace function public.get_campaign_stats(cid uuid default null)
returns table (
  campaign_id uuid,
  campaign_name text,
  doors bigint,
  signatures bigint,
  doors_7d bigint,
  signatures_7d bigint,
  canvassers bigint,
  signature_goal integer
)
language sql stable security definer set search_path = public
as $$
  with target as (
    select case
      -- Only org admins get to pick a campaign; everyone else always reads
      -- the one they're actively working, whatever they pass.
      when cid is not null and public.is_super_admin() then cid
      else coalesce(
        (select p.campaign_id from public.profiles p where p.id = auth.uid()),
        (select t.campaign_id from public.teams t where t.id = public.my_team_id())
      )
    end as id
  )
  select
    c.id,
    c.name,
    count(k.id),
    count(k.id) filter (where k.outcome = 'signed'),
    count(k.id) filter (where k.occurred_at > now() - interval '7 days'),
    count(k.id) filter (where k.outcome = 'signed' and k.occurred_at > now() - interval '7 days'),
    count(distinct k.canvasser_id),
    c.signature_goal
  from public.campaigns c
  join target on target.id = c.id
  -- One row per profile whichever way they belong, so the OR can't double
  -- count: their own active campaign, or (having none) their team's.
  left join public.profiles p
    on p.campaign_id = c.id
    or (p.campaign_id is null
        and p.team_id in (select t.id from public.teams t where t.campaign_id = c.id))
  left join public.knock_logs k on k.canvasser_id = p.id
  group by c.id, c.name, c.signature_goal
$$;

revoke all on function public.get_campaign_stats(uuid) from public;
grant execute on function public.get_campaign_stats(uuid) to authenticated;
