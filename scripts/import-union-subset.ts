// One-off local import: load a small demo subset of UNION.txt (Union County
// OH voter roll, Ohio SOS export, gitignored) into Supabase so Talk/Hunt can
// be exercised before the full admin CSV-import feature ships.
//
// Usage (from repo root):
//   npm run import:union -- --dry-run        # parse + print counts, NO network
//   npm run import:union -- --skip-geocode   # insert without lat/lng
//   npm run import:union                     # full run (geocode + insert)
//
// Required env vars for a real run (values in gitignored KEYS-AND-ACCESS.md —
// NEVER commit them):
//   SUPABASE_SERVICE_ROLE_KEY   bypasses RLS for the insert
//   GOOGLE_MAPS_API_KEY         optional; falls back to the demo key
//
// Real runs write to the live database and call the Google Geocoding API —
// per project process rules, only run this with explicit user approval.

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  buildColumnIndex,
  groupIntoHouseholds,
  parseCsvLine,
  rowToVoter,
  validateHeader,
  type Household,
} from '../src/lib/voterFile'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VOTER_FILE = join(REPO_ROOT, 'UNION.txt')

const TARGET_CITY = 'Richwood' // small town → manageable demo subset
const MAX_HOUSEHOLDS = 150
const GEOCODE_DELAY_MS = 60

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? 'AIzaSyADqvazUypiLr81MNwwiE6MJXUQ9nr6Kis'

const dryRun = process.argv.includes('--dry-run')
const skipGeocode = process.argv.includes('--skip-geocode')

async function readSubset(): Promise<Map<string, Household>> {
  const rl = createInterface({
    input: createReadStream(VOTER_FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let columns: Map<string, number> | null = null
  const voters = []
  let total = 0

  for await (const line of rl) {
    if (!line.trim()) continue
    if (!columns) {
      columns = buildColumnIndex(parseCsvLine(line))
      const missing = validateHeader(columns)
      if (missing.length) throw new Error(`UNION.txt is missing columns: ${missing.join(', ')}`)
      continue
    }
    total++
    const voter = rowToVoter(columns, parseCsvLine(line))
    if (!voter) continue
    if (voter.status !== 'ACTIVE') continue
    if (voter.city.toUpperCase() !== TARGET_CITY.toUpperCase()) continue
    voters.push(voter)
  }

  console.log(`Parsed ${total} rows; ${voters.length} active voters in ${TARGET_CITY}.`)

  const all = groupIntoHouseholds(voters)
  // Deterministic cap: sort keys so re-runs pick the same subset.
  const capped = new Map([...all.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_HOUSEHOLDS))
  const personCount = [...capped.values()].reduce((n, h) => n + h.persons.length, 0)
  console.log(
    `${all.size} households total; importing ${capped.size} (cap ${MAX_HOUSEHOLDS}) with ${personCount} persons.`,
  )
  return capped
}

async function geocode(h: Household): Promise<{ lat: number; lng: number } | null> {
  const address = `${h.address1}, ${h.city}, ${h.state} ${h.zip}`
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json?address=' +
    encodeURIComponent(address) +
    `&key=${MAPS_KEY}`
  try {
    const res = await fetch(url)
    const data = (await res.json()) as {
      status: string
      results?: { geometry: { location: { lat: number; lng: number } } }[]
    }
    if (data.status !== 'OK' || !data.results?.length) {
      console.warn(`  geocode ${data.status}: ${address}`)
      return null
    }
    return data.results[0].geometry.location
  } catch (err) {
    console.warn(`  geocode failed: ${address} (${(err as Error).message})`)
    return null
  }
}

async function main() {
  const households = await readSubset()

  if (dryRun) {
    for (const h of [...households.values()].slice(0, 5)) {
      console.log(`  e.g. ${h.address1}${h.secondaryAddr ? ' ' + h.secondaryAddr : ''}, ${h.city} — ${h.persons.map((p) => p.name).join(', ')}`)
    }
    console.log('Dry run — no geocoding, no database writes.')
    return
  }

  if (!SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set. See KEYS-AND-ACCESS.md (gitignored).')
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  // Idempotency: skip households/persons that already exist.
  const { data: existingAddresses, error: addrErr } = await supabase
    .from('addresses')
    .select('id, street, unit, city, zip')
    .eq('city', TARGET_CITY)
  if (addrErr) throw addrErr
  const existingAddressKeys = new Set(
    (existingAddresses ?? []).map((a) =>
      [a.street, a.unit ?? '', a.city, a.zip ?? ''].join('|').toUpperCase(),
    ),
  )
  const { data: existingPersons, error: persErr } = await supabase
    .from('persons')
    .select('voter_file_id')
    .not('voter_file_id', 'is', null)
  if (persErr) throw persErr
  const existingVoterIds = new Set((existingPersons ?? []).map((p) => p.voter_file_id))

  let addressesInserted = 0
  let personsInserted = 0
  let geocoded = 0

  for (const h of households.values()) {
    const key = [h.address1, h.secondaryAddr, h.city, h.zip].join('|').toUpperCase()
    if (existingAddressKeys.has(key)) continue

    let location: { lat: number; lng: number } | null = null
    if (!skipGeocode) {
      location = await geocode(h)
      if (location) geocoded++
      await new Promise((r) => setTimeout(r, GEOCODE_DELAY_MS))
    }

    const { data: address, error: insertErr } = await supabase
      .from('addresses')
      .insert({
        street: h.address1,
        unit: h.secondaryAddr || null,
        city: h.city,
        county: h.county,
        zip: h.zip || null,
        lat: location?.lat ?? null,
        lng: location?.lng ?? null,
        data_source: 'csv_import',
        registered_voter: true,
      })
      .select('id')
      .single()
    if (insertErr || !address) {
      console.warn(`  insert failed for ${h.address1}: ${insertErr?.message}`)
      continue
    }
    addressesInserted++

    const newPersons = h.persons
      .filter((p) => !existingVoterIds.has(p.voterId))
      .map((p) => ({
        name: p.name,
        household_id: address.id,
        voter_file_id: p.voterId,
        registered_voter: true,
      }))
    if (newPersons.length) {
      const { error: personsErr } = await supabase.from('persons').insert(newPersons)
      if (personsErr) console.warn(`  persons insert failed for ${h.address1}: ${personsErr.message}`)
      else personsInserted += newPersons.length
    }
  }

  console.log(
    `Done. Inserted ${addressesInserted} addresses (${geocoded} geocoded) and ${personsInserted} persons.`,
  )
  if (!skipGeocode && geocoded === 0 && addressesInserted > 0) {
    console.log(
      'No addresses geocoded — the Maps key may lack Geocoding API/billing. Hunt map will have no pins, but search and the address list still work.',
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
