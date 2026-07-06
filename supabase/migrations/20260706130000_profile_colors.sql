-- Per-member accent color, picked on /appearance next to the avatar. Shown
-- on the Squad page: member cards and the avatar marker on the squad map.
-- Null = no pick yet; the client falls back to a deterministic palette color
-- so every card/marker still gets a stable hue.
alter table public.profiles
  add column color text
  check (color is null or color ~ '^#[0-9a-fA-F]{6}$');
