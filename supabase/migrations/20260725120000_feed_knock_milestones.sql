-- Knock-count milestones, and 0 as the universal "off" (2026-07-25, user
-- call: "under personal milestones you should be able to put every X number
-- of knocks, and same thing for squad… but you can set it to zero in order
-- to disable that").
--
-- Two new steps. Doors and knocks are genuinely different achievements: doors
-- counts DISTINCT households (the feed's squad-progress semantics), knocks
-- counts every attempt, so a canvasser working a hard street with nobody home
-- can still see the day moving.
--
-- Default 0 on both — a new step that silently started firing on every
-- existing deployment's feed would be a surprise, not a feature.
alter table public.activity_feed_settings
  add column if not exists person_knock_step int not null default 0,
  add column if not exists squad_knock_step int not null default 0;

-- Every step column now treats 0 as "this milestone is off", so the >= 1
-- floors have to become >= 0. Constraint names are Postgres-generated, so
-- drop by lookup rather than by guessing them.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'activity_feed_settings'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%_step%'
  loop
    execute format('alter table public.activity_feed_settings drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.activity_feed_settings
  add constraint activity_feed_settings_steps_nonneg check (
    person_door_step >= 0
    and person_knock_step >= 0
    and squad_door_step >= 0
    and squad_knock_step >= 0
    and squad_signature_step >= 0
    and team_door_step >= 0
    and team_signature_step >= 0
  );
