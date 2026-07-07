# Forcefield — Requirements & Specifications

## 0. Current Status (as of 2026-07-06)

**Layered mobile stack (2026-07-05):** the app now ships on three deliberate layers — one library per layer, never two component libraries:
- **Capacitor 8 native shell** (`capacitor.config.ts`, committed `android/` + `ios/` platforms, `npm run mobile:*` scripts — see `MOBILE.md`). The Netlify web deploy is untouched; the shells wrap the same built `dist/`. Plugins wired with web fallbacks: geolocation (Hunt map locate-me button), haptics (knock-outcome taps), app (Android back → router), push-notifications (scaffold only, `src/lib/push.ts`). The admin AI chat calls the live site absolutely from the shells (CORS allowlist in `netlify/functions/chat.ts`).
- **Reka UI behavior primitives**, themed 100% by the existing CSS-variable schemes: `src/components/ui/BottomSheet.vue` (Dialog — used by /admin/users editor, Squads/Chat composers, and the nav More sheet) and `src/components/ui/AppSelect.vue` (Select — replaced every native `<select>`).
- **@vueuse/motion** for entrance polish (`src/lib/motion.ts` presets; no-ops under prefers-reduced-motion).

**Facelift (same date):** phones get a native-style bottom tab bar (4 role-appropriate destinations + a More sheet with the rest and Log out); desktop keeps the top tabs. Field-critical controls went big (full-width 64px Next, 56px squad/chat primary actions); browse/manage screens stay compact.

