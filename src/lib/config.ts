// Public-safe configuration. The Supabase URL/anon key are publishable by
// design (access is controlled by RLS). The Maps key has no hardcoded
// fallback — even though it's a client-exposed key restricted at Google's
// end, not a real secret, keeping the literal value out of source avoids
// tripping Netlify's build-time secret scanner once it's also set as an env
// var. Set VITE_GOOGLE_MAPS_API_KEY locally (.env) and on Netlify.

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://whrliwbdxjdcksbvwkrc.supabase.co'

export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_JcZe2JFmhQGFK_Mddet4EA_IWZw4727'

export const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? ''

// Usernames are presented to users; Supabase Auth requires an email underneath.
// example.com is RFC-reserved (never deliverable) AND passes Supabase's email
// validation — fake TLDs like .local are rejected with "email_address_invalid".
export const AUTH_EMAIL_DOMAIN = 'example.com'

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}
