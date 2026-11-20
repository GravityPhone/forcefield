-- Linked Google Sheets for the site plan (2026-11-19).
--
-- A manager pastes the link to a sheet shared as "Anyone with the link", the
-- app reads it (POST /api/sheet), and the shifts it holds land on the plan.
-- This table is what makes that a LINK rather than a one-time copy: it keeps
-- the address and the column matching, so Refresh re-reads the sheet without
-- asking anything again.
--
-- `mapping` stores header NAMES, not column positions: people insert and
-- reorder columns in a living sheet, and a position would silently start
-- reading the wrong one.
--
-- Managers only, reads included. The link is a capability: anyone holding it
-- can open a sheet with the crew's names on it.

create table public.site_plan_sources (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  url text not null,
  -- "<spreadsheet id>:<gid>": one row per tab per campaign.
  sheet_key text not null,
  title text,
  mapping jsonb not null,
  last_synced_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, sheet_key)
);

alter table public.site_plan_sources enable row level security;

create policy "managers read and write site plan sources"
  on public.site_plan_sources for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Which sheet a shift came from. A refresh only ever touches shifts carrying
-- its own source, so shifts added by hand are never rewritten by a sheet.
-- Unlinking keeps the shifts and drops the pointer.
alter table public.site_shifts
  add column source_id uuid references public.site_plan_sources (id) on delete set null;

create index site_shifts_source_idx on public.site_shifts (source_id);
