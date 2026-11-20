-- "Inaccessible" (2026-11-19): the canvasser could not reach the door at all.
-- A locked building, a gated street, a dog in the yard.
--
-- It is a FLAG on a skip, not a seventh outcome. Everything that reasons
-- about a door (the status views, the walk's closed set, the three reds on
-- the map, analytics) already treats a skip as "this door is done for now",
-- which is exactly what an unreachable door is. Widening the outcome enum
-- would mean teaching every one of those a new value to say the same thing.
-- The flag only changes what the knock is CALLED.
alter table public.knock_logs
  add column inaccessible boolean not null default false;
