// Move the demo's history forward in time so it reads as current.
//
//   node scripts/shift-demo-era.mjs --days 42 --before 2026-09-17 [--deadline 2026-12-12] [--dry-run]
//
// The live database holds a simulated campaign (see the sim bullets in
// CLAUDE.md) whose dates were real when it was seeded and go stale from then
// on: left alone, every screen reads as a campaign that ended weeks ago (empty
// feed, flat 7-day charts, a passed deadline). Before a demo, shift it.
//
// What it does, in one transaction through the Management API:
//   - adds --days to every event timestamp/date on the tables listed below,
//     but ONLY for rows dated before --before. Everything on or after that
//     date is treated as real, current activity and left alone; pick a date
//     just past the end of the era you are moving.
//   - sets campaigns.deadline to --deadline when given (a shifted deadline
//     is rarely what you want; a date a few weeks out usually is).
//
// Rules worth keeping:
//   - Use a multiple of 7. The sim has weekend peaks and the Odds tab fits a
//     weekday/weekend grid; a shift that is not whole weeks moves Saturdays
//     onto Wednesdays and both quietly go wrong.
//   - Never let anything land in the future. The script refuses to run when
//     the shift would put the newest moved knock past now().
//   - knock_logs' squad_name/turf_name stamps are snapshots and need nothing.
//     The BEFORE INSERT stamp trigger does not fire on UPDATE.
//   - Structural rows (addresses, persons, teams, campaigns.created_at,
//     settings singletons) are not events and are not touched.
//   - It is reversible: run it again with a negative --days and the same
//     --before, as long as nothing new was added in between.
//
// Reads SUPABASE_ACCESS_TOKEN from KEYS-AND-ACCESS.md (walks up from scripts/
// so it works from a worktree). Never prints the token.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_REF = 'whrliwbdxjdcksbvwkrc'

// table -> [timestamptz columns], [date columns]. The guard column (first
// timestamptz, or the first date when there is none) decides which rows move.
const TABLES = {
  knock_logs: { ts: ['occurred_at', 'created_at'] },
  squads: { ts: ['created_at'], d: ['squad_date'], guard: 'squad_date' },
  squad_members: { ts: ['joined_at'] },
  turfs: { ts: ['created_at', 'updated_at'] },
  turf_segments: { ts: ['created_at'] },
  turf_assignments: { ts: ['created_at'], d: ['assigned_on'] },
  appointments: { ts: ['created_at', 'updated_at', 'starts_at', 'ends_at'] },
  bulletins: { ts: ['created_at'] },
  chats: { ts: ['created_at'] },
  chat_members: { ts: ['joined_at'] },
  chat_messages: { ts: ['created_at'] },
  chat_reads: { ts: ['last_read_at'] },
  message_reactions: { ts: ['created_at'] },
  volunteer_interest: { ts: ['created_at'] },
  ai_chats: { ts: ['created_at', 'updated_at'] },
  ai_chat_messages: { ts: ['created_at'] },
  campaign_members: { ts: ['joined_at'] },
  profiles: { ts: ['created_at', 'updated_at'] },
  member_phones: { ts: ['updated_at'] },
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const days = Number(arg('days'))
const before = arg('before')
const deadline = arg('deadline', null)
const dryRun = process.argv.includes('--dry-run')

if (!Number.isInteger(days) || days === 0) die('--days must be a non-zero whole number of days')
if (days % 7 !== 0) die(`--days must be a multiple of 7 to keep weekdays on weekdays (got ${days})`)
if (!/^\d{4}-\d{2}-\d{2}$/.test(before ?? '')) die('--before must be a YYYY-MM-DD date')
if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) die('--deadline must be a YYYY-MM-DD date')

function die(msg) {
  console.error(msg)
  process.exit(1)
}

function findKeysFile() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'KEYS-AND-ACCESS.md')
    if (fs.existsSync(p)) return p
    dir = path.dirname(dir)
  }
  die('KEYS-AND-ACCESS.md not found walking up from scripts/')
}
const token = fs.readFileSync(findKeysFile(), 'utf8').match(/^SUPABASE_ACCESS_TOKEN=(\S+)/m)?.[1]
if (!token) die('No SUPABASE_ACCESS_TOKEN line in KEYS-AND-ACCESS.md')

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await r.json().catch(() => null)
  if (!r.ok) die(`SQL failed (${r.status}): ${JSON.stringify(body).slice(0, 400)}`)
  return body
}

const interval = `interval '${days} days'`
const statements = []
for (const [table, cols] of Object.entries(TABLES)) {
  const sets = [
    ...(cols.ts ?? []).map((c) => `${c} = ${c} + ${interval}`),
    ...(cols.d ?? []).map((c) => `${c} = ${c} + ${days}`),
  ]
  const guard = cols.guard ?? cols.ts?.[0] ?? cols.d?.[0]
  statements.push(`update ${table} set ${sets.join(', ')} where ${guard} < '${before}'`)
}
if (deadline) statements.push(`update campaigns set deadline = '${deadline}' where deadline is not null`)

// Refuse to put anything in the future.
const [probe] = await sql(
  `select max(occurred_at) + ${interval} as newest_after, count(*) as moving from knock_logs where occurred_at < '${before}'`,
)
if (probe.newest_after && new Date(probe.newest_after) > new Date()) {
  die(`Refusing: the newest moved knock would land at ${probe.newest_after}, which is in the future.`)
}
console.log(`Moving ${probe.moving} knocks (and the matching squads, turfs, chats…) by ${days} days; newest lands ${probe.newest_after}.`)

if (dryRun) {
  console.log(statements.join(';\n') + ';')
  process.exit(0)
}

await sql(['begin', ...statements, 'commit'].join(';\n') + ';')

const [after] = await sql(`select
  (select min(occurred_at) from knock_logs) first_knock,
  (select max(occurred_at) from knock_logs) last_knock,
  (select count(*) from knock_logs where occurred_at > now()) future_knocks,
  (select max(squad_date) from squads) last_squad,
  (select max(created_at) from turfs) last_turf,
  (select deadline from campaigns order by created_at limit 1) deadline,
  (select count(*) from knock_logs where occurred_at >= now() - interval '7 days') knocks_7d,
  (select count(*) from knock_logs where occurred_at >= now() - interval '30 days') knocks_30d`)
console.log(after)
