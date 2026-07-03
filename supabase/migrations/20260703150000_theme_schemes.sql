-- Color scheme feature: profiles.theme moves from the never-implemented
-- {mode, accent} shape to a single named scheme id, e.g. {"scheme": "dark"}.
-- The frontend (src/lib/themes.ts) owns the actual token definitions;
-- this column just remembers which one each account picked.
alter table public.profiles alter column theme set default '{"scheme": "light"}'::jsonb;

update public.profiles
  set theme = '{"scheme": "light"}'::jsonb
  where theme is null or not (theme ? 'scheme');
