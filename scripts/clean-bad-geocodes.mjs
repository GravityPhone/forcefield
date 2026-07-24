#!/usr/bin/env node
// Clean poisoned cached geocodes (2026-07-24).
//
// Google never admits failure: an address it can't find comes back as an
// APPROXIMATE locality/ZIP centroid instead of an error, and the client used
// to cache whatever came back — which left (verified live) 83 doors across
// 11 Marysville streets stacked on the exact town centroid, plus an 11-door
// Windsor Ct/Dr pile. Those phantom stacks are what made turf-cutter pins
// "pop up in random other areas". src/lib/geocode.ts now validates results
// before caching (street-level + route-name match + county bounds); this
// script clears what already got cached.
//
// Detection: exact-coordinate stacks — the same (lat,lng) shared by more
// than 2 doors across more than 1 street name, or by 4+ distinct house
// numbers of a single street. (Duplicate rows of ONE address sharing coords
// are legit — multi-unit households.)
//
// The victims are NULLed first (honest unmapped state), then re-geocoded
// through the same validation the client applies; survivors bulk-write back
// via the Management API. Doors Google genuinely can't place stay unmapped.
//
// First run (2026-07-24): 136 stacked doors at 9 coords; 48 re-geocoded to
// real per-house positions, 88 left unmapped. Expected leftover: several
// SINGLE-street stacks re-validate to one shared point (RANGE_INTERPOLATED
// street_address where Google's range data for the street is degenerate) —
// those pins sit ON the correct street, which is as good as Google gets
// there; later runs will re-detect, re-check, and re-write them. Harmless.
//
// Usage:
//   node scripts/clean-bad-geocodes.mjs --dry-run   # report the stacks only
//   node scripts/clean-bad-geocodes.mjs             # null + validated re-geocode

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY_RUN = process.argv.includes('--dry-run')

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

