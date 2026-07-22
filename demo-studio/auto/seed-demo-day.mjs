// Seed "today" for the demo video: a real squad on the Triple Crown Way turf
// with a morning of knocks, all written through the sim accounts' own
// authenticated sessions (RLS-respecting) — no service-role writes.
//
// Reads the shared sim password from gitignored SIM-USERS.md and the service
// key (READS ONLY: planning which doors/persons to use) from KEYS-AND-ACCESS.md.
// Writes demo-studio/auto/demo-plan.json for the recorder (door ids, cue door).
//
// Usage: node demo-studio/auto/seed-demo-day.mjs [--wipe]
//   --wipe removes today's seeded knocks + the squad + the sub-turfs it made.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const ANON_KEY = 'sb_publishable_JcZe2JFmhQGFK_Mddet4EA_IWZw4727'
const PLAN_PATH = join(HERE, 'demo-plan.json')
const TURF_ID = '068b838a-7782-4e21-ad41-399dee9e0bbf' // Marysville · Triple Crown Way
const SQUAD_NAME = 'Triple Crown Crew'

function fileSecret(file, name) {
  const txt = readFileSync(join(REPO, file), 'utf8')
  const m = txt.match(new RegExp(`^${name}=(.+)$`, 'm'))
  if (!m) throw new Error(`${name} not found in ${file}`)
  return m[1].trim()
}
const simPassword = () => {
  const txt = readFileSync(join(REPO, 'SIM-USERS.md'), 'utf8')
  const m = txt.match(/one password: `([^`]+)`/)
  if (!m) throw new Error('sim password not found')
  return m[1]
}

const service = createClient(SUPABASE_URL, fileSecret('KEYS-AND-ACCESS.md', 'SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function loginAs(handle) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email: `${handle}@example.com`,
    password: simPassword(),
  })
  if (error) throw new Error(`login ${handle}: ${error.message}`)
  return { client, userId: data.user.id }
}

const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------- wipe

if (process.argv.includes('--wipe')) {
  if (!existsSync(PLAN_PATH)) throw new Error('no demo-plan.json to wipe from')
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'))
  // Knocks: delete by client_id as each owner
  for (const [handle, ids] of Object.entries(plan.knockClientIdsByHandle)) {
    const { client } = await loginAs(handle)
    for (const cid of ids) await client.from('knock_logs').delete().eq('client_id', cid)
    await client.auth.signOut()
    console.log(`wiped ${ids.length} knocks for ${handle}`)
  }
  // Sub-turfs created by assign-doors takes (service delete OK? no — use opal via RLS)
  const { client: opal } = await loginAs('opal-pruitt')
  const { data: subs } = await opal.from('turfs').select('id,name').eq('parent_turf_id', plan.turfId)
  for (const s of subs ?? []) {
    await opal.from('turfs').delete().eq('id', s.id)
    console.log(`deleted sub-turf ${s.name}`)
  }
  // Un-dispatch the turf, delete the squad (creator can? squads RLS — try opal)
  const { client: miles } = await loginAs('miles-nakamura')
  await miles.from('turfs').update({ squad_id: null }).eq('id', plan.turfId)
  const { error: sqErr } = await miles.from('squads').delete().eq('id', plan.squadId)
  console.log('squad delete:', sqErr?.message ?? 'ok')
  await opal.auth.signOut(); await miles.auth.signOut()
  console.log('wipe done')
  process.exit(0)
}

// ---------------------------------------------------------------- plan doors

const { data: doors } = await service
  .from('addresses')
  .select('id, street, lat, lng, persons(id, name)')
  .eq('turf_id', TURF_ID)
  .order('street')
if (!doors?.length) throw new Error('no turf doors found')

const streetOf = (s) => s.replace(/^\d+\s*/, '')
const numOf = (s) => parseInt(s, 10) || 0
const geocoded = doors.filter((d) => d.lat != null)
const byStreet = new Map()
for (const d of geocoded) {
  const st = streetOf(d.street)
  if (!byStreet.has(st)) byStreet.set(st, [])
  byStreet.get(st).push(d)
}
for (const list of byStreet.values()) list.sort((a, b) => numOf(a.street) - numOf(b.street))

const take = (streets, n) => {
  const out = []
  for (const st of streets) for (const d of byStreet.get(st) ?? []) {
    if (out.length >= n) break
    out.push(d)
  }
  return out.slice(0, n)
}

// BROOKSTONE DR is reserved for on-camera work (stays blue).
// Kayla works TRIPLE CROWN WAY but leaves the last few doors — one of them
// (preferably a 1-2 person household) becomes the live on-camera knock.
const tcw = byStreet.get('TRIPLE CROWN WAY') ?? []
const kaylaDoors = tcw.slice(0, Math.max(0, tcw.length - 3)).slice(0, 17)
const cueCandidates = tcw.slice(Math.max(0, tcw.length - 3))
const cueDoor = cueCandidates.find((d) => (d.persons?.length ?? 0) === 1) ?? cueCandidates[0]
if (!cueDoor) throw new Error('no cue door available on Triple Crown Way')

const tobiasDoors = take(['LOMBARD DR', 'ECHO DR', 'GLEN ELLYN DR'], 18) // last knock lands on Glen Ellyn
const opalDoors = take(['SADDLEHORN WAY', 'PONY PL', 'BOBTAIL LN'], 15)

// ---------------------------------------------------------------- squad + dispatch

const today = localToday()
const { client: opal, userId: opalId } = await loginAs('opal-pruitt')
const { client: tobias, userId: tobiasId } = await loginAs('tobias-lang')
const { client: kayla, userId: kaylaId } = await loginAs('kayla-thorne')
const { client: miles } = await loginAs('miles-nakamura')

// Reuse an existing squad of the same name today (idempotent-ish re-runs)
let squadId = null
{
  const { data: existing } = await opal
    .from('squads').select('id').eq('name', SQUAD_NAME).eq('squad_date', today).maybeSingle()
  squadId = existing?.id ?? null
}
if (!squadId) {
  const { data, error } = await opal.rpc('create_squad', {
    squad_name: SQUAD_NAME,
    member_ids: [tobiasId, kaylaId],
    squad_day: today,
  })
  if (error) throw new Error(`create_squad: ${error.message}`)
  squadId = data
  console.log('created squad', squadId)
} else console.log('reusing squad', squadId)

{
  const { error } = await miles.from('turfs')
    .update({ squad_id: squadId, assignee_id: null, updated_at: new Date().toISOString() })
    .eq('id', TURF_ID)
  if (error) throw new Error(`dispatch: ${error.message}`)
  console.log('dispatched Triple Crown Way turf to squad')
}

// Light theme for a consistent camera look (cosmetic, self-write)
for (const [c] of [[opal], [tobias], [kayla], [miles]]) {
  await c.from('profiles').update({ theme: { scheme: 'light' } }).eq('id', (await c.auth.getUser()).data.user.id)
}

// ---------------------------------------------------------------- knocks

// Outcome script per member: mostly one row per door; signed needs a person.
function planKnocks(doorList, startHourMin, rng) {
  const rows = []
  let t = startHourMin // minutes since local midnight
  for (const d of doorList) {
    t += 4 + Math.floor(rng() * 6)
    const persons = d.persons ?? []
    const r = rng()
    let outcome, person_id = null, notes = null
    if (r < 0.36 && persons.length) { outcome = 'signed'; person_id = persons[0].id }
    else if (r < 0.5 && persons.length) { outcome = 'didnt_sign'; person_id = persons[0].id }
    else if (r < 0.6 && persons.length) { outcome = 'maybe'; person_id = persons[0].id; if (rng() < 0.4) notes = 'Come back after 6' }
    else { outcome = 'not_home'; if (rng() < 0.15) notes = 'Left lit drop' }
    rows.push({ door: d, outcome, person_id, notes, minutes: t })
    // A spouse signs during the same visit sometimes
    if (outcome === 'signed' && persons.length >= 2 && rng() < 0.35) {
      rows.push({ door: d, outcome: 'signed', person_id: persons[1].id, notes: null, minutes: t + 1 })
    }
  }
  return rows
}

let seed = 42
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
const at = (minutes) => new Date(midnight.getTime() + minutes * 60000).toISOString()

const plans = [
  { handle: 'opal-pruitt', client: opal, userId: opalId, rows: planKnocks(opalDoors, 9 * 60 + 40, rng) },
  { handle: 'kayla-thorne', client: kayla, userId: kaylaId, rows: planKnocks(kaylaDoors, 9 * 60 + 50, rng) },
  { handle: 'tobias-lang', client: tobias, userId: tobiasId, rows: planKnocks(tobiasDoors, 10 * 60, rng) },
]

const knockClientIdsByHandle = {}
for (const p of plans) {
  const ids = []
  for (const row of p.rows) {
    const client_id = randomUUID()
    const { error } = await p.client.from('knock_logs').upsert({
      client_id,
      person_id: row.person_id,
      household_id: row.door.id,
      canvasser_id: p.userId,
      occurred_at: at(row.minutes),
      outcome: row.outcome,
      notes: row.notes,
    }, { onConflict: 'client_id' })
    if (error) throw new Error(`knock as ${p.handle}: ${error.message}`)
    ids.push(client_id)
  }
  knockClientIdsByHandle[p.handle] = ids
  console.log(`${p.handle}: ${ids.length} knocks (${p.rows.filter(r => r.outcome === 'signed').length} signed)`)
}

// ---------------------------------------------------------------- plan file

writeFileSync(PLAN_PATH, JSON.stringify({
  createdAt: new Date().toISOString(),
  today,
  turfId: TURF_ID,
  squadId,
  squadName: SQUAD_NAME,
  members: { opal: opalId, tobias: tobiasId, kayla: kaylaId },
  cueDoor: { id: cueDoor.id, street: cueDoor.street, lat: cueDoor.lat, lng: cueDoor.lng, personId: cueDoor.persons?.[0]?.id ?? null, personName: cueDoor.persons?.[0]?.name ?? null },
  talkDoor: { street: '1175 BROOKSTONE DR' },
  knockClientIdsByHandle,
}, null, 2))
console.log('wrote demo-plan.json — cue door:', cueDoor.street, `(${cueDoor.persons?.length ?? 0} residents)`)

for (const c of [opal, tobias, kayla, miles]) await c.auth.signOut()
console.log('seed done')
