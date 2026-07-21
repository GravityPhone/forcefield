-- Team activity feed (2026-07-20): a live org-wide feed of knocks and
-- signatures with gamification milestones (personal / squad / whole-team
-- "way to go" moments). The feed itself is computed CLIENT-side from
-- knock_logs — which already carries squad_id/squad_name stamps — so this
-- table is only the campaign manager's knobs: what shows in the feed and
-- where the milestone lines fall.
--
-- Single-row settings table; the boolean PK with a CHECK makes a second row
-- impossible (same singleton pattern as leaderboard_settings).

create table public.activity_feed_settings (
  id boolean primary key default true check (id),
  -- Per-event rows in the feed. Signatures are the headline; knocks are the
  -- volume — a manager can mute the latter and keep milestones.
  show_knocks boolean not null default true,
  show_signatures boolean not null default true,
  -- "Alice hit 15 doors today" — every N distinct doors per canvasser.
  person_milestones boolean not null default true,
  person_door_step int not null default 5 check (person_door_step >= 1),
  -- "Richwood crew is cooking — 100 doors today" — per squad-of-the-day,
  -- doors and signatures separately stepped.
  squad_milestones boolean not null default true,
  squad_door_step int not null default 25 check (squad_door_step >= 1),
  squad_signature_step int not null default 10 check (squad_signature_step >= 1),
  -- Whole-team milestones across everyone out today.
  team_milestones boolean not null default true,
  team_door_step int not null default 100 check (team_door_step >= 1),
  team_signature_step int not null default 25 check (team_signature_step >= 1),
  updated_at timestamptz not null default now()
);

insert into public.activity_feed_settings default values;

alter table public.activity_feed_settings enable row level security;

-- Everyone reads (each client renders the feed per these knobs); campaign
-- managers and admins write (is_admin() covers both — historical name).
create policy "feed settings are readable by authenticated users"
  on public.activity_feed_settings for select to authenticated using (true);
create policy "managers update feed settings"
  on public.activity_feed_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
