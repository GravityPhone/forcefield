// Retrofit realistic TURF history onto the simulated month of canvassing
// (scripts/simulate-canvass-history.mjs must have run first — this reads its
// sim-manifest.json and the knock/squad rows it created).
//
// What it builds, derived from the knocks the simulator actually generated:
//   - Turfs cut at street boundaries, chunked in the order crews really
//     walked them (~170-270 doors each), named after their dominant city +
//     anchor street, colored from the app's turf palette.
//   - Two cutting waves: chunks first worked in the front half of the
//     campaign were cut the day before launch; chunks first worked later
//     become NEW turfs cut at the campaign midpoint (the managers expanding
//     coverage), plus a little never-yet-worked "backlog" turf per area.
//   - Day-by-day dispatch: every day a squad worked a turf gets a
//     turf_assignments history row ("Jun 18 — Dana's crew"); the FINAL
//     dispatch is applied as a real turfs.squad_id update so the
//     log_turf_assignment trigger writes that last row itself.
//   - Membership stamped through the real set_turf_segments() RPC (whole
//     streets, actual house-number ranges), then knock_logs.turf_id /
//     turf_name restamped to match (overwriting the migration's best-effort
//     backfill and any leftover test-turf stamps).
//
// Because turfs here are cut once and never re-cut, a door's CURRENT turf is
// also its turf of record for every historical knock — restamping from
// addresses.turf_id is exact, not approximate. (No sub-turfs are created:
// re-dispatch dissolves them server-side, so none would survive the month.)
//
// DESTRUCTIVE, on purpose: any turfs that exist before the run (leftover
// hand-cut test turfs, or a previous run of this script) are deleted first —
// the demo reads best when the whole board is one coherent cut. Turf ids are
// appended to sim-manifest.json so the main script's --wipe removes them too.
//
// Usage (from repo root — hits the LIVE database on a real run):
//   node scripts/simulate-turf-history.mjs --dry-run   # plan + stats, no writes
//   node scripts/simulate-turf-history.mjs             # cut, dispatch, restamp

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const MANIFEST_PATH = join(REPO_ROOT, 'sim-manifest.json')

const dryRun = process.argv.includes('--dry-run')

function secret(name) {
  const keys = readFileSync(join(REPO_ROOT, 'KEYS-AND-ACCESS.md'), 'utf8')
  const m = keys.match(new RegExp(`^${name}=(.+)$`, 'm'))
  if (!m) throw new Error(`${name} not found in KEYS-AND-ACCESS.md`)
  return m[1].trim()
}

