-- A petition signature taken at a SITE (a table at a market, a library step)
-- rather than at a door.
--
-- It is a knock_logs row, so it counts everywhere a signature already counts
-- (campaign progress, leaders, the feed) with nothing downstream to change,
-- and it carries `site_id`, which is what makes it its own category: a row
-- with a site is somebody working a site, not somebody at a door. The row
-- still names the signer's registered household, same as a signature taken
-- anywhere else, so that door stops being asked.
--
-- Registration campaigns keep registration_logs for their site work; this
-- column is the petition side of the same idea, pointing at the same table.

alter table public.knock_logs
  add column if not exists site_id uuid references public.sites(id) on delete set null;

create index if not exists knock_logs_site_idx
  on public.knock_logs (site_id, occurred_at desc) where site_id is not null;