**2026-07-06:**
- **Squad page** (`/squad`, singular — `src/views/SquadView.vue`) — canvassers and squad leaders get their own squad's home base: a card per squadmate (animal avatar + personal accent color — new `profiles.color`, 12-swatch picker on /appearance, stable hashed fallback in `src/lib/memberColors.ts`) listing their last five knocked doors (house number + street + time, deduped); a squad map shading the crew's turf (assigned to the squad or to any member) with an "Our turf: X of Y doors knocked" progress bar, per-member door counts, and tap-able per-turf chips; tapping a member (card or their avatar marker on the map) zooms to the last door they knocked. Live over the `knock_logs` realtime feed — markers move and pop as squadmates work. The page doubles as join/create-squad when you're not in one, with a switcher when you're in several. Campaign managers keep `/squads` as the all-squads roster/assignment interface; old `/squads` links redirect everyone else to `/squad`, and the nav tab is "Squad" (singular) for canvassers/leads.
- **Turf roles corrected — campaign managers cut turf; squad leaders sub-cut inside their own** (`20260706140000_subturfs_cm_only.sql`, supersedes the same-morning `20260706120000` widening): top-level turf cutting/assignment is campaign-manager (+admin) only. Squad leaders instead cut **sub-turfs** — `turfs.parent_turf_id` marks a cut inside a turf assigned to them (directly or via squad membership) whose doors carve out of the parent's pool and return to it on delete (trigger) or re-cut; one nesting level; enforced by RLS (`can_lead_subcut()`) and inside `set_turf_segments()`, which keeps the `auth.uid() is null` trusted-context escape hatch every guard here relies on. `/turf` renders as a scoped sub-cutter for leads (parent picker, claim pool limited to their turf, list shows only their turf + its subs) and shows managers the full hierarchy (sub-turfs indented "↳ inside <parent>"). Permission matrix verified end-to-end against the live DB: rogue top-level/foreign-parent cuts rejected, sub-cuts move doors, deletes return them.
- **Same morning:** Hunt opens framed on all your (and your today-squad's) turf and "plinks" pins as live knocks land (squadmates' pop bigger); admin AI chat now works out of the box via a shared server-side demo-key fallback (admins can still save their own key); unread chat badges no longer resurrect on reload (the read-mark request was never being sent; server-side read timestamps had landed the evening before, `20260705190000`).
- **Squad leaders canvass like everyone else; turf splitting moved onto the Squad page (evening).** The separate squad-leader home (`/team`, a stub) is gone — team_leads land on `/canvass` and share the canvasser tab set, with the home tab labeled "Canvass" for both roles. The Squad page's "Split up the turf →" link to `/turf` was replaced by an in-page **"Assign doors" mode**: an Assign doors button on each member card (shown to whoever may sub-cut: leads, CMs, or leaderless-squad members) scrolls to the squad map and turns door pins into selection targets — tap doors in/out of that member's pile (their existing sub-turf doors come pre-selected; selected pins wear the member's accent color), Save cuts/re-cuts a `"<name>'s doors"` sub-turf assigned to them via `set_turf_segments` (doors taken from a squadmate's sub-turf are released by re-cutting that sibling first; an emptied sub-turf is deleted, returning doors to the parent). The squad map also now opens framed on the TURF itself (members' last knocks only frame it when no turf door is mapped — before, one far-away knock dragged the whole frame off the turf). `/turf` keeps the scoped sub-cutter as a fallback but leads no longer have a nav link to it.
- **Two-tap "walk" sweeps, no duplicate coverage, locate-first street search, Geolocate buttons (same evening).** Tapping door A then door B — in the turf cutter's anchor flow AND the Squad page's assign mode — now takes every door along the walk between them, including around a corner onto a second street (`src/lib/doorPath.ts`: same street = the number range; different streets = up A's street to the geometrically-closest corner, then along B's street — two taps can cover two streets). The cutter's draft can no longer hold the same doors twice: a sweep overlapping an existing same-street segment folds into it. Street search on `/turf` no longer auto-adds: tapping a match just zooms to the street and drops its pins (geocoding a capped batch), and each result row has an explicit "Entire street" button that does the old add-whole-street. All three maps got a demo "Geolocate" button — Turf and Hunt geocode every door on the streets currently in view (streets identified by their pinned doors), the Squad map pins the turf's still-unlocated doors — with a confirm() warning before batches over 100 (the Maps Geocoder runs one door at a time).
- **2026-07-07 — turf cutter gestures + UI pass:** the geolocate action was renamed **"Place pins"** and moved out of the layers strip to its own button on all three maps (the shading toggle is now labeled "Shade"). **Turf names are optional** — saving blank auto-names the cut "&lt;assignee&gt;'s turf" (or "Turf N" when unassigned). The draft tray was redesigned from stacked editor boxes into **compact pills** (street · range · door-count badge, ✕ to drop) with a single inline editor that opens for whichever pill is tapped.
- **Same day, still later — turf cutter gets its own pin-style toggle, a cleaner instructions bar, and two-tap now extends instead of erasing by default:** the cutter has a dots/numbers pin toggle identical to Hunt's (same zoom-16 fallback to dots when zoomed out); the Both/Even/Odd side filter moved out of the bordered instructions box into its own row below it, so the box just holds the hint text. Two-tap sweep logic changed: tapping an already-included pin then a NEW pin now EXTENDS the turf, connecting the two along the walk between them (the earlier "anchor already in turf → erase" rule was backwards for the common case of growing a turf from an existing edge) — erasing now only happens when BOTH tapped doors are already in the turf, which is the one case left with nothing to add.
- **Same day — zoomed-out pins stop showing numbers:** Hunt's numbers mode now falls back to plain dots below zoom 16 (house numbers only mean something when you're looking at one street; the chips floating over a whole town read as noise), flipping back to numbers as you zoom in — restyles happen only on threshold crossings, never per zoom tick. Squad-map door chips got the same gate. And the cluster bubbles (all three maps, `dotClusterRenderer` in `src/lib/mapLayers.ts`) lost their count text: they're now plain blue density dots that grow with how many pins they swallowed, with a translucent halo — the default renderer's counts read like house numbers next to number-mode pins.
- **Same day, later still — Place pins works over pinless ground, status-colored cutter pins, Talk door history:** "Place pins" no longer requires a pinned street in view: it now ALSO reverse-geocodes five viewport sample points (center + quadrant midpoints, `streetsAtPoints` in `src/lib/geocode.ts`) to discover the streets under the map, so panning around an un-geocoded neighborhood and tapping the button pins it (the >100 confirm still applies; an unpinned door has no coordinates, so streets are still the unit of work). Turf-cutter pins now read like Hunt's: the FILL is the door's latest knock-outcome color (blue = never knocked, via `household_latest_knock`), while turf membership moved to the ring — draft color while swept into the cut, the saved turf's color otherwise, ringless when unclaimed. And Talk mode now shows the door's ENTIRE visit history under the roster — every knock with its outcome color-dot, who it was about, which canvasser logged it, any note, and the weekday + date + time ("Sat, Jul 5 · 3:12 PM"), newest first, scrolling inside the card (up to 500 pulled with person/canvasser names embedded).
- **Same day, later — gestures went from mode-toggle to contextual, plus Start Over:** the Add/Erase mode buttons were removed in favor of every gesture deciding for itself. Two-tap sweep now erases the walked stretch if the anchor door is already in the draft, otherwise it adds it (`subtractRange` splits a segment around the erased hole so the ends survive). Holding a pin (~450 ms) removes it if it's already drafted; if it isn't, it's added connected — walked in from whichever already-drafted door sits geometrically closest (`nearestDraftDoor`), so a held door never floats as an isolated island (falls back to a lone-door add when the draft is still empty). Double-tap keeps its existing toggle (present → remove, absent → add whole street). The sweep bar tints red the instant the armed anchor is already in the turf, previewing that the next tap erases. "Clear all" was replaced by **"Start over"**, which wipes only the swept streets — the turf name and assignee (squad/canvasser) picked earlier survive, and mid-edit it stays in edit mode; a separate **"Cancel edit"** button fully abandons an edit (and clears Undo, since old segments don't make sense to restore outside that edit's context).
- **2026-07-05 evening (also after the last status update):** turf cutter gained double-tap street toggling (double-tap the map near a street to add/remove it whole) and street search that zooms to and pins the street; assorted turf/admin fixes from a simulated-tester QA pass.

