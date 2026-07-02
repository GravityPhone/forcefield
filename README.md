# Forcefield

Door-to-door canvassing app — fast single-screen knock logging, live team map, leaderboards. Vue 3 + Supabase + Google Maps, deployed on Netlify.

Full requirements: [canvassing-app-spec.md](canvassing-app-spec.md)

## Local development

```
npm install
npm run dev
```

Supabase URL and publishable keys are baked in as public-safe defaults ([src/lib/config.ts](src/lib/config.ts)); a `.env` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_GOOGLE_MAPS_API_KEY` overrides them.

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

`netlify.toml` sets the build (`npm run build` → `dist/`) and the SPA redirect rule. Connect the repo in Netlify and deploy — no required env vars for the demo phase.

## Roles

| Role | Home screen |
|---|---|
| Admin | `/admin` — dashboard, AI chat (preview shell), settings |
| Team Lead | `/team` |
| Canvasser | `/canvass` |
