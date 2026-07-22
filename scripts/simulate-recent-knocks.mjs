// Continue the simulated canvassing history up to the present day.
//
// The main sim (simulate-canvass-history.mjs) seeded a month ending
// 2026-07-12; run weeks later, the demo showed a hard cliff — tons of knocks
// "back then", nothing recent. This script picks the story back up from
// 2026-07-13 through yesterday (plus today's evening shift, if it's already
// evening in Ohio when you run it) at a believable steady-state pace: fewer
// crews per day than launch month, a heavier revisit share, fresh doors
// pulled from the never-worked backlog turfs.
//
// How it stays consistent with the original model:
//   - Household state is rebuilt from the live knock_logs: signed/refused
//     people are never re-asked, skip/hostile doors stay closed forever,
//     maybes get followed up with the same boosted close rate.
//   - Street-level support is estimated from each street's actual outcomes
//     (shrunk toward the original zone priors by city), so new knocks land
//     with the same geographic signal the analytics already show.
//   - Squads/members insert first, then knocks: the stamp_knock_context
//     trigger fills squad_*/turf_* automatically, exactly like real app use.
//   - Turf dispatch: worked turfs get turf_assignments history rows per day,
//     and the LAST day is applied as a real turfs.squad_id update so the
//     trigger writes that row itself (same pattern as the turf sim).
//
// Geocoding (small, bounded spend): fresh doors come from backlog turfs that
// were cut but never geocoded. Doors in the turfs this run works get
// geocoded first (cap GEOCODE_CAP, ~$5/1000 calls) so the new activity shows
// up as pins on Scout/Squad/Turf maps.
//
// Wipe story: new squad ids are appended to sim-manifest.json (the main
// script's --wipe deletes squads by id and knocks by canvasser); the
// turf_assignments rows cascade off the sim turfs already in the manifest.
// Geocoded coordinates are real facts about real addresses and stay.
//
// Usage (from repo root — hits the LIVE database on a real run):
//   node scripts/simulate-recent-knocks.mjs --dry-run   # plan + stats, no writes
//   node scripts/simulate-recent-knocks.mjs             # geocode, insert, dispatch

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const MANIFEST_PATH = join(REPO_ROOT, 'sim-manifest.json')

const dryRun = process.argv.includes('--dry-run')

const START_DAY = '2026-07-13' // the day after the original sim ended
const GEOCODE_CAP = 600 // ≈ $3 at $5/1000 — "a small amount"
const TZ = 'America/New_York'
const TZ_OFFSET_MIN = 4 * 60 // EDT in July, same fixed offset the other sims use
const DAY_MS = 86_400_000

// ---------------------------------------------------------------- secrets

function secret(name) {
  const keys = readFileSync(join(REPO_ROOT, 'KEYS-AND-ACCESS.md'), 'utf8')
  const m = keys.match(new RegExp(`^${name}=(.+)$`, 'm'))
  if (!m) throw new Error(`${name} not found in KEYS-AND-ACCESS.md`)
  return m[1].trim()
}

/** The server-side (unrestricted) Maps key lives in Netlify env, not the
 * KEYS file — pull it via the CLI; fall back to the restricted key. */
function geocodeKey() {
  try {
    const out = execSync('netlify env:get GOOGLE_MAPS_API_KEY', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const val = lines[lines.length - 1]
    if (val && /^AIza[\w-]+$/.test(val)) return val
  } catch {
    // CLI unavailable — fall through
  }
  return secret('GOOGLE_MAPS_API_KEY_RESTRICTED')
}

const supa = createClient(SUPABASE_URL, secret('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function fetchAll(table, cols) {
  const rows = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await supa.from(table).select(cols).order('id').range(from, from + page - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < page) break
  }
  return rows
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Transient-network retry (the run makes thousands of calls; one dropped
 * socket must not kill a half-written seed). */
async function withRetry(label, fn, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      await sleep(800 * (i + 1) ** 2)
    }
  }
  throw new Error(`${label}: ${lastErr?.message ?? lastErr}`)
}

