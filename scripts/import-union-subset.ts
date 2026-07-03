// One-off local import: load UNION.txt (Union County OH voter roll, Ohio SOS
// export, gitignored) into Supabase so Talk/Hunt can be exercised before the
// full admin CSV-import feature ships.
//
// Addresses import WITHOUT lat/lng by default — geocoding happens on-demand
// in the app (Talk mode geocodes an address the first time a canvasser pulls
// it up, via the browser Maps Geocoder, and caches the result). --geocode is
// an opt-in bulk backfill for when you want pins ahead of time.
//
// Usage (from repo root):
//   npm run import:union -- --dry-run    # parse + print counts, NO network
//   npm run import:union                 # bulk insert, no lat/lng (default)
//   npm run import:union -- --geocode    # also geocode every address (slow,
//                                        # real Google API usage — county-wide
//                                        # this is 20k+ sequential calls)
//
// Scope: set TARGET_CITY=Richwood to limit to one city; unset = whole county.
// MAX_HOUSEHOLDS caps the household count (default: no cap).
//
// Required env vars for a real run (values in gitignored KEYS-AND-ACCESS.md —
// NEVER commit them):
//   SUPABASE_SERVICE_ROLE_KEY   bypasses RLS for the insert
//   GOOGLE_MAPS_API_KEY         optional; falls back to the demo key
//
// Real runs write to the live database — per project process rules, only run
// this with explicit user approval.

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

const TARGET_CITY = process.env.TARGET_CITY || null // null = whole county
const MAX_HOUSEHOLDS = Number(process.env.MAX_HOUSEHOLDS) || Infinity
const GEOCODE_DELAY_MS = 60

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? 'AIzaSyAQ2t13RtoidSYWPNJmL5R5PVQDzJvZtOs'

const dryRun = process.argv.includes('--dry-run')
const doGeocode = process.argv.includes('--geocode')
const INSERT_BATCH_SIZE = 500

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
    if (TARGET_CITY && voter.city.toUpperCase() !== TARGET_CITY.toUpperCase()) continue
    voters.push(voter)
  }

  const scope = TARGET_CITY ? `active voters in ${TARGET_CITY}` : 'active voters county-wide'
  console.log(`Parsed ${total} rows; ${voters.length} ${scope}.`)

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

  // Idempotency: skip households/persons that already exist. (City-scoped
  // when TARGET_CITY is set; whole table otherwise — still cheap at this
  // scale, and this is a demo import script, not a hot path.)
  let addressQuery = supabase.from('addresses').select('street, unit, city, zip')
  if (TARGET_CITY) addressQuery = addressQuery.eq('city', TARGET_CITY)
  const { data: existingAddresses, error: addrErr } = await addressQuery
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

  const toImport = [...households.values()].filter(
    (h) => !existingAddressKeys.has([h.address1, h.secondaryAddr, h.city, h.zip].join('|').toUpperCase()),
  )
  console.log(`${households.size - toImport.length} already imported; ${toImport.length} new households.`)

  let addressesInserted = 0
  let personsInserted = 0
  let geocoded = 0

  for (let i = 0; i < toImport.length; i += INSERT_BATCH_SIZE) {
    const batch = toImport.slice(i, i + INSERT_BATCH_SIZE)

    let locations: ({ lat: number; lng: number } | null)[] = batch.map(() => null)
    if (doGeocode) {
      locations = []
      for (const h of batch) {
        const loc = await geocode(h)
        if (loc) geocoded++
        locations.push(loc)
        await new Promise((r) => setTimeout(r, GEOCODE_DELAY_MS))
      }
    }

    // Bulk insert this batch; Postgres/PostgREST returns rows in the same
    // order they were inserted, so `addresses[j]` maps back to `batch[j]`.
    const { data: addresses, error: insertErr } = await supabase
      .from('addresses')
      .insert(
        batch.map((h, j) => ({
          street: h.address1,
          unit: h.secondaryAddr || null,
          city: h.city,
          county: h.county,
          zip: h.zip || null,
          lat: locations[j]?.lat ?? null,
          lng: locations[j]?.lng ?? null,
          data_source: 'csv_import',
          registered_voter: true,
        })),
      )
      .select('id')
    if (insertErr || !addresses) {
      console.warn(`  batch insert failed at offset ${i}: ${insertErr?.message}`)
      continue
    }
    addressesInserted += addresses.length

    const newPersons = batch.flatMap((h, j) =>
      h.persons
        .filter((p) => !existingVoterIds.has(p.voterId))
        .map((p) => ({
          name: p.name,
          household_id: addresses[j].id,
          voter_file_id: p.voterId,
          registered_voter: true,
        })),
    )
    if (newPersons.length) {
      const { error: personsErr } = await supabase.from('persons').insert(newPersons)
      if (personsErr) console.warn(`  persons insert failed for batch at offset ${i}: ${personsErr.message}`)
      else personsInserted += newPersons.length
    }

    console.log(`  ${Math.min(i + INSERT_BATCH_SIZE, toImport.length)}/${toImport.length} households…`)
  }

  console.log(
    `Done. Inserted ${addressesInserted} addresses (${geocoded} geocoded) and ${personsInserted} persons.`,
  )
  if (!doGeocode) {
    console.log('No lat/lng yet — Talk mode geocodes an address on-demand the first time it is opened.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