This doc below is the original requirements/planning spec — left intact as a reference, but it now reads ahead of what's actually built in places. This section is the accurate summary.

**Live:** https://f0rcef1eld.netlify.app — seed admin `admin` / `forcefield-admin`.

**Built and working:**
- **Stage 1** — auth, roles (canvasser/team_lead/admin), teams, RLS throughout, seeded admin account.
- **Stage 2 canvassing core** — Talk mode (live search, full household roster, six-outcome logging with toggle/undo, always-visible notes, offline queue via Dexie); Hunt mode (map with dynamically-scaled pins, live search, "Locate" fills in every house on the same street up to 50, per-door "N/household-size signed" ratio + 6-outcome indicator grid, color-coded Knock button, a violet-highlighted "located" card above the map). "Next" in Talk mode auto-advances to the next house on the street, direction (ascending/descending) and side (both/evens/odds) configurable from a small menu in Hunt mode. **Deviation from the original spec** (section 5.1 below), tightened in two steps on 2026-07-03 at the user's request: (1) the outcome buttons are disabled until an address/household is loaded — fully anonymous walk-up logging (no address at all, per the original "total stranger in a parking lot" requirement) was removed; (2) Signed / Didn't Sign / Maybe additionally require a specific person picked from the roster (a signature can't be credited to "the household" in the abstract) — only Not Home / Skip / Hostile can still be logged against the household as a whole. See `requiresPerson` in `src/lib/outcomes.ts`.
  - **Hunt map** opens centered/zoomed on the canvasser's own most-recently-knocked address (`lastKnockCenter()` in `HuntTab.vue`) rather than fitting all ~2k county-wide pins on every load — the latter looked like the map "didn't know where to start." Falls back to fit-all-pins for a canvasser who's never knocked anywhere geocoded yet.
  - If Google rejects the Maps API key at runtime (quota/billing/referrer restriction — the "This page can't load Google Maps correctly" dialog), a `gm_authFailure` hook (`src/lib/googleMaps.ts`, `mapsAuthError` ref) surfaces a readable message under the map pointing at the browser console for the specific reason, rather than leaving only Google's own cryptic dialog. Most common local-dev cause: no `VITE_GOOGLE_MAPS_API_KEY` in a local `.env` (Netlify injects it at deploy time, but nothing does locally) — see README's Local development section.
  - **Admins can reach Talk/Hunt too** — a "Canvass" nav link (`AppShell.vue`) was added for the admin role, since admins often go out canvassing themselves. The `/canvass` route was already unrestricted by role; it just had no discoverable entry point before.
- **Data** — ~22.7k Union County, OH addresses and ~43.5k persons imported from the voter file (`scripts/import-union-subset.ts`), geocoded on demand.
- **User-to-user chat** (`vue-advanced-chat`) — global "Everyone" room, open squads, DMs, expandable member list (message-user / add-to-squad actions from both the member list and the per-message dropdown), realtime updates including new-membership pushes. Since 2026-07-05 chat is no longer a nav tab: it lives in a right-edge pull-out drawer available on every screen (`ChatDrawer.vue`) — tap-or-drag neon-orange handle (drags up/down to reposition, position remembered per device), unread badge on the handle, room-list front screen with per-room unread counts. Roles were restructured the same day: admin > campaign_manager > team_lead ("Squad Leader") > canvasser — campaign managers inherit the full old-admin feature set (`is_admin()` covers both; `is_super_admin()` gates user management), and every team auto-gets three rooms (team / Squad Leaders / Managers) with implicit role-based membership. Also added that day: emoji message reactions (`message_reactions`), image/GIF attachments (public `chat-media` storage bucket + `chat_messages.files`), per-user read tracking (`chat_reads` + `get_unread_counts()`), and Fluent-Emoji animal avatars (`profiles.avatar`, picker on /appearance, 106 flat SVGs in `public/avatars/`).
- **Admin AI chat** — Claude Haiku, admin brings their own Anthropic API key (saved per admin account — see "Per-account AI key storage" below), invisible to canvassers. Real tool use, not just a chat shell:
  - `query_database` — arbitrary read-only SQL over the canvassing tables. Enforced at the Postgres level (`transaction_read_only` + a `REVOKE` on `service_role` for the chat tables specifically), not just prompt instructions — see `ai_readonly_query()` in `supabase/migrations/20260703110000_fix_ai_readonly_query.sql`.
  - `geocode_address` / `reverse_geocode` / `distance_between` (Google Maps).
  - `compute_statistics` (`simple-statistics`) — mean/median/mode/stddev/quantile/skewness/kurtosis/ckmeans clustering, plus two-array correlation/linear-regression/t-test.
  - Bounded to an ~8s internal deadline (`netlify/functions/chat.ts`) so a multi-round tool-use loop never exceeds Netlify's ~10s function timeout, regardless of plan.
  - **Timezone-aware**: `knock_logs.occurred_at` / `created_at` are correctly stored in UTC (that part was never the bug) but the assistant has no innate sense of the admin's timezone, so without help it just repeated the raw UTC value — reading hours off from the actual local time. The browser now sends its IANA timezone + current local clock reading with every message (`AdminChatView.vue`), and the system prompt (`buildSystemPrompt()` in `chat.ts`) instructs the model to convert any UTC timestamp before stating it back, labeled as local time. Verified against a real knock: `05:38:01 UTC` correctly reported as "1:38 AM local time."

**Also built and working:**
- **Leaderboards** (`/leaderboard`) — per-canvasser and per-squad standings over `knock_logs`. Career totals come from the security-invoker `canvasser_leaderboard` view (`20260703130000_leaderboards.sql`, rebuilt without team columns in `20260705110000_leaderboard_drop_teams.sql`); squad standings aggregate client-side per day. Admin-configurable primary ranking metric (signatures or doors knocked) plus an optional second doors-knocked board, stored in a single-row `leaderboard_settings` table and configured from a card on `/admin`. Realtime-refreshes (debounced) on new knock inserts; browsable day history. **Team standings removed 2026-07-05** (the `team_leaderboard` view is dropped): in practice the whole org is one team on one campaign, so a team board, team scope toggle, and per-row Team column were noise — squads are the group standings that mean something.
- **Turf assignment** (`/turf`; 2026-07-05 — role model corrected 2026-07-06, see above: cutting is campaign-manager-only now, squad leaders sub-cut) — street-range turf cutting on the same map Hunt uses. The "street sweep" interface: tap one door to drop an anchor, tap another door down the same street to sweep the whole house-number range (with a Both/Even/Odd side filter), and the swept doors light up under a colored highlighter stroke; or search a street by name to sweep it whole. Sweeps stack in an editable tray (range endpoints and side per segment), then the draft gets a name and an assignee — a today-squad (the crew divides it themselves) or an individual canvasser, never both (DB CHECK). Schema: `turfs` + `turf_segments` (`20260705120000_turfs.sql`); membership is **stamped** onto `addresses.turf_id` by the `set_turf_segments()` security-definer RPC (lead/admin-checked, same street-name/house-number normalization as `src/lib/streetWalk.ts`; overlapping doors stay with their first turf; deleting a turf frees its doors via FK `on delete set null`). Canvassers see their turf on the Hunt map: member pins get a ring in the turf's color and a "Your turf" chip above the map pans/zooms to it.
  - **Map overlay layers** (`src/lib/mapLayers.ts`, shared by Hunt and the turf cutter; added same day): (1) **turf area shading** — each turf renders as a translucent colored area ("highlighter swath": member doors grouped into per-street runs, each run buffered ~45m via turf.js `@turf/buffer` + `@turf/union`, dynamically imported so the geometry engine only loads when an area draws). All turfs show in their own colors; on Hunt, yours get stronger fill. The draft sweep on `/turf` shades live as you cut. (2) **City limits** — incorporated-place boundaries (39 cities/villages around Union County, Census TIGERweb layer 4) bundled as `public/boundaries/union-city-limits.geojson` by `scripts/fetch-city-limits.mjs` (re-run it after annexations); rendered as a tinted, outlined overlay because the local borders are gerrymandered (city → township → city along one road) and petition validity cares. Both layers have Areas/City toggle buttons on the map, persisted per device in localStorage and shared across the two pages. Both layers are `clickable: false` so they never eat pin taps.
- **Campaign bulletin** (`/bulletin`) — admin-post, everyone-reads announcements feed. Deliberately its own table (`public.bulletins`, `supabase/migrations/20260703120000_bulletins.sql`) rather than reusing the `chats`/`chat_messages` pattern: bulletins don't need a membership model and, unlike private chats, should be readable by the admin AI's `query_database` tool — a fresh table inherits `service_role`'s default grant, so no extra REVOKE/GRANT surgery was needed (see the chat tables' walled-off REVOKE in `20260703110000_fix_ai_readonly_query.sql` for contrast). Realtime-backed feed, admin delete.
- **Color schemes** (`/appearance`, section 7 below) — 10 cosmetic themes (light, dark, high contrast, 80s synthwave, 90s desktop, forest, ocean, sunset, solarized, midnight), saved per account in `profiles.theme` (`{"scheme": "..."}`, normalized by `20260703150000_theme_schemes.sql`). Definitions live in `src/lib/themes.ts` as CSS-custom-property token sets, applied to `:root` and (via a translation layer, `vacStyles()`) to the `vue-advanced-chat` widget's `styles` prop — CSS custom properties cross its shadow-DOM boundary since they inherit like any other inherited property. Deliberately does **not** touch the six knock-outcome colors, the Hunt-mode outcome grid, or map pins: `lib/outcomes.ts` uses fixed hex values instead of theme tokens specifically so those stay legible and consistent no matter the chosen scheme.
- **Per-account AI key storage** — the admin's Anthropic API key lives in `public.admin_settings` (owner-scoped RLS, `20260703140000_admin_settings.sql`) instead of browser `localStorage`, so it follows the account across devices.

