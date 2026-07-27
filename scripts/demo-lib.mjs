// Shared plumbing for the Demo Campaign scripts.
//
// The three demo-* scripts all need the same four things: secrets, a
// service-role client, bulk SQL, and a SEEDED rng. Everything here was
// duplicated across the older simulate-*.mjs scripts; it lives in one place
// now because demo-setup and demo-simulate have to agree exactly on the world
// they are building (same rng stream = same latent household values).

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..')
export const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const PROJECT_REF = 'whrliwbdxjdcksbvwkrc'

/** KEYS-AND-ACCESS.md is gitignored, so it exists only in the main checkout.
 *  Walk up so these scripts work from a .claude/worktrees/ worktree too. */
function keysFile() {
  let dir = HERE
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'KEYS-AND-ACCESS.md')
    if (existsSync(p)) return p
    dir = dirname(dir)
  }
  throw new Error('KEYS-AND-ACCESS.md not found walking up from scripts/')
}

export function secret(name) {
  const m = readFileSync(keysFile(), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  if (!m) throw new Error(`${name} not found in KEYS-AND-ACCESS.md`)
  return m[1].trim()
}

export const supa = createClient(SUPABASE_URL, secret('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** These runs make thousands of calls; one dropped socket must not kill a
 *  half-written seed. */
export async function withRetry(label, fn, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await sleep(700 * (i + 1) ** 2)
    }
  }
  throw new Error(`${label}: ${lastErr?.message ?? lastErr}`)
}

/** Bulk SQL via the Management API — one statement instead of hundreds of
 *  REST round trips. Also the only way to reach auth.* and pg_* tables. */
export async function sql(query) {
  return withRetry('management sql', async () => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret('SUPABASE_ACCESS_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 400)}`)
    return res.json()
  })
}

/** PostgREST caps every response at 1000 rows no matter the .limit() asked
 *  for (see CLAUDE.md). Any whole-set read has to page, and the builder MUST
 *  carry a stable .order() or rows repeat across page boundaries. */
export async function fetchAll(table, cols, tweak) {
  const rows = []
  const page = 1000
  for (let from = 0; ; from += page) {
    let q = supa.from(table).select(cols).order('id').range(from, from + page - 1)
    if (tweak) q = tweak(q)
    const { data, error } = await withRetry(`fetch ${table}`, async () => {
      const r = await q
      if (r.error) throw new Error(r.error.message)
      return r
    })
    rows.push(...data)
    if (data.length < page) break
  }
  return rows
}

export async function insertChunked(table, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    await withRetry(`insert ${table} @${i}`, async () => {
      const { error } = await supa.from(table).insert(rows.slice(i, i + chunk))
      if (error) throw new Error(error.message)
    })
  }
}

// ------------------------------------------------------------------ rng
//
// Seeded and deterministic ON PURPOSE. The history seeder and the day
// advancer both derive each household's latent support and at-home values
// from the same stream, so re-running either has to reproduce the same world
// — otherwise a door that was "hard to catch at home" yesterday becomes easy
// today for no reason, and the attempt curve stops meaning anything.

export function makeRng(seed = 0x2ec3a7d1) {
  let s = seed | 0
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return rand
}

/** A stable 32-bit hash, so a household's latent values can be derived from
 *  its uuid rather than from position in a list — the list order changes
 *  between runs, the uuid does not. */
export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic uniform in [0,1) for (id, salt) — the workhorse for latent
 *  per-door properties. */
export function hashUnit(id, salt) {
  return hash32(`${salt}:${id}`) / 4294967296
}

/** Box-Muller from a uniform source. */
export function normal(rand, mean = 0, sd = 1) {
  const u = Math.max(1e-9, rand())
  const v = rand()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

export function shuffle(arr, rand) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)]

// ------------------------------------------------------------------ dates
//
// Everything user-visible in this app is LOCAL time (squad_date is a
// client-local day; the knock-context trigger hardcodes America/New_York).
// Building dates from split components avoids the classic
// new Date('2026-09-12') === UTC-midnight bug that lands on the wrong day in
// every US timezone.

export const OHIO_TZ = 'America/New_York'

export function localDayString(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function dayStringToDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(dayString, n) {
  const d = dayStringToDate(dayString)
  d.setDate(d.getDate() + n)
  return localDayString(d)
}

export function daysBetween(a, b) {
  return Math.round((dayStringToDate(b) - dayStringToDate(a)) / 86_400_000)
}

/** Local wall-clock timestamp on a given day, as an ISO string. */
export function atHour(dayString, hour, minute = 0) {
  const d = dayStringToDate(dayString)
  d.setHours(Math.floor(hour), Math.floor(minute), Math.floor((minute % 1) * 60), 0)
  return d.toISOString()
}

export const DOW = (dayString) => dayStringToDate(dayString).getDay() // 0=Sun

// ------------------------------------------------------------------ demo config

export const DEMO_CAMPAIGN_NAME = 'Demo Campaign'
export const DEMO_CITY = 'Marysville'
export const DEMO_TEAM_NAME = 'Marysville Field'

/** Refuse to write generated activity into a campaign that is not flagged
 *  is_demo. This is the entire reason that column exists. */
export async function requireDemoCampaign() {
  const { data, error } = await supa
    .from('campaigns')
    .select('id, name, is_demo, signature_goal, deadline')
    .eq('name', DEMO_CAMPAIGN_NAME)
    .maybeSingle()
  if (error) throw new Error(`campaign lookup: ${error.message}`)
  if (!data) throw new Error(`No campaign named "${DEMO_CAMPAIGN_NAME}" — run: node scripts/demo-setup.mjs`)
  if (!data.is_demo) throw new Error(`"${DEMO_CAMPAIGN_NAME}" is not flagged is_demo. Refusing to write generated activity.`)
  return data
}
