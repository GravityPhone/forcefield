# Forcefield — Requirements & Specifications

## 1. Summary
Forcefield is a Vue-based canvassing app for door-to-door and crowd petitioning, replacing/combining the useful parts of Reach and Minivan. Core goal: fast, single-screen data entry in the field, with real-time team sync, org-wide roles, and (phase 2) data-driven turf-cutting.

**Repo status:** GitHub repository is already set up, and the Supabase project is already connected to it.

---

## 2. Tech Stack (proposed)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vue 3 + Vite | You're already building in Vue |
| State | Pinia | Standard Vue store, works well with offline queuing |
| Backend/DB | Supabase (Postgres + real-time + auth) | Real-time shared backend, built-in auth/roles, generous free tier, easy Netlify integration |
| Maps | Google Maps JavaScript API + Places API | Per your answer — good geocoding, familiar UI, reliable in the US |
| Hosting | Netlify | Per earlier conversation |
| Offline handling | Service worker + local queue (IndexedDB via Dexie.js) | Spotty signal means writes need to queue and retry, not fail |

**Backend confirmed:** Supabase — SQL is a good fit for the probability/analytics work later, and row-level security maps cleanly onto the role structure.

---

## 3. Roles & Permissions

| Role | Can do |
|---|---|
| **Admin** | Assign turf/territories to teams, view all data, manage users, export data, configure lookup fields, create other admins, elevate/change roles |
| **Team Lead** | View their team's leaderboard and progress, assign turf within their team, see canvasser-level detail for their team only |
| **Canvasser** | Log knocks, see their own stats/leaderboard position, view assigned turf only |

**Auth flow:**
- The app opens to a **landing page** with **Login** and **Sign Up** buttons — not straight into a login form.
- **Sign up** is self-serve and intentionally minimal: just a username and password. New accounts default to the **Canvasser** role.
- **Admin accounts are not created through public sign-up.** There's a seed/initial admin account that comes with the org/team when it's first set up (bootstrapped at team-creation time) — this guarantees there's always at least one admin able to log in and manage things.
- From there, admins manage roles directly: they can elevate an existing account (Canvasser → Team Lead → Admin) or create additional admin accounts outright. This is simpler than a separate invite-email flow and works well for a small team.
- Underneath, this still runs on Supabase Auth (email/password) — the "username" is just how it's presented to the user; Supabase Auth needs an email under the hood, so a demo email pattern (e.g., `username@yourorg.local`) or a real email field can be used.

**Demo phase note:** for this stage, keep credentials genuinely simple and low-friction (easy username/password for you to demo with) rather than a production-grade flow with email verification, password strength rules, etc. Tighten this up before any real rollout beyond the demo.

---

## 4. Core Data Model (draft)

**Household / Address**
- address (geocoded lat/lng via Google Places)
- street, unit, **city**, county, zip — city/county fields are required for filtering a county-wide import down to specific cities/jurisdictions
- assigned turf/territory ID
- data source: `csv_import` / `minivan` (future) — tracks provenance since you're starting with a manual CSV and may add Minivan sync later
- registered voter (boolean — true by default for records sourced from the county voter roll CSV)

**Person** (not optional — talk mode needs the full roster at an address)
- name, household ID (**nullable** — a street/parking-lot walk-up may have a name with no address on file yet), voter file ID (if applicable), registered voter flag, prior contact history
- an address can have multiple Person records (the household roster shown at a glance in talk mode); a Person can exist unlinked to any address

