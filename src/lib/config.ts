// Public-safe configuration. These keys are publishable by design
// (Supabase access is controlled by RLS; the Maps key is a demo key).
// Env vars override the defaults so Netlify/local can swap values without code changes.

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://whrliwbdxjdcksbvwkrc.supabase.co'

export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_JcZe2JFmhQGFK_Mddet4EA_IWZw4727'

export const GOOGLE_MAPS_API_KEY =
  import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? 'AIzaSyAQ2t13RtoidSYWPNJmL5R5PVQDzJvZtOs'

// Usernames are presented to users; Supabase Auth requires an email underneath.
// example.com is RFC-reserved (never deliverable) AND passes Supabase's email
// validation — fake TLDs like .local are rejected with "email_address_invalid".
export const AUTH_EMAIL_DOMAIN = 'example.com'

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}
