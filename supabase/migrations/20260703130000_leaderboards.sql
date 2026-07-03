-- Leaderboards (spec 5.5 / 8): per-canvasser and per-team standings over
-- knock_logs, with an admin-configurable ranking metric. "Doors knocked"
-- counts every logged knock (not distinct households — walk-ups with no
-- address still count as work done); "signatures" counts outcome = 'signed'.

-- Single-row settings table; the boolean PK with a CHECK makes a second row
-- impossible, so the client can always upsert/select id = true.
create table public.leaderboard_settings (
  id boolean primary key default true check (id),
  primary_metric text not null default 'signatures'
    check (primary_metric in ('signatures', 'doors')),
  doors_board_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.leaderboard_settings default values;

alter table public.leaderboard_settings enable row level security;

create policy "leaderboard settings are readable by authenticated users"
  on public.leaderboard_settings for select to authenticated using (true);
create policy "admins update leaderboard settings"
  on public.leaderboard_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Aggregates run under the caller's RLS (knock_logs/profiles/teams are all
-- SELECT-open to authenticated users, so plain views suffice — no definer).
create view public.canvasser_leaderboard
  with (security_invoker = true) as
  select
    p.id as canvasser_id,
    p.username,
    p.display_name,
    p.team_id,
    t.name as team_name,
    count(k.id) as doors_knocked,
    count(k.id) filter (where k.outcome = 'signed') as signatures
  from public.profiles p
  left join public.teams t on t.id = p.team_id
  left join public.knock_logs k on k.canvasser_id = p.id
  group by p.id, p.username, p.display_name, p.team_id, t.name;

create view public.team_leaderboard
  with (security_invoker = true) as
  select
    t.id as team_id,
    t.name as team_name,
    count(distinct p.id) as member_count,
    count(k.id) as doors_knocked,
    count(k.id) filter (where k.outcome = 'signed') as signatures
  from public.teams t
  left join public.profiles p on p.team_id = t.id
  left join public.knock_logs k on k.canvasser_id = p.id
  group by t.id, t.name;

-- Spec wants leaderboards updating in real time; new knocks are the only
-- thing that moves them. (postgres_changes respects RLS; select is open.)
alter publication supabase_realtime add table public.knock_logs;
