# Forcefield

Door-to-door canvassing app — fast single-screen knock logging, live team map, user chat, and an admin AI assistant with live data access. Vue 3 + Supabase + Google Maps, deployed on Netlify.

**Live:** https://f0rcef1eld.netlify.app (seed admin: `admin` / `forcefield-admin`)

Full requirements: [canvassing-app-spec.md](canvassing-app-spec.md) (see "Current Status" at the top for what's actually built vs. planned)

## Local development

```
npm install
npm run dev
```

Supabase URL and publishable anon key are baked in as public-safe defaults ([src/lib/config.ts](src/lib/config.ts)) — safe to expose, access is controlled by RLS. `VITE_GOOGLE_MAPS_API_KEY` has **no fallback** (a hardcoded Maps key in source trips Netlify's build-time secret scanner once the same value is also set as an env var) — put it in a local `.env` for `npm run dev` to render the map. Values for all of these live in the gitignored `KEYS-AND-ACCESS.md`.

To test the AI chat's Netlify Function locally (`/api/chat` — not served by plain `npm run dev`), run `netlify dev --offline` instead, with `.env` also containing `SUPABASE_SERVICE_ROLE_KEY` and `GOOGLE_MAPS_API_KEY` (server-side, no `VITE_` prefix).

## One-time Supabase setup (required before auth works)

1. **Apply the database schema.** In the Supabase dashboard → SQL Editor, paste and run
   [supabase/migrations/20260702120000_init_auth_roles.sql](supabase/migrations/20260702120000_init_auth_roles.sql).
   (Or, if the repo's GitHub integration runs migrations on push, just push to main.)
2. **Turn off email confirmation.** Dashboard → Authentication → Sign In / Providers → Email →
   disable **"Confirm email"**. Accounts use `username@example.com` emails that can't receive
   mail, so confirmation must be off for the demo phase (with it on, every signup also tries to
   send a confirmation email and quickly trips Supabase's built-in email rate limit).

The schema seeds the initial admin account:

- **username:** `admin`
- **password:** `forcefield-admin`

New public sign-ups default to the Canvasser role; the admin elevates accounts from there.

## Deploy (Netlify)

`netlify.toml` sets the build (`npm run build` → `dist/`) and the SPA redirect rule. Connect the repo in Netlify and deploy.

**Required Netlify env vars** (Site settings → Environment variables — values in `KEYS-AND-ACCESS.md`), or use the CLI: `netlify env:import .env` with a local `.env` containing all three:

- `VITE_GOOGLE_MAPS_API_KEY` — client-side map/geocoding (no fallback in source, see above)
- `SUPABASE_SERVICE_ROLE_KEY` — used only by `netlify/functions/chat.ts` to run read-only queries for the AI chat (bypasses RLS but is itself locked to read-only + walled off from chat tables at the Postgres grant level — see `supabase/migrations/20260703110000_fix_ai_readonly_query.sql`)
- `GOOGLE_MAPS_API_KEY` — server-side geocoding for the AI chat's Maps tools

An env var change alone doesn't redeploy — trigger a new deploy (or push any commit) afterward to pick it up.

## Roles

| Role | Home screen |
|---|---|
| Admin | `/admin` — dashboard (mostly "coming soon" — see spec status), AI chat with live data tools, settings |
| Team Lead | `/team` |
| Canvasser | `/canvass` — Talk/Hunt tabs |

Everyone (any role) also gets `/chat` — the user-to-user chat (global room, squads, DMs).