**Not built yet:**
- Voter CSV import UI (the import itself only exists as the CLI script, not an admin-facing upload flow — still a "coming soon" card on `/admin`)

**Discussed, not built (2026-07-03):**
- **GPS-based auto street-detection in Hunt mode** — technically feasible (browser Geolocation API works on both iOS Safari and Android Chrome over HTTPS; the app already has the distance-comparison logic needed to find the nearest geocoded address, see `HuntTab.vue`'s `locateAddress`/`flatDistance`). User asked to hold off on building it for now — not declined outright, just not prioritized yet.
- **Reading phone battery level** — not feasible cross-platform as a website. Apple has never implemented the Battery Status API in Safari (deliberate, fingerprinting concerns) and Chrome has restricted it heavily for the same reason. The only way to get real battery data on both iOS and Android would be to stop being a website and wrap the app natively (e.g., Capacitor) with a native battery plugin — a materially bigger architecture change than anything else here. Don't re-propose a pure-web solution to this.

---

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
7. **Color themes** — built; see section 0. Ten full schemes rather than light/dark + accent, all cosmetic-only.
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
VITE_GOOGLE_MAPS_API_KEY=<billing-enabled key with Maps JavaScript + Geocoding APIs; value in KEYS-AND-ACCESS.md, not committed here to keep Netlify's secret scanner happy>
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