const supa = createClient(SUPABASE_URL, secret('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Multi-statement / cross-table SQL (the knock restamp) goes through the
// Management API — same pattern as the main sim script.
async function managementSql(query) {
  const res = await fetch('https://api.supabase.com/v1/projects/whrliwbdxjdcksbvwkrc/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret('SUPABASE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`management sql ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchAll(table, cols, mod = (q) => q) {
  const rows = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await mod(supa.from(table).select(cols)).order('id').range(from, from + page - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < page) break
  }
  return rows
}

async function insertChunked(table, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await supa.from(table).insert(rows.slice(i, i + chunk))
    if (error) throw new Error(`insert ${table} @${i}: ${error.message}`)
  }
}

// Seeded RNG (different seed than the knock sim, same generator family).
let rngState = 0x70b0f00d
function rand() {
  rngState |= 0
  rngState = (rngState + 0x6d2b79f5) | 0
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

// Same fixed campaign timezone the knock sim used (Union County, EDT).
const TZ_OFFSET_MIN = 4 * 60
const DAY_MS = 86_400_000
const localDayIso = (ts) => new Date(Date.parse(ts) - TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10)
const localTime = (dayIso, minutes) =>
  new Date(Date.parse(`${dayIso}T00:00:00Z`) + (minutes + TZ_OFFSET_MIN) * 60_000).toISOString()
const dayPlus = (dayIso, n) => new Date(Date.parse(`${dayIso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

// The turf cutter's own palette (src/views/TurfView.vue) — cycled the same way.
const PALETTE = [
  '#7c3aed', '#0ea5e9', '#f97316', '#10b981', '#ef4444',
  '#eab308', '#ec4899', '#14b8a6', '#6366f1', '#84cc16',
]

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Ne|Nw|Se|Sw|Us|Oh)\b/g, (m) => m.toUpperCase())

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const simUsers = new Set(manifest.userIds)
  const simSquads = new Set(manifest.squadIds)

  console.log('Loading profiles, squads, addresses, knocks…')
  const profiles = await fetchAll('profiles', 'id, role, display_name, username')
  const cms = profiles.filter((p) => simUsers.has(p.id) && p.role === 'campaign_manager')
  if (!cms.length) throw new Error('No sim campaign managers found — did the knock sim run?')

  const squads = new Map()
  {
    const ids = [...simSquads]
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supa
        .from('squads')
        .select('id, name, squad_date, created_by')
        .in('id', ids.slice(i, i + 100))
      if (error) throw new Error(`squads: ${error.message}`)
      for (const s of data) squads.set(s.id, s)
    }
  }

  const addresses = await fetchAll('addresses', 'id, street, city, lat, lng')
  const knocks = (await fetchAll('knock_logs', 'id, household_id, canvasser_id, occurred_at, squad_id')).filter(
    (k) => simUsers.has(k.canvasser_id) && k.household_id,
  )
  console.log(`  ${addresses.length} addresses, ${knocks.length} sim knocks, ${squads.size} sim squads`)

  // ---------------- streets (same city|name grouping as the knock sim)
  const streets = new Map()
  const streetOfDoor = new Map()
  for (const a of addresses) {
    const m = a.street.match(/^(\d+)\s+(.+)$/)
    const num = m ? Number(m[1]) : 0
    const name = m ? m[2] : a.street
    const key = `${a.city}|${name}`
    let s = streets.get(key)
    if (!s) streets.set(key, (s = { key, city: a.city, name, doors: [], lat: 0, lng: 0, nGeo: 0 }))
    s.doors.push({ id: a.id, num })
    if (a.lat != null && a.lng != null) {
      s.lat += a.lat
      s.lng += a.lng
      s.nGeo++
    }
    streetOfDoor.set(a.id, s)
  }
  for (const s of streets.values()) {
    if (s.nGeo) {
      s.lat /= s.nGeo
      s.lng /= s.nGeo
    } else {
      s.lat = s.lng = null
    }
  }

  // ---------------- per-street work stats from the actual knocks
  // firstKnock orders the chunks; leader votes decide whose area a street is;
  // dayWork drives the day-by-day dispatch rows.
  const squadDayTotal = new Map() // `${day}|${squadId}` -> that crew's knocks that day
  for (const k of knocks) {
    const s = streetOfDoor.get(k.household_id)
    if (!s) continue
    const squad = k.squad_id ? squads.get(k.squad_id) : null
    if (!s.firstKnock || k.occurred_at < s.firstKnock) s.firstKnock = k.occurred_at
    if (squad) {
      const dk = `${localDayIso(k.occurred_at)}|${k.squad_id}`
      squadDayTotal.set(dk, (squadDayTotal.get(dk) ?? 0) + 1)
      s.leaderVotes ??= new Map()
      s.leaderVotes.set(squad.created_by, (s.leaderVotes.get(squad.created_by) ?? 0) + 1)
      const day = localDayIso(k.occurred_at)
      s.dayWork ??= new Map()
      let dw = s.dayWork.get(day)
      if (!dw) s.dayWork.set(day, (dw = new Map()))
      dw.set(k.squad_id, (dw.get(k.squad_id) ?? 0) + 1)
    }
  }

  const worked = [...streets.values()].filter((s) => s.firstKnock && s.leaderVotes)
  const allDays = knocks.map((k) => localDayIso(k.occurred_at)).sort()
  const startDay = allDays[0]
  const endDay = allDays[allDays.length - 1]
  const spanDays = Math.round((Date.parse(endDay) - Date.parse(startDay)) / DAY_MS)
  const midDay = dayPlus(startDay, Math.floor(spanDays / 2)) // wave-2 cut day
  const cutDayWave1 = dayPlus(startDay, -1)
  const dayIndex = (iso) => Math.round((Date.parse(iso) - Date.parse(startDay)) / DAY_MS)
  const midIndex = Math.floor(spanDays / 2)
  console.log(`  campaign ${startDay} → ${endDay}; wave-1 cut ${cutDayWave1}, wave-2 cut ${midDay}`)

  // ---------------- group streets by area leader, chunk into turfs
  const byLeader = new Map()
  for (const s of worked) {
    let best = null
    for (const [id, n] of s.leaderVotes) if (!best || n > s.leaderVotes.get(best)) best = id
    if (!byLeader.has(best)) byLeader.set(best, [])
    byLeader.get(best).push(s)
  }

  const turfs = [] // {id, name, color, createdAt, wave, streets, doorCount, dispatch: Map(day -> squadId)}
  const usedStreets = new Set()
  let colorIdx = 0
  const nameCounts = new Map()

  for (const [leaderId, ss] of byLeader) {
    ss.sort((a, b) => a.firstKnock.localeCompare(b.firstKnock))
    let chunk = []
    let doors = 0
    let target = randInt(170, 270)
    const flush = () => {
      if (!chunk.length) return
      turfs.push(makeTurf(chunk, leaderId))
      chunk = []
      doors = 0
      target = randInt(170, 270)
    }
    for (const s of ss) {
      usedStreets.add(s.key)
      chunk.push(s)
      doors += s.doors.length
      if (doors >= target) flush()
    }
    // A tiny tail chunk (the cut a crew had only just started) reads as a
    // bug on the map — fold it into the area's previous turf instead.
    if (chunk.length && doors < 100 && turfs.length) {
      const prev = turfs[turfs.length - 1]
      if (prev.leaderId === leaderId) {
        prev.streets.push(...chunk)
        rebuildTurf(prev)
        chunk = []
      }
    }
    flush()
  }

  function makeTurf(chunk, leaderId, { backlog = false } = {}) {
    const doorCount = chunk.reduce((n, s) => n + s.doors.length, 0)
    // Anchor = the chunk's biggest street; dominant city breaks name clashes
    // between towns.
    const anchor = chunk.reduce((a, b) => (b.doors.length > a.doors.length ? b : a))
    const cityTally = new Map()
    for (const s of chunk) cityTally.set(s.city, (cityTally.get(s.city) ?? 0) + s.doors.length)
    const city = [...cityTally.entries()].sort((a, b) => b[1] - a[1])[0][0]
    let name = `${titleCase(city)} · ${titleCase(anchor.name)}`
    const n = (nameCounts.get(name) ?? 0) + 1
    nameCounts.set(name, n)
    if (n > 1) name += ` ${n}`

    const firstKnock = backlog ? null : chunk.map((s) => s.firstKnock).sort()[0]
    const wave = backlog || dayIndex(localDayIso(firstKnock)) > midIndex ? 2 : 1

    return {
      id: randomUUID(),
      name,
      color: PALETTE[colorIdx++ % PALETTE.length],
      leaderId,
      streets: chunk,
      doorCount,
      wave,
      backlog,
      dispatch: computeDispatch(chunk),
    }
  }

  // A dispatch day = this turf was a real share of some crew's day (≥25% of
  // that squad's knocks and at least 4) — a handful of scattered revisit
  // knocks doesn't count as "the manager sent them there".
  function computeDispatch(chunk) {
    const perDay = new Map()
    for (const s of chunk) {
      if (!s.dayWork) continue
      for (const [day, perSquad] of s.dayWork) {
        let acc = perDay.get(day)
        if (!acc) perDay.set(day, (acc = new Map()))
        for (const [sq, cnt] of perSquad) acc.set(sq, (acc.get(sq) ?? 0) + cnt)
      }
    }
    const dispatchDays = [...perDay.entries()]
      .map(([day, perSquad]) => {
        const [squadId, cnt] = [...perSquad.entries()].sort((a, b) => b[1] - a[1])[0]
        return { day, squadId, cnt }
      })
      .sort((a, b) => a.day.localeCompare(b.day))
    let kept = dispatchDays.filter(
      (d) => d.cnt >= 4 && d.cnt >= 0.25 * (squadDayTotal.get(`${d.day}|${d.squadId}`) ?? Infinity),
    )
    if (!kept.length && dispatchDays.length)
      kept = [[...dispatchDays].sort((a, b) => b.cnt - a.cnt)[0]]
    return kept.sort((a, b) => a.day.localeCompare(b.day))
  }

  function rebuildTurf(t) {
    t.doorCount = t.streets.reduce((n, s) => n + s.doors.length, 0)
    t.dispatch = computeDispatch(t.streets)
  }

  // ---------------- backlog: one uncut-until-midpoint, never-worked turf per
  // area, from the unknocked streets nearest that leader's worked ground.
  for (const [leaderId, ss] of byLeader) {
    const geo = ss.filter((s) => s.lat != null)
    if (!geo.length) continue
    const cLat = geo.reduce((a, s) => a + s.lat, 0) / geo.length
    const cLng = geo.reduce((a, s) => a + s.lng, 0) / geo.length
    const candidates = [...streets.values()]
      .filter((s) => !usedStreets.has(s.key) && !s.firstKnock && s.lat != null)
      .map((s) => ({ s, d: (s.lat - cLat) ** 2 + (s.lng - cLng) ** 2 }))
      .sort((a, b) => a.d - b.d)
    const chunk = []
    let doors = 0
    for (const { s } of candidates) {
      if (doors >= randInt(160, 240)) break
      if (s.doors.length > 400) continue // one mega-street would be its own cut
      chunk.push(s)
      usedStreets.add(s.key)
      doors += s.doors.length
    }
    if (doors >= 80) turfs.push(makeTurf(chunk, leaderId, { backlog: true }))
  }

  // ---------------- report
  const wave1 = turfs.filter((t) => t.wave === 1)
  const wave2 = turfs.filter((t) => t.wave === 2 && !t.backlog)
  const backlog = turfs.filter((t) => t.backlog)
  const assignRows = turfs.reduce((n, t) => n + t.dispatch.length, 0)
  console.log(`\n=== Turf plan ===`)
  console.log(`Turfs: ${turfs.length} (${wave1.length} cut before launch, ${wave2.length} cut at midpoint, ${backlog.length} backlog/unworked)`)
  console.log(`Doors covered: ${turfs.reduce((n, t) => n + t.doorCount, 0)}`)
  console.log(`Dispatch history rows: ${assignRows}`)
  const leaderName = (id) => profiles.find((p) => p.id === id)?.display_name ?? '??'
  for (const t of turfs) {
    const span = t.dispatch.length
      ? `${t.dispatch[0].day} → ${t.dispatch[t.dispatch.length - 1].day} (${t.dispatch.length}d worked)`
      : 'never dispatched'
    console.log(
      `  [w${t.wave}${t.backlog ? ' backlog' : ''}] ${t.name.padEnd(38)} ${String(t.doorCount).padStart(4)} doors, ${String(t.streets.length).padStart(2)} streets, ${leaderName(t.leaderId)}: ${span}`,
    )
  }

  if (dryRun) {
    console.log('\nDry run — nothing written.')
    return
  }

  // ---------------- clear pre-existing turf (test artifacts / prior runs)
  {
    const { data: old, error } = await supa.from('turfs').select('id, name, parent_turf_id')
    if (error) throw new Error(error.message)
    if (old.length) {
      console.log(`\nDeleting ${old.length} pre-existing turfs: ${old.map((t) => t.name).join(', ')}`)
      const subs = old.filter((t) => t.parent_turf_id).map((t) => t.id)
      const tops = old.filter((t) => !t.parent_turf_id).map((t) => t.id)
      for (const ids of [subs, tops])
        if (ids.length) {
          const { error: delErr } = await supa.from('turfs').delete().in('id', ids)
          if (delErr) throw new Error(`delete turfs: ${delErr.message}`)
        }
    }
  }

  // Manifest first — anything inserted below stays wipeable even on a crash.
  manifest.turfIds = turfs.map((t) => t.id)
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))

  // ---------------- insert turfs (squadless; dispatch comes later)
  console.log(`Inserting ${turfs.length} turfs…`)
  const cutMinutes = new Map() // stagger cut times through the morning
  const turfRows = turfs.map((t) => {
    const day = t.wave === 1 ? cutDayWave1 : midDay
    const m = (cutMinutes.get(day) ?? 9 * 60) + randInt(4, 14)
    cutMinutes.set(day, m)
    t.createdAt = localTime(day, m)
    return {
      id: t.id,
      name: t.name,
      color: t.color,
      created_by: pick(cms).id,
      created_at: t.createdAt,
      updated_at: t.createdAt,
    }
  })
  await insertChunked('turfs', turfRows)

  // ---------------- segments + membership through the real RPC
  console.log('Cutting segments (set_turf_segments per turf)…')
  let totalStamped = 0
  for (const t of turfs) {
    const segments = t.streets.map((s) => ({
      street_name: s.name,
      city: s.city,
      range_start: Math.min(...s.doors.map((d) => d.num)),
      range_end: Math.max(...s.doors.map((d) => d.num)),
      parity: 'both',
    }))
    const { data: stamped, error } = await supa.rpc('set_turf_segments', {
      target_turf_id: t.id,
      segments,
    })
    if (error) throw new Error(`set_turf_segments ${t.name}: ${error.message}`)
    totalStamped += stamped
    if (stamped !== t.doorCount)
      console.warn(`  ⚠ ${t.name}: stamped ${stamped}, expected ${t.doorCount}`)
  }
  console.log(`  ${totalStamped} doors stamped into turf`)

  // ---------------- dispatch history (all but each turf's final day; the
  // final day goes through a real turfs update so the trigger logs it)
  const historyRows = []
  for (const t of turfs) {
    for (const d of t.dispatch.slice(0, -1)) {
      const squad = squads.get(d.squadId)
      historyRows.push({
        turf_id: t.id,
        squad_id: d.squadId,
        squad_name: squad.name,
        assignee_id: null,
        assigned_on: squad.squad_date,
        assigned_by: pick(cms).id,
        // Managers point turf at crews in the morning, before shift.
        created_at: localTime(d.day, 8 * 60 + randInt(0, 150)),
      })
    }
  }
  console.log(`Inserting ${historyRows.length} dispatch history rows…`)
  await insertChunked('turf_assignments', historyRows)

  console.log('Applying final dispatches…')
  for (const t of turfs) {
    if (!t.dispatch.length) continue
    const last = t.dispatch[t.dispatch.length - 1]
    const { error } = await supa
      .from('turfs')
      .update({ squad_id: last.squadId, updated_at: localTime(last.day, 20 * 60) })
      .eq('id', t.id)
    if (error) throw new Error(`dispatch ${t.name}: ${error.message}`)
  }

  // ---------------- restamp knock context to match the cut
  // Turfs are cut once and never re-cut here, so current membership IS the
  // historical turf of record — exact, not best-effort. (No sub-turfs exist;
  // if any did, they'd need the parent-resolve the stamp trigger does.)
  console.log('Restamping knock_logs turf context…')
  await managementSql(`
    update public.knock_logs k
    set turf_id = t.id, turf_name = t.name
    from public.addresses a
    join public.turfs t on t.id = a.turf_id
    where a.id = k.household_id
      and (k.turf_id is distinct from t.id or k.turf_name is distinct from t.name)
  `)
  await managementSql(`
    update public.knock_logs k
    set turf_id = null, turf_name = null
    where (k.turf_id is not null or k.turf_name is not null)
      and not exists (
        select 1 from public.addresses a
        where a.id = k.household_id and a.turf_id is not null
      )
  `)
  const { count: inTurf } = await supa
    .from('knock_logs')
    .select('id', { count: 'exact', head: true })
    .not('turf_name', 'is', null)
  const { count: total } = await supa.from('knock_logs').select('id', { count: 'exact', head: true })
  console.log(`  ${inTurf}/${total} knocks now carry a turf stamp`)

  console.log('\nDone. Turf ids appended to sim-manifest.json (--wipe in the main sim script removes them).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
