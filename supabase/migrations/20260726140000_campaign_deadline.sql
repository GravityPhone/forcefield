-- Campaign deadline: the date the signatures have to be filed by.
--
-- `signature_goal` has been on the progress card since 20260722100000, but a
-- goal with no date is just a big number — it can't tell anyone the pace they
-- need, and a bar creeping rightward never says whether the campaign is
-- actually winning. A petition lives or dies by a filing date, so the date is
-- what turns the goal into a rate.
--
-- Nullable, exactly like signature_goal: a campaign without a deadline shows
-- totals and a bar, no pace line. Deliberately a `date` and not a timestamp —
-- the filing office closes on a day, nobody is counting the hour, and a plain
-- date can't drift across a timezone the way a timestamptz would.
--
-- NOT surfaced through get_campaign_stats. That function is owned by the
-- campaign-membership work (20260726130000) and recreating it here would fork
-- a stale copy of its body; the client reads this column off the campaigns
-- row instead, keyed by the campaign_id the RPC already returns.

alter table public.campaigns
  add column if not exists deadline date;

comment on column public.campaigns.deadline is
  'Filing deadline: the last day signatures can be turned in. Drives the pace math on the progress card, the leaderboard and the activity feed. Null = no deadline set, and no pace shown.';

-- The demo campaign's date, matching the "Filing deadline: September 12"
-- example already sitting in CAMPAIGN_FACTS (src/lib/campaignContent.ts) — the
-- Campaign page would read as self-contradictory otherwise. Like every other
-- number in this demo it's made up, not anyone's real filing date.
update public.campaigns
  set deadline = date '2026-09-12'
  where name = 'UBI' and deadline is null;