async function insertChunked(table, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    await withRetry(`insert ${table} @${i}`, async () => {
      const { error } = await supa.from(table).insert(rows.slice(i, i + chunk))
      if (error) throw new Error(error.message)
    })
  }
}

/** Bulk SQL (the geocode coordinate write-back) via the Management API —
 * one statement per chunk instead of hundreds of REST round trips. */
async function managementSql(query) {
  return withRetry('management sql', async () => {
    const res = await fetch('https://api.supabase.com/v1/projects/whrliwbdxjdcksbvwkrc/database/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret('SUPABASE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
    return res.json()
  })
}

// ---------------------------------------------------------------- seeded RNG

let rngState = 0x2ec3a7d1
function rand() {
  rngState |= 0
  rngState = (rngState + 0x6d2b79f5) | 0
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
function randn(mean = 0, sd = 1) {
  const u = Math.max(rand(), 1e-9)
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// ---------------------------------------------------------------- dates

const localTime = (dayIso, minutes) =>
  new Date(Date.parse(`${dayIso}T00:00:00Z`) + (minutes + TZ_OFFSET_MIN) * 60_000).toISOString()
const dayPlus = (dayIso, n) => new Date(Date.parse(`${dayIso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const weekdayOf = (dayIso) => new Date(`${dayIso}T00:00:00Z`).getUTCDay() // 0 = Sunday

/** Today's date and hour in the campaign's home timezone, from the real clock. */
function nowInOhio() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const get = (type) => parts.find((p) => p.type === type)?.value
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

// ---------------------------------------------------------------- priors

// City-level support/answer priors, matching the original sim's zones (the
// Marysville quadrants collapse to one city-wide prior — street-level
// observed data does the fine-graining now).
const CITY_PRIORS = [
  { cities: ['Richwood', 'Magnetic Springs', 'Broadway', 'Raymond'], support: 0.53, answer: 0.5 },
  { cities: ['Plain City'], support: 0.42, answer: 0.41 },
  { cities: ['Dublin', 'Ostrander', 'Unionville Center', 'Milford Center'], support: 0.31, answer: 0.34 },
]
function priorFor(city) {
  for (const p of CITY_PRIORS) if (p.cities.includes(city)) return p
  return { support: 0.42, answer: 0.42 } // Marysville + anything else
}

const NOTES = {
  not_home: ['left flyer', 'car in driveway, no answer', 'lights on, nobody came', 'doorbell broken maybe'],
  signed: ['enthusiastic, asked about volunteering', 'signed after a good chat', 'took a flyer for the neighbor', 'knew about the initiative already'],
  didnt_sign: ['not interested', 'does not sign petitions on principle', 'wants to read the full text first', 'polite but firm no'],
  maybe: ['come back next week', 'wants to talk to spouse first', 'asked for the website', 'on the fence, leaning yes'],
  hostile: ['told to leave the porch', 'no soliciting sign, very upset', 'door slammed'],
  skip: ['loose dog in yard', 'no trespassing sign', 'house under construction', 'gate locked'],
}
const noteFor = (outcome) => (rand() < 0.09 ? pick(NOTES[outcome]) : null)

// ---------------------------------------------------------------- main

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const simUsers = new Set(manifest.userIds)

  const { day: today, hour: hourNow } = nowInOhio()
  // Evening shifts run ~16:30-19:30 local; only write today's shift once it
  // would plausibly be over.
  const includeToday = hourNow >= 20
  const endDay = includeToday ? today : dayPlus(today, -1)
  if (endDay < START_DAY) throw new Error(`Nothing to simulate: window ${START_DAY} → ${endDay}`)

  console.log(`Window: ${START_DAY} → ${endDay} (Ohio time now: ${today} ${hourNow}:xx${includeToday ? ', including today' : ''})`)

  console.log('Loading profiles, turfs, addresses, persons, knocks…')
  const [profiles, turfRows, addresses, persons, knocks] = await Promise.all([
    fetchAll('profiles', 'id, role, display_name, username'),
    fetchAll('turfs', 'id, name, color, parent_turf_id'),
    fetchAll('addresses', 'id, street, city, zip, lat, lng, turf_id'),
    fetchAll('persons', 'id, household_id'),
    fetchAll('knock_logs', 'id, household_id, person_id, canvasser_id, outcome, occurred_at'),
  ])

  // Refuse to double-seed. A handful of in-window knocks is normal (demo
  // sessions drive sim accounts through Talk mode); hundreds means this
  // script already ran. Either way, doors touched since the window opened
  // are left alone below — seeded history must never contradict them.
  const windowStartUtc = localTime(START_DAY, 0)
  const inWindowSim = knocks.filter((k) => simUsers.has(k.canvasser_id) && k.occurred_at >= windowStartUtc)
  if (inWindowSim.length > 300) {
    throw new Error(`${inWindowSim.length} sim knocks after 2026-07-12 already exist — this script already ran (wipe + reseed everything to redo).`)
  }
  const recentlyTouched = new Set(
    knocks.filter((k) => k.occurred_at >= windowStartUtc && k.household_id).map((k) => k.household_id),
  )
  if (recentlyTouched.size) console.log(`  leaving ${recentlyTouched.size} doors alone (knocked after ${START_DAY} by demo/testing)`)

  const simPeople = profiles.filter((p) => simUsers.has(p.id))
  const leaders = shuffle(simPeople.filter((p) => p.role === 'team_lead'))
  const canvassers = simPeople.filter((p) => p.role === 'canvasser')
  const cms = simPeople.filter((p) => p.role === 'campaign_manager')
  if (!leaders.length || !canvassers.length || !cms.length) throw new Error('Sim staff missing — did the main sim run?')
  const firstName = (p) => (p.display_name ?? p.username).split(' ')[0]

  // ---------------- rebuild household state from the live history
  const personsByHouse = new Map()
  for (const p of persons) {
    if (!p.household_id) continue
    if (!personsByHouse.has(p.household_id)) personsByHouse.set(p.household_id, [])
    personsByHouse.get(p.household_id).push(p)
  }

  const addrById = new Map(addresses.map((a) => [a.id, a]))
  const knocksByHouse = new Map()
  for (const k of knocks) {
    if (!k.household_id) continue
    if (!knocksByHouse.has(k.household_id)) knocksByHouse.set(k.household_id, [])
    knocksByHouse.get(k.household_id).push(k)
  }

  // street key (same city|name grouping as the other sims) + support stats
  const streetKeyOf = (a) => {
    const m = a.street.match(/^(\d+)\s+(.+)$/)
    return `${a.city}|${m ? m[2] : a.street}`
  }
  const houseNumOf = (a) => {
    const m = a.street.match(/^(\d+)\s/)
    return m ? Number(m[1]) : 0
  }

  const streetStats = new Map() // key -> {signed, refused, maybe}
  const households = new Map() // id -> state
  for (const [hid, hk] of knocksByHouse) {
    hk.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    const roster = personsByHouse.get(hid) ?? []
    const personState = new Map() // person_id -> signed | refused | maybe
    let closed = false
    let notHomes = 0
    for (const k of hk) {
      if (k.outcome === 'skip' || k.outcome === 'hostile') closed = true
      if (k.outcome === 'not_home') notHomes++
      if (!k.person_id) continue
      if (k.outcome === 'signed') personState.set(k.person_id, 'signed')
      else if (k.outcome === 'didnt_sign') personState.set(k.person_id, 'refused')
      else if (k.outcome === 'maybe' && personState.get(k.person_id) !== 'signed') personState.set(k.person_id, 'maybe')
    }
    const states = roster.map((p) => personState.get(p.id) ?? 'unresolved')
    const anyOpen = states.some((s) => s === 'unresolved' || s === 'maybe')
    // A door that never answered in 4+ tries was given up on by the original
    // model; honor that.
    if (hk.length >= 4 && hk.every((k) => k.outcome === 'not_home')) closed = true
    households.set(hid, {
      id: hid,
      attempts: hk.length,
      priorNotHomes: notHomes,
      closed: closed || roster.length === 0 || !anyOpen || recentlyTouched.has(hid),
      persons: roster.map((p) => ({ id: p.id, state: personState.get(p.id) ?? 'unresolved' })),
      maybePersonId: roster.find((p) => personState.get(p.id) === 'maybe')?.id ?? null,
      nextRetryAt: 0, // it's been over a week since the original month — all due
    })
    const a = addrById.get(hid)
    if (a) {
      const key = streetKeyOf(a)
      const st = streetStats.get(key) ?? { signed: 0, refused: 0, maybe: 0 }
      for (const s of states) {
        if (s === 'signed') st.signed++
        else if (s === 'refused') st.refused++
        else if (s === 'maybe') st.maybe++
      }
      streetStats.set(key, st)
    }
  }

  /** Street support: observed outcomes shrunk toward the city prior. */
  function streetSupport(a) {
    const prior = priorFor(a.city).support
    const st = streetStats.get(streetKeyOf(a))
    if (!st) return prior
    const n = st.signed + st.refused + st.maybe
    if (!n) return prior
    const obs = (st.signed + 0.5 * st.maybe) / n
    const K = 6
    return clamp((obs * n + prior * K) / (n + K), 0.05, 0.9)
  }

  // ---------------- rank turfs by remaining work, pick this fortnight's set
  const topTurfs = turfRows.filter((t) => !t.parent_turf_id)
  const turfDoors = new Map(topTurfs.map((t) => [t.id, []]))
  for (const a of addresses) {
    if (a.turf_id && turfDoors.has(a.turf_id)) turfDoors.get(a.turf_id).push(a)
  }

  const turfPlans = topTurfs
    .map((t) => {
      const doors = turfDoors.get(t.id)
      let fresh = 0
      let revisit = 0
      for (const a of doors) {
        const h = households.get(a.id)
        if (!h) {
          if ((personsByHouse.get(a.id) ?? []).length) fresh++
        } else if (!h.closed && h.attempts < 5) {
          revisit++
        }
      }
      return { turf: t, doors, fresh, revisit, open: fresh + revisit }
    })
    .sort((a, b) => b.open - a.open)

  const workedSet = turfPlans.slice(0, 6).filter((p) => p.open >= 30)
  console.log('Turfs this run will work:')
  for (const p of workedSet) {
    const unGeo = p.doors.filter((a) => a.lat == null).length
    console.log(`  ${p.turf.name.padEnd(38)} fresh ${String(p.fresh).padStart(4)}  revisit ${String(p.revisit).padStart(4)}  ungeocoded ${unGeo}`)
  }

  // ---------------- geocode the worked turfs' missing coordinates (capped)
  const needGeo = workedSet
    .flatMap((p) => p.doors)
    .filter((a) => a.lat == null)
    .slice(0, GEOCODE_CAP)
  console.log(`Geocoding ${needGeo.length} doors (cap ${GEOCODE_CAP}, ≈$${((needGeo.length * 5) / 1000).toFixed(2)})…`)

  if (!dryRun && needGeo.length) {
    const key = geocodeKey()
    const got = [] // {id, lat, lng}
    let noResult = 0
    let netFail = 0
    let firstError = null
    for (let i = 0; i < needGeo.length; i += 8) {
      const batch = needGeo.slice(i, i + 8)
      await Promise.all(
        batch.map(async (a) => {
          const q = encodeURIComponent(`${a.street}, ${a.city}, OH ${a.zip ?? ''}`.trim())
          try {
            const data = await withRetry('geocode', async () => {
              const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${key}`)
              if (!res.ok) throw new Error(`http ${res.status}`)
              return res.json()
            }, 3)
            const top = data.status === 'OK' ? data.results?.[0] : null
            const type = top?.geometry?.location_type
            if (top && (type === 'ROOFTOP' || type === 'RANGE_INTERPOLATED' || type === 'GEOMETRIC_CENTER')) {
              a.lat = top.geometry.location.lat
              a.lng = top.geometry.location.lng
              got.push({ id: a.id, lat: a.lat, lng: a.lng })
            } else {
              noResult++
              if (!firstError && data.status !== 'OK') firstError = `API status ${data.status}`
            }
          } catch (e) {
            netFail++
            if (!firstError) firstError = e.message
          }
        }),
      )
      if (i && i % 100 < 8) console.log(`  …${i}/${needGeo.length}`)
      await sleep(120) // stay well under the Geocoding API rate limit
    }
    console.log(`  geocoded ${got.length}, no-result ${noResult}, network-failed ${netFail}${firstError ? ` (first error: ${firstError})` : ''}`)
    // Write coordinates back in bulk — a couple of statements, not 600.
    for (let i = 0; i < got.length; i += 200) {
      const values = got
        .slice(i, i + 200)
        .map((g) => `('${g.id}'::uuid, ${g.lat.toFixed(7)}, ${g.lng.toFixed(7)})`)
        .join(', ')
      await managementSql(
        `update public.addresses a set lat = v.lat, lng = v.lng, updated_at = now()
         from (values ${values}) as v(id, lat, lng) where a.id = v.id`,
      )
    }
    if (got.length) console.log(`  coordinates written back (${got.length} doors)`)
  }

  // ---------------- per-turf walk order (streets nearest-neighbor, doors by number)
  for (const plan of workedSet) {
    const byStreet = new Map()
    for (const a of plan.doors) {
      const key = streetKeyOf(a)
      if (!byStreet.has(key)) byStreet.set(key, { key, doors: [], lat: 0, lng: 0, nGeo: 0 })
      const s = byStreet.get(key)
      s.doors.push(a)
      if (a.lat != null) {
        s.lat += a.lat
        s.lng += a.lng
        s.nGeo++
      }
    }
    const streets = [...byStreet.values()]
    for (const s of streets) {
      if (s.nGeo) {
        s.lat /= s.nGeo
        s.lng /= s.nGeo
      } else {
        s.lat = s.lng = null
      }
      s.doors.sort((x, y) => houseNumOf(x) - houseNumOf(y))
    }
    const withGeo = streets.filter((s) => s.lat != null).sort((a, b) => a.lng - b.lng)
    const noGeo = streets.filter((s) => s.lat == null).sort((a, b) => a.key.localeCompare(b.key))
    const ordered = []
    if (withGeo.length) {
      let cur = withGeo.shift()
      ordered.push(cur)
      while (withGeo.length) {
        let best = 0
        let bestD = Infinity
        for (let i = 0; i < withGeo.length; i++) {
          const d = (withGeo[i].lat - cur.lat) ** 2 + (withGeo[i].lng - cur.lng) ** 2
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
        cur = withGeo.splice(best, 1)[0]
        ordered.push(cur)
      }
    }
    ordered.push(...noGeo)
    ordered.forEach((s, i) => s.doors.forEach((d) => {
      d._streetOrder = i
      d._streetKey = s.key
    }))
    plan.walk = ordered.flatMap((s) => s.doors)
    plan.cursor = 0
  }

  // ---------------- simulate the recent days
  const days = []
  for (let d = START_DAY; d <= endDay; d = dayPlus(d, 1)) days.push(d)
  // A couple of weekday rest days keeps the rhythm human.
  const restDays = new Set()
  const weekdayPool = days.filter((d) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6)
  while (restDays.size < Math.min(2, Math.max(0, weekdayPool.length - 3))) restDays.add(pick(weekdayPool))

  // Sticky leader↔turf pairing: leader i works workedSet[i % n] until it dries up.
  const leaderTurf = new Map()
  const claimTurf = (leader) => {
    let plan = leaderTurf.get(leader.id)
    const openIn = (p) => p.walk.length - p.cursor + p.doors.filter((a) => {
      const h = households.get(a.id)
      return h && !h.closed && h.attempts > 0 && h.attempts < 5
    }).length
    if (plan && openIn(plan) > 20) return plan
    const taken = new Set(leaderTurf.values())
    plan = workedSet.find((p) => !taken.has(p) && openIn(p) > 20) ?? plan ?? workedSet[0]
    leaderTurf.set(leader.id, plan)
    return plan
  }

  const squadRows = []
  const memberRows = []
  const knockRows = []
  const dispatch = new Map() // turfId -> [{day, squadId, squadName, squadDate}]
  const byOutcome = {}

  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const day = days[dayIdx]
    if (restDays.has(day)) continue
    const wd = weekdayOf(day)
    const weekend = wd === 0 || wd === 6
    const crewCount = weekend ? randInt(3, 4) : randInt(2, 3)
    const todaysLeaders = shuffle([...leaders]).slice(0, crewCount)
    const busy = new Set()

    for (const leader of todaysLeaders) {
      const plan = claimTurf(leader)
      if (!plan) continue

      const pool = shuffle(canvassers.filter((c) => !busy.has(c.id)))
      const crew = [leader, ...pool.slice(0, rand() < 0.15 ? 1 : 2)]
      crew.forEach((m) => busy.add(m.id))

      const startMin = weekend
        ? (wd === 6 ? 10 * 60 + 30 : 12 * 60) + randInt(-30, 45)
        : 16 * 60 + 30 + randInt(-20, 40)
      const targets = crew.map(() => Math.max(18, Math.round(randn(weekend ? 50 : 31, weekend ? 9 : 6))))
      const totalTarget = targets.reduce((a, b) => a + b, 0)

      // Steady-state door mix: ~40% revisits, rest fresh from the walk cursor.
      const due = []
      for (const a of plan.doors) {
        const h = households.get(a.id)
        if (h && !h.closed && h.attempts > 0 && h.attempts < 5 && (h.nextRetryAt ?? 0) <= dayIdx) due.push(a)
        if (due.length >= Math.round(totalTarget * 0.42)) break
      }
      const fresh = []
      while (fresh.length < totalTarget - due.length && plan.cursor < plan.walk.length) {
        const a = plan.walk[plan.cursor++]
        const h = households.get(a.id)
        if (!h && (personsByHouse.get(a.id) ?? []).length) fresh.push(a)
      }
      const dayDoors = [...due, ...fresh].sort(
        (x, y) => (x._streetOrder ?? 0) - (y._streetOrder ?? 0) || houseNumOf(x) - houseNumOf(y),
      )
      if (dayDoors.length < 8) continue

      const squadId = randomUUID()
      const squadName = `${firstName(leader)}'s crew`
      squadRows.push({
        id: squadId,
        name: squadName,
        created_by: leader.id,
        squad_date: day,
        created_at: localTime(day, startMin - randInt(25, 55)),
      })
      for (const m of crew) {
        memberRows.push({ squad_id: squadId, user_id: m.id, joined_at: localTime(day, startMin - randInt(5, 40)) })
      }
      if (!dispatch.has(plan.turf.id)) dispatch.set(plan.turf.id, [])
      dispatch.get(plan.turf.id).push({ day, squadId, squadName, squadDate: day })

      // Split whole streets among the crew.
      const byStreet = new Map()
      for (const a of dayDoors) {
        if (!byStreet.has(a._streetKey)) byStreet.set(a._streetKey, [])
        byStreet.get(a._streetKey).push(a)
      }
      const memberDoors = crew.map(() => [])
      const remaining = [...targets]
      for (const doors of byStreet.values()) {
        let best = 0
        for (let i = 1; i < crew.length; i++) if (remaining[i] > remaining[best]) best = i
        memberDoors[best].push(...doors)
        remaining[best] -= doors.length
      }

      crew.forEach((member, mi) => {
        let t = startMin + randInt(0, 20)
        let lastStreet = null
        for (const addr of memberDoors[mi]) {
          let h = households.get(addr.id)
          if (!h) {
            const roster = personsByHouse.get(addr.id) ?? []
            if (!roster.length) continue
            h = {
              id: addr.id,
              attempts: 0,
              priorNotHomes: 0,
              closed: false,
              persons: roster.map((p) => ({ id: p.id, state: 'unresolved' })),
              maybePersonId: null,
            }
            households.set(addr.id, h)
          }
          if (h.closed) continue
          if (addr._streetKey !== lastStreet && lastStreet !== null) t += randInt(3, 8)
          lastStreet = addr._streetKey
          t += rand() < 0.15 ? randInt(4, 9) : randInt(1, 4)

          h.attempts++
          const attempt = h.attempts
          const log = (outcome, personId = null, extraMin = 0) => {
            byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1
            knockRows.push({
              client_id: randomUUID(),
              person_id: personId,
              household_id: h.id,
              canvasser_id: member.id,
              occurred_at: localTime(day, t + extraMin),
              outcome,
              notes: noteFor(outcome),
            })
          }

          if (attempt === 1 && rand() < 0.025) {
            log('skip')
            h.closed = true
            continue
          }

          const prior = priorFor(addr.city)
          const daypart = weekend ? 1.2 : 1.0
          const answerProp = clamp(randn(prior.answer, 0.16), 0.06, 0.85)
          const pAnswer = clamp(answerProp * daypart + 0.045 * (attempt - 1), 0.03, 0.92)
          if (rand() >= pAnswer) {
            log('not_home')
            h.priorNotHomes++
            h.nextRetryAt = dayIdx + randInt(3, 7)
            if (h.attempts >= 4) h.closed = true
            continue
          }

          if (rand() < 0.03) {
            log('hostile')
            h.closed = true
            continue
          }

          const unresolved = h.persons.filter((p) => p.state === 'unresolved')
          const maybePerson = h.persons.find((p) => p.id === h.maybePersonId && p.state === 'maybe')
          const person = maybePerson ?? (unresolved.length ? unresolved[0] : null)
          if (!person) {
            log('not_home')
            continue
          }

          const followup = person.state === 'maybe'
          const willing = clamp(streetSupport(addr) + randn(0, 0.1), 0.02, 0.95)
          let pSign = willing * (1 + 0.07 * h.priorNotHomes) * (followup ? 1.55 : 1)
          pSign = clamp(pSign, 0.02, 0.93)
          const r = rand()
          if (r < pSign) {
            person.state = 'signed'
            log('signed', person.id)
            const other = h.persons.find((p) => p.state === 'unresolved' && p !== person)
            if (other && rand() < 0.35) {
              const r2 = rand()
              if (r2 < clamp(willing * 1.25, 0, 0.9)) {
                other.state = 'signed'
                log('signed', other.id, 1)
              } else if (r2 < clamp(willing * 1.25, 0, 0.9) + 0.1) {
                other.state = 'maybe'
                h.maybePersonId = other.id
                h.nextRetryAt = dayIdx + randInt(4, 9)
                log('maybe', other.id, 1)
              } else {
                other.state = 'refused'
                log('didnt_sign', other.id, 1)
              }
            }
            if (followup) h.maybePersonId = null
          } else if (!followup && r < pSign + 0.16) {
            person.state = 'maybe'
            h.maybePersonId = person.id
            h.nextRetryAt = dayIdx + randInt(4, 9)
            log('maybe', person.id)
          } else {
            person.state = 'refused'
            if (followup) h.maybePersonId = null
            log('didnt_sign', person.id)
          }

          const stillOpen = h.persons.some((p) => p.state === 'unresolved' || p.state === 'maybe')
          if (!stillOpen) h.closed = true
          else if (h.maybePersonId == null) {
            if (rand() < 0.5) h.closed = true
            else h.nextRetryAt = dayIdx + randInt(5, 12)
          }
          t += randInt(2, 6)
        }
      })
    }
  }

  // ---------------- report
  const uniqueDoors = new Set(knockRows.map((k) => k.household_id)).size
  const byDay = new Map()
  for (const k of knockRows) {
    const d = new Date(Date.parse(k.occurred_at) - TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  }
  console.log(`\n=== Recent-history plan ===`)
  console.log(`Squads: ${squadRows.length} across ${new Set(squadRows.map((s) => s.squad_date)).size} active days (rest days: ${[...restDays].sort().join(', ') || 'none'})`)
  console.log(`Knocks: ${knockRows.length} on ${uniqueDoors} doors; signatures ${byOutcome.signed ?? 0}`)
  console.log(`Outcomes:`, byOutcome)
  for (const [d, n] of [...byDay.entries()].sort()) console.log(`  ${d}: ${n} knocks`)

  if (dryRun) {
    console.log('\nDry run — nothing written.')
    return
  }

  // ---------------- write (manifest first so a crash stays wipeable)
  // A prior crashed run appends ids before inserting (wipeability first) —
  // prune any manifest squad ids that never made it into the DB.
  {
    const existing = new Set()
    for (let i = 0; i < manifest.squadIds.length; i += 200) {
      const { data, error } = await supa.from('squads').select('id').in('id', manifest.squadIds.slice(i, i + 200))
      if (error) throw new Error(`squads check: ${error.message}`)
      for (const s of data) existing.add(s.id)
    }
    if (existing.size !== manifest.squadIds.length) {
      console.log(`  pruning ${manifest.squadIds.length - existing.size} stale squad ids from the manifest`)
      manifest.squadIds = manifest.squadIds.filter((id) => existing.has(id))
    }
  }
  manifest.squadIds = [...manifest.squadIds, ...squadRows.map((s) => s.id)]
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))

  console.log(`\nInserting ${squadRows.length} squads + ${memberRows.length} memberships…`)
  await insertChunked('squads', squadRows)
  await insertChunked('squad_members', memberRows)

  console.log(`Inserting ${knockRows.length} knock logs (context stamps via trigger)…`)
  await insertChunked(
    'knock_logs',
    knockRows.map((k) => ({ ...k, created_at: k.occurred_at })),
    400,
  )

  // ---------------- dispatch: history rows for all but each turf's last day,
  // then a real turfs.squad_id update for the last (trigger logs that one).
  const historyRows = []
  for (const [turfId, list] of dispatch) {
    list.sort((a, b) => a.day.localeCompare(b.day))
    for (const d of list.slice(0, -1)) {
      historyRows.push({
        turf_id: turfId,
        squad_id: d.squadId,
        squad_name: d.squadName,
        assignee_id: null,
        assigned_on: d.squadDate,
        assigned_by: pick(cms).id,
        created_at: localTime(d.day, 8 * 60 + randInt(0, 150)),
      })
    }
  }
  console.log(`Inserting ${historyRows.length} dispatch history rows…`)
  await insertChunked('turf_assignments', historyRows)

  console.log('Applying final dispatches…')
  for (const [turfId, list] of dispatch) {
    const last = list[list.length - 1]
    const { error } = await supa
      .from('turfs')
      .update({ squad_id: last.squadId, updated_at: localTime(last.day, 20 * 60) })
      .eq('id', turfId)
    if (error) throw new Error(`dispatch ${turfId}: ${error.message}`)
  }

  console.log('\nDone. New squad ids appended to sim-manifest.json (main --wipe still removes everything).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
