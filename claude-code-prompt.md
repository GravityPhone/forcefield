# Claude Code — Project Brief

> Paste everything below the line into Claude Code from the root of your (already-initialized) Git repo. Keep `canvassing-app-spec.md` in the repo root too — it has the full detail behind everything summarized here.

---

I'm a political canvasser building a better version of the door-to-door canvassing apps my team currently uses (Reach and Minivan). The app is called **Forcefield**. Read `canvassing-app-spec.md` in this repo first — it's the full requirements doc. This message is a summary and starting point; use your judgment on implementation details, project structure, and libraries beyond what's specified.

This repo is already set up on GitHub, and the Supabase project is already connected to it.

## What the app does

Canvassers use it in the field — knocking on doors and working crowds — to log outcomes quickly, see where they've already been, and see where to go next. Right now my team is stuck between two tools: Reach has no map and no reliable way to log knock outcomes by time, and Minivan has other gaps. I want one app with the best of both.

Build it in **Vue 3**, backed by **Supabase** (Postgres, real-time, auth), with **Google Maps** for the map view. Deploy target is **Netlify**, so keep that in mind for build config (SPA routing needs a redirect-to-index-html rule).

## Who uses it

Three roles: **Admin**, **Team Lead**, and **Canvasser**. Admins manage users, assign turf, configure leaderboard settings, and import voter data — they can also create other admins and elevate existing accounts to a higher role. Team leads see and manage their own team. Canvassers log knocks and see their own stats.

Auth flow: the app opens to a **landing page** with **Login** and **Sign Up** buttons. Sign up is self-serve and minimal — just username and password — and new accounts default to Canvasser. Admin accounts aren't created through public sign-up; there's a seed/initial admin account that comes with the org when it's first set up, and admins manage roles from there (elevate an account, or create another admin directly) rather than a formal invite-email system. Underneath this can still run on Supabase Auth (which needs an email — use a simple pattern like `username@domain.local` if you want to keep the user-facing experience to just username/password). For this demo phase, keep it low-friction — no email verification or password strength requirements needed yet, that can come later before any real rollout.

## The core workflow

A canvasser opens the app to a **map** showing their assigned turf, with pins colored by status: Not Home, Maybe, Signed, Refused. When addresses are close together (an apartment building, a dense block), pins cluster into a number until the canvasser zooms in.

Tapping a pin minimizes the map and drops the canvasser straight into a **single-screen "talk mode"** for that address — no extra navigation, since fumbling with the phone mid-conversation is exactly what's wrong with the current tools. That screen shows the household info, big tap-friendly buttons for each outcome (no dropdowns), and an always-visible small notes field. After logging an outcome, a "Next Address" button lets them confirm before moving on — no silent auto-advance.

There's also a **lookup** for finding a specific street or person — both a search bar and a browsable list, since either might be faster depending on the moment.

A "Maybe" outcome doesn't trigger any automatic follow-up task — it's just visible as a pin color for anyone to revisit. Keep this simple; no reminder system needed.

## Data comes from a CSV for now

I don't have live voter-file (VAN/Minivan) access yet, so to start, admins import addresses from a downloaded county voter-roll CSV (I have one from Union County, Ohio). Since a county file covers more ground than one canvassing effort needs, the import should let an admin filter down to specific cities. Records from this import are already-registered voters, so no extra eligibility/compliance logic is needed there.

Down the line I do want a "Connect to Minivan" option in admin settings — but I don't have API access to build against yet, so for now it just needs to exist as a visibly disabled/coming-soon option, not functional. Don't build the real integration.

## Turf assignment

Admins assign turf by street range (e.g., "100–300 block of Elm St") rather than drawing custom map boundaries — simpler, and matches how it's actually done in the field. Turf has a status: not started, in progress, complete.

## Leaderboards

Ranking metric is admin-configurable — default is signatures collected, but an admin can also turn on a separate leaderboard for doors knocked. Canvassers see their own team's leaderboard by default, with a toggle to see the whole org.

## Offline behavior

Signal is usually available but spotty, so knock logs should queue locally and sync when connectivity returns rather than failing outright. No visible "syncing" indicator needed — keep this invisible unless it becomes a real problem later.

## Personalization

Canvassers can pick their own light/dark/accent color theme — this is a personal preference, not admin-controlled.

## Build order

I'd like to build this in stages rather than all at once. Start with: project scaffold, Supabase auth, and the three-role system with role-based routing to placeholder home screens. Get that working end-to-end before we move on to talk-mode, the map, lookup, leaderboards, turf assignment, CSV import, and themes — roughly in that order, though use your judgment. Stop and check in with me once auth and roles work so I can review before we continue.

There's also an admin-only AI chat feature planned — the **UI for it should be built from the start**, even though the backend isn't. That means: include a chat panel/screen in the admin view, a message input and history display, and a place in admin settings for the admin to enter their own Anthropic API key (bring-your-own-key model). Until the real backend exists, it can show a "coming soon" state or a placeholder response — the goal is that it's visually and structurally part of the app from day one, not bolted on later. Because of this, keep the data model and Supabase schema built with future real-time read access in mind (knock logs, addresses, turf data) — nothing needs to be built for it yet, just don't paint yourself into a corner.

Phase 2 (later, not now): a probability model to suggest which unvisited addresses are worth prioritizing based on historical knock data, a battery-saving mode, data export, and — the biggest phase 2 piece — wiring the admin chat shell up to a real backend: RAG + vector search over knock logs and addresses, so an admin can ask things like "which streets have the best signature rate in the evenings" in plain language and get a real answer. That one starts with a cheap model to test and is a big enough build that it should be its own milestone.

## Keys

These are the public-safe keys — fine to use directly, not secrets:

```
Supabase URL: https://whrliwbdxjdcksbvwkrc.supabase.co
Supabase anon/publishable key: sb_publishable_JcZe2JFmhQGFK_Mddet4EA_IWZw4727
Google Maps API key: see the gitignored KEYS-AND-ACCESS.md (kept out of version control)
```

The Supabase service role key and secret key are NOT included here — those bypass all access controls and need to be rotated and handled separately. I'll provide those directly if/when they're needed, not in this brief.