**Knock Log** (the core event Reach was missing)
- person ID (**nullable** — logging an outcome doesn't strictly require an identified person)
- household ID (**nullable** — walk-ups may have no address)
- canvasser ID
- timestamp
- outcome: `Signed` / `Didn't Sign` / `Maybe` / `Not Home` / `Skip` / `Hostile` — six fixed buttons, no dropdown. (`Hostile` flags a safety-relevant interaction distinct from a routine decline; `Skip` covers "didn't engage" in contexts where "Not Home" doesn't apply, like a crowd or parking lot.)
- notes (free text, optional, always-visible small field — not a toggle)

**Turf/Territory**
- polygon or street-range boundary
- assigned team/canvasser
- status: not started / in progress / complete

---

## 5. Core Features — Phase 1 (MVP)

1. **Talk mode — the canvasser's persistent home screen, two tabs**
   - **Talk tab (default):** always-on name/address search field at the top, plus six large outcome buttons (Signed / Didn't Sign / Maybe / Not Home / Skip / Hostile) and an always-visible notes field — both are live even before anything is searched, because a canvasser needs to be able to walk up to a total stranger (street, parking lot, crowd), catch a name, and hit "Signed" without ever navigating anywhere.
     - **Unpopulated state:** just the search field + buttons. Typing a name/address and picking a match (or not) doesn't change the screen — it just attaches that person/address to the outcome about to be logged.
     - **Populated state** (arrived via the Hunt tab, or resolved through search): shows the **full roster of every Person on file at that address** at a glance — a door-knock conversation might involve more than one resident, and the canvasser needs to see and pick among all of them without leaving the screen. Each person shows registered-voter status and prior contact history inline.
     - Switching people or addresses happens inline via the same search field — this screen never navigates away mid-conversation.
     - After logging an outcome: a "Next" button confirms before clearing/advancing — no silent auto-advance.
   - **Hunt tab:** the door-knocking helper — map with pins colored by knock status, plus a searchable/browsable street list. Selecting a pin or list entry switches back to the Talk tab with that address and its full resident roster pre-loaded.
   - No separate "lookup" screen and no separate map screen that talk mode is bolted onto — Hunt and Talk are two tabs of one persistent home, and Hunt only ever hands off into Talk, never away from it.
2. **Address / street lookup (lives inside the Hunt tab)**
   - Context-dependent list: searching a street name shows every house on that street/block; selecting one house shows its individual units if it's a multi-unit building.
   - Selecting any result switches to the Talk tab with that address (and its roster) loaded.
3. **Map view (the other half of the Hunt tab)**
   - Google Map showing turf boundaries and pins colored by knock status (not started / not home / maybe / signed / refused / hostile).
   - This is the feature Reach lacks entirely.
4. **Real-time sync**
   - Knock logs write to Supabase immediately when online; queue locally and retry when signal returns (handles "spotty but usually some signal").
5. **Leaderboards**
   - Doors knocked, signatures collected, per canvasser and per team, real-time updating.
6. **Admin turf assignment**
   - Street-range assignment (e.g., "100–300 block of Elm St") — no map polygon drawing for now. Simpler to build and matches how turf is actually cut in practice; custom polygon drawing can be revisited later if street-range proves too coarse.
7. **Color themes**
   - Light/dark + a couple of accent options (low priority, easy to add via CSS variables — can slot in anytime).
8. **CSV import (voter roll)**
   - Admin uploads a county voter-roll CSV (starting with Union County, OH format) to populate Household/Address records.
   - Import should support a city/jurisdiction filter so an admin can narrow a county-wide file down to just the area they're canvassing.
   - Records imported this way are marked `registered voter = true` and `data source = csv_import`.
9. **Minivan connection (placeholder)**
   - Admin settings includes a "Connect to Minivan" option, disabled/marked "coming soon" for now.
   - Not functional yet — real integration depends on your org's VAN API access, which isn't available during this development phase. Having the placeholder in place now avoids re-architecting the data import layer later.
10. **Admin AI chat — UI shell only**
    - Build the chat interface itself (chat panel/screen in the admin view, message input, message history display, BYO-key entry field in admin settings) as part of the initial UI, even though the backend (RAG, vector search, live data retrieval, actual model calls) is Phase 2.
    - Until the backend is wired up, the chat can show a "coming soon" state or return a placeholder response — the point is the UI exists and is visually part of the app from day one, not bolted on later.
    - Build the rest of the app (especially the data model and Supabase schema) with this in mind, since the chat will eventually need real-time read access to knock logs, addresses, and turf data — avoid decisions now that would make that harder to wire up later.

## 6. Phase 2 Features

1. **Probability / turf-cutting model**
   - Use historical knock data (time of day, outcome, area) to score which unvisited addresses are highest-probability for a signature or supportive contact.
   - Likely approach: start with a simple weighted heuristic (time-of-day success rate × area success rate), then consider a real model once you have enough logged data — a small dataset won't support much more than that anyway.
2. **Battery-saving mode**
   - Reduce map re-renders / GPS polling frequency; explore later.
3. **Data export** (CSV/voter-file format) for admin.
4. **Admin AI agent — making the chat shell (built in Phase 1) actually work**
   - Wire the chat interface up to a real backend: retrieval-augmented generation (RAG) with vector search over the knock/address data, so the agent pulls relevant records before answering rather than relying on the model's general knowledge.
   - Give it real-time access to the app's data (knock logs, addresses, outcomes, turf status), so an admin can ask things like "which streets have the highest signature rate in the evenings?" or "where should we focus this weekend?" in plain language.
   - This is the natural-language front end to the same probability/turf-cutting problem in Feature 1 above — same underlying "which doors are worth knocking" question, just queryable conversationally instead of only shown as map scoring.
   - **Bring-your-own-key model:** the admin supplies their own Anthropic API key (stored securely, not shared/hardcoded). Start with a cheap/fast model for testing (e.g., Haiku-tier) to keep costs low while validating the concept before considering a stronger model.
   - This is a genuinely non-trivial build (vector DB/embeddings pipeline, RAG retrieval logic, agent orchestration, secure BYO-key storage) — plan for it as its own milestone.

---

## 7. Decisions (formerly Open Questions)

- **Voter file import:** No live voter-file/VAN access yet. MVP imports from a downloaded Union County, OH voter-roll CSV. Data model tracks `data_source` so this can coexist with a future Minivan sync without a schema change.
- **"Maybe" follow-up:** No automatic task/reminder — status is just visible via pin color on the map. Kept simple for MVP.
- **Compliance / legal:** No signature-witnessing enforcement needed — records imported from the voter roll are already registered voters. The practical need instead is **filtering**: being able to narrow a county-wide import down to specific cities. Added as a filter on CSV import (see Data Model and Feature 8).
- **Turf boundaries:** Street-range assignment (not custom map polygons) for now — simpler to build, matches how turf is actually cut in the field. Can revisit polygon drawing later if needed.

---

## 8. UI & Feature Behavior Details

**Talk mode (canvasser home screen — two tabs, Talk + Hunt)**
- **Talk tab** is always reachable and always "live" — the outcome buttons work even with nothing searched yet, so a canvasser can engage a total stranger and log an outcome in two taps (search or skip search → tap outcome).
- Selecting a pin or list entry in the **Hunt tab** switches to the Talk tab with that address loaded — never an intermediate preview/details screen. Hunt itself isn't lost, just backgrounded, so the canvasser can flip back to it after logging.
- When an address is loaded, talk mode shows **every Person on file at that address** at a glance (the household roster) — a conversation may involve more than one resident, and the canvasser picks who they're actually engaging without leaving the screen.
- Outcome selection: six large, tap-friendly buttons (Signed / Didn't Sign / Maybe / Not Home / Skip / Hostile), no dropdowns/menus.
- Notes field: always visible as a small text field, not hidden behind a toggle.
- After logging an outcome: show a "Next" button — canvasser confirms before the screen clears/advances (no silent auto-advance).
- Switching to a different person or address happens inline via the same search field on the Talk tab — this screen never fully navigates away mid-conversation.

**Hunt tab (map + address lookup)**
- Map: pins colored by knock status (6-state, matching the outcome list above), clustering into a number bubble in dense areas, breaking apart as the canvasser zooms in.
- Address lookup is context-dependent: searching a street name shows every house on that street/block; selecting one house shows its individual units if multi-unit.
- Both the map and the list are ways to *find* an address — actually logging an outcome always happens back on the Talk tab.

**Maybe / follow-up handling**
- No automatic task/reminder system. A "Maybe" is simply tagged on the map (via its pin color) for anyone to see and revisit — kept intentionally simple for MVP.

**Leaderboards**
- Admin-configurable ranking metric. Default: signatures collected.
- Admin can enable a second, separate leaderboard for doors knocked.
- Default view: canvasser's own team only, with a toggle to switch to org-wide standings.

**Offline sync**
- No visible sync-status indicator (no badge, no banner). Signal is usually available, so the offline queue works silently in the background — keeps the UI minimal. Revisit if field experience shows this causes confusion about whether a knock actually saved.

**Themes**
- Per-canvasser preference, not admin-controlled. Each person picks their own light/dark/accent choice.

---

## 9. Configuration & Environment Variables

**Public (safe to put in this doc / frontend code):**
```
VITE_SUPABASE_URL=https://whrliwbdxjdcksbvwkrc.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable/anon key — safe to expose, access controlled by RLS policies>
VITE_GOOGLE_MAPS_API_KEY=AIzaSyAQ2t13RtoidSYWPNJmL5R5PVQDzJvZtOs  # billing-enabled key with Maps JavaScript + Geocoding APIs, restricted by HTTP referrer
```

**Secret (NEVER in this doc, NEVER committed to GitHub — .env + .gitignore only, or Netlify env vars for deploy):**
```
SUPABASE_SERVICE_ROLE_KEY=<rotate this in Supabase dashboard before using>
SUPABASE_SECRET_KEY=<rotate this in Supabase dashboard before using>
GOOGLE_MAPS_API_KEY=<restrict by HTTP referrer + limit to specific APIs used>
```

**Setup checklist:**
- [ ] Rotate the service role key and secret key in Supabase dashboard (Project Settings → API)
- [ ] Create `.env` locally with real values, confirm `.env` is in `.gitignore`
- [ ] Add real secret values to Netlify → Site settings → Environment variables at deploy time
- [ ] Restrict Google Maps key to your domain + localhost, and to only Maps JavaScript/Places/Geocoding APIs

---

## 10. Suggested Build Order
1. Scaffold Vue app + Supabase project + auth + roles
2. Talk-mode screen + knock logging (offline-queue included from the start — easier to build in than retrofit)
3. Lookup (street/person search)
4. Map view with pins
5. Leaderboards
6. Admin turf assignment tools
7. Themes
8. Phase 2: probability scoring, battery mode, export
