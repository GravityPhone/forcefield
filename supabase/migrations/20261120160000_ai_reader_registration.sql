-- The assistant can read the registration drive's own tables.
--
-- ai_reader holds an explicit allow-list (20260713120000), so a new table is
-- unreachable until it is added here on purpose. These four are the site plan
-- and its tallies: places, shifts, who is on a shift, and one row per result
-- logged. Nothing in them describes a registrant beyond a pointer to a
-- voter-file row that the assistant can already read.

grant select on public.sites, public.site_shifts, public.site_shift_members, public.registration_logs to ai_reader;
