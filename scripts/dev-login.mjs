/**
 * Sign the LOCAL dev server in as a throwaway campaign-manager test account,
 * without a password existing anywhere.
 *
 * Why this exists: every screen worth looking at is behind a login, and an
 * agent working on this repo will not type a password into a login form. That
 * left "spin up `npm run dev` and LOOK at it" (the standing testing rule in
 * CLAUDE.md) impossible for anything past the sign-in screen. This closes that
 * gap without introducing a credential anybody has to handle.
 *
 * How it works, and why it can't help an attacker:
 *   1. `claudetest@example.com` is created through the GoTrue admin API with
 *      NO PASSWORD AT ALL. There is nothing to type, guess, or leak — password
 *      sign-in for this account fails on every deployment, including the live
 *      site. It is a campaign_manager, never an admin: enough for /admin/chat,
 *      /admin/analytics and the rest of the manager screens, not enough to
 *      touch anyone's role.
 *   2. A single-use magic-link token is minted and immediately exchanged for a
 *      session here in Node, so no token is ever printed or pasted anywhere.
 *   3. The session is written into `public/__dev-login.html`, which the page
 *      hands to the app's OWN Supabase client via `setSession()`. That file is
 *      gitignored and deleted by `--clean` (which also runs at the start of
 *      every invocation, so a stale one can't survive a crash).
 *
 * It is LOCAL-ONLY by construction, not by policy: the bootstrap page imports
 * `/src/lib/supabase.ts`, a path only Vite's dev server serves. Dropped onto
 * the built site it does nothing — there is no `/src` to import.
 *
 * Secrets are read out of the gitignored KEYS-AND-ACCESS.md inside this
 * script, never passed on a command line.
 *
 *   node scripts/dev-login.mjs 43314     # port that `npm run dev` reported
 *   node scripts/dev-login.mjs --clean   # remove the bootstrap page
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOOTSTRAP = join(ROOT, 'public', '__dev-login.html')
const USERNAME = 'claudetest'
const EMAIL = `${USERNAME}@example.com`

// The bootstrap page never outlives the login it performs.
rmSync(BOOTSTRAP, { force: true })
if (process.argv.includes('--clean')) {
  console.log('Removed public/__dev-login.html')
  process.exit(0)
}

const port = process.argv[2]
if (!port || !/^\d+$/.test(port)) {
  console.error('Usage: node scripts/dev-login.mjs <dev-server-port>')
  process.exit(1)
}

/** KEYS-AND-ACCESS.md is gitignored, so it exists only in the main checkout —
 * a git worktree under .claude/worktrees/ won't have its own copy. Walk up. */
function findKeysFile(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'KEYS-AND-ACCESS.md')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) throw new Error('KEYS-AND-ACCESS.md not found in any parent directory')
  }
}

const keys = readFileSync(findKeysFile(ROOT), 'utf8')
const serviceKey = keys.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*(\S+)/)?.[1]
if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not found in KEYS-AND-ACCESS.md')

const config = readFileSync(join(ROOT, 'src', 'lib', 'config.ts'), 'utf8')
const url = config.match(/VITE_SUPABASE_URL \?\? '([^']+)'/)?.[1]
const anonKey = config.match(/VITE_SUPABASE_ANON_KEY \?\? '([^']+)'/)?.[1]
if (!url || !anonKey) throw new Error('Could not read SUPABASE_URL / ANON_KEY from src/lib/config.ts')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

// --- 1. The account, created once and reused thereafter ---------------------
// No `password` field: GoTrue creates a passwordless user, so there is no
// credential in existence for this identity. email_confirm skips the
// confirmation mail that would bounce off the reserved example.com domain.
let { data: created, error: createErr } = await admin.auth.admin.createUser({
  email: EMAIL,
  email_confirm: true,
  user_metadata: { username: USERNAME },
})
if (createErr && !/already/i.test(createErr.message)) throw new Error(createErr.message)

let userId = created?.user?.id
if (!userId) {
  const { data: found } = await admin.from('profiles').select('id').eq('username', USERNAME).maybeSingle()
  userId = found?.id
}
if (!userId) throw new Error('Could not resolve the test account')

// --- 2. Campaign manager, on a campaign -------------------------------------
// Both halves are needed or the router parks the account on /join-campaign
// forever: `campaign_members` is the roster, `profiles.campaign_id` is the one
// you're currently working, and the gate (auth store `needsCampaign`) reads
// the profile column. auth.uid() is null under the service role, and
// guard_profile_privileges() only blocks role/team/username changes made by a
// signed-in non-admin, so this update is allowed.
const { data: campaign } = await admin.from('campaigns').select('id, name').limit(1).maybeSingle()
if (campaign) {
  const { error: joinErr } = await admin
    .from('campaign_members')
    .upsert({ campaign_id: campaign.id, user_id: userId }, { onConflict: 'campaign_id,user_id' })
  if (joinErr) throw new Error(`Joining the campaign failed: ${joinErr.message}`)
}

const { error: roleErr } = await admin
  .from('profiles')
  .update({
    role: 'campaign_manager',
    display_name: 'Claude (test)',
    ...(campaign ? { campaign_id: campaign.id } : {}),
  })
  .eq('id', userId)
if (roleErr) throw new Error(`Setting the role failed: ${roleErr.message}`)

// --- 3. One-time magic-link token, exchanged for a session right here -------
const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email: EMAIL,
})
if (linkErr) throw new Error(`Minting the link failed: ${linkErr.message}`)

const anon = createClient(url, anonKey, { auth: { persistSession: false } })
const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
  token_hash: link.properties.hashed_token,
  type: 'magiclink',
})
if (verifyErr) throw new Error(`Exchanging the link failed: ${verifyErr.message}`)
const session = verified.session
if (!session) throw new Error('No session came back from the exchange')

// --- 4. Hand it to the app's own client -------------------------------------
// setSession() rather than a hand-written localStorage key: supabase-js has
// changed that storage format before, and it owns it.
writeFileSync(
  BOOTSTRAP,
  `<!doctype html><meta charset="utf-8"><title>dev login</title>
<body style="font:16px system-ui;padding:2rem">Signing in…<script type="module">
const { supabase } = await import('/src/lib/supabase.ts')
const { error } = await supabase.auth.setSession(${JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })})
document.body.textContent = error ? 'Failed: ' + error.message : 'Signed in.'
if (!error) location.replace('/admin/chat')
</script>`,
  'utf8',
)

console.log(`Signed in as ${USERNAME} (campaign_manager${campaign ? `, ${campaign.name}` : ''}).`)
console.log(`Open  http://localhost:${port}/__dev-login.html`)
console.log('Then: node scripts/dev-login.mjs --clean')