async function managementSql(query) {
  const res = await fetch('https://api.supabase.com/v1/projects/whrliwbdxjdcksbvwkrc/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret('SUPABASE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

// ------------------------------------------------- validation (mirror of
// src/lib/geocode.ts — keep the two in sync)

const COUNTY_BOUNDS = { north: 40.62, south: 40.05, east: -83.05, west: -83.72 }

const TOKEN_ABBREV = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', CIRCLE: 'CIR',
  COURT: 'CT', DRIVE: 'DR', LANE: 'LN', PARKWAY: 'PKWY', PLACE: 'PL',
  ROAD: 'RD', SQUARE: 'SQ', TERRACE: 'TER', TRAIL: 'TRL', HIGHWAY: 'HWY',
  POINT: 'PT', RIDGE: 'RDG', CROSSING: 'XING', EXTENSION: 'EXT',
}

function normalizeStreetName(raw) {
  const s = raw.toUpperCase().replace(/[.,']/g, ' ').replace(/\s+/g, ' ').trim()
  const sr = s.match(/^(?:OH|SR|OHIO|STATE ROUTE|STATE RTE|STATE HIGHWAY)[ -]?(\d+)$/)
  if (sr) return `STATE ROUTE ${sr[1]}`
  const us = s.match(/^(?:US|U S|US HIGHWAY|US HWY|US ROUTE|US RTE)[ -]?(\d+)$/)
  if (us) return `US HIGHWAY ${us[1]}`
  const cr = s.match(/^(?:CR|CO RD|CO ROAD|COUNTY RD|COUNTY ROAD)[ -]?(\d+)$/)
  if (cr) return `COUNTY ROAD ${cr[1]}`
  return s.split(' ').map((t) => TOKEN_ABBREV[t] ?? t).join(' ')
}

const stripDir = (n) => n.replace(/^(?:N|S|E|W|NE|NW|SE|SW) /, '')
const streetNameOf = (line) => line.replace(/^\d+\s*/, '').trim().toUpperCase()

const STREET_LEVEL_TYPES = ['street_address', 'premise', 'subpremise']

function trustworthy(result, queriedStreetLine) {
  const { lat, lng } = result.geometry.location
  if (lat < COUNTY_BOUNDS.south || lat > COUNTY_BOUNDS.north) return false
  if (lng < COUNTY_BOUNDS.west || lng > COUNTY_BOUNDS.east) return false
  const streetLevel =
    result.geometry.location_type === 'ROOFTOP' ||
    result.geometry.location_type === 'RANGE_INTERPOLATED' ||
    (result.types ?? []).some((t) => STREET_LEVEL_TYPES.includes(t))
  if (!streetLevel) return false
  const queried = normalizeStreetName(streetNameOf(queriedStreetLine))
  if (!queried) return false
  const routes = []
  for (const c of result.address_components ?? []) {
    if (!c.types.includes('route')) continue
    for (const n of [c.short_name, c.long_name]) {
      if (n) routes.push(normalizeStreetName(n))
    }
  }
  return routes.some((r) => r === queried || stripDir(r) === stripDir(queried))
}

// ---------------------------------------------------------------- main

const victims = await managementSql(`
  with stacks as (
    select lat, lng
    from addresses
    where lat is not null
    group by lat, lng
    having count(*) > 2
       and (count(distinct regexp_replace(street, '^[0-9]+[A-Z]? ', '')) > 1
            or count(distinct street) >= 4)
  )
  select a.id, a.street, a.unit, a.city, a.zip, a.lat, a.lng
  from addresses a
  join stacks s on a.lat = s.lat and a.lng = s.lng
  order by a.lat, a.lng, a.street
`)

if (!victims.length) {
  console.log('No exact-coordinate stacks found — nothing to clean.')
  process.exit(0)
}

const byCoord = new Map()
for (const v of victims) {
  const k = `${v.lat},${v.lng}`
  if (!byCoord.has(k)) byCoord.set(k, [])
  byCoord.get(k).push(v)
}
console.log(`${victims.length} stacked doors at ${byCoord.size} exact coordinates:`)
for (const [k, rows] of byCoord) {
  const streets = [...new Set(rows.map((r) => streetNameOf(r.street)))]
  console.log(`  ${k}  x${rows.length}  (${streets.join(', ')})`)
}

if (DRY_RUN) {
  console.log('\n--dry-run: no changes made.')
  process.exit(0)
}

// NULL first: if the script dies mid-way the doors sit honestly unmapped
// and re-geocode on demand in the app (now validated) instead of lying.
const idList = victims.map((v) => `'${v.id}'::uuid`).join(',')
await managementSql(`update addresses set lat = null, lng = null, updated_at = now() where id in (${idList})`)
console.log(`\nNULLed ${victims.length} doors. Re-geocoding with validation…`)

const key = geocodeKey()
const good = []
let rejected = 0
let noResult = 0
for (const v of victims) {
  const q = encodeURIComponent(`${v.street}${v.unit ? ' ' + v.unit : ''}, ${v.city}, OH ${v.zip ?? ''}`)
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${key}`)
    const body = await res.json()
    const hit = (body.results ?? []).find((r) => trustworthy(r, v.street))
    if (hit) good.push({ id: v.id, lat: hit.geometry.location.lat, lng: hit.geometry.location.lng })
    else if (body.results?.length) rejected++
    else noResult++
  } catch {
    noResult++
  }
}

if (good.length) {
  const values = good.map((g) => `('${g.id}', ${g.lat}, ${g.lng})`).join(',')
  await managementSql(`
    update addresses a
    set lat = v.lat::double precision, lng = v.lng::double precision, updated_at = now()
    from (values ${values}) as v(id, lat, lng)
    where a.id = v.id::uuid
  `)
}
console.log(
  `Re-geocoded: ${good.length} validated and written back, ${rejected} rejected by validation (stay unmapped), ${noResult} no result.`,
)
