// Does public.street_summary say exactly what the client would have computed?
//
//   node scripts/verify-street-summary.mjs
//
// The view (migration 20260727120000) re-implements in SQL a rule that lives in
// JavaScript: streetNameOf / houseNumber in src/lib/streetWalk.ts, folded into
// summaries by addToIndex in src/views/TurfView.vue. Two implementations of one
// rule can drift, so this compares them over every row in the table and
// requires an exact match on street_name, city, door count, lo and hi.
//
// It does NOT re-type those two functions: it lifts them out of streetWalk.ts
// and runs the real ones, so editing the source moves this test with it. If the
// extraction ever fails it throws rather than quietly testing a stale copy.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from './apply-migration.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Pull one exported function out of a .ts source and make it callable, by
 *  stripping the parameter and return type annotations off its signature. The
 *  two functions this is used on are single-expression one-liners; anything
 *  more elaborate should be tested a different way. */
function liftFunction(source, name) {
  const re = new RegExp(`export function ${name}\\(([^)]*)\\)[^{]*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const m = source.match(re)
  if (!m) throw new Error(`could not find ${name}() in streetWalk.ts — extraction needs updating`)
  const params = m[1]
    .split(',')
    .map((p) => p.split(':')[0].trim())
    .filter(Boolean)
  const body = m[2]
  if (/\b(await|import|supabase)\b/.test(body)) {
    throw new Error(`${name}() is no longer a pure one-liner — this script can't lift it safely`)
  }
  return new Function(...params, body)
}

const walkSrc = readFileSync(join(ROOT, 'src/lib/streetWalk.ts'), 'utf8')
const streetNameOf = liftFunction(walkSrc, 'streetNameOf')
const houseNumber = liftFunction(walkSrc, 'houseNumber')

// Sanity-check the lift before trusting a 22k-row comparison to it.
if (streetNameOf('123 GROVE ST') !== 'GROVE ST' || houseNumber('123 GROVE ST') !== 123) {
  throw new Error('lifted parsing functions do not behave as expected')
}
console.log('Lifted streetNameOf() and houseNumber() from src/lib/streetWalk.ts.')

/** Every address row, in the same id order the app indexes them in — which is
 *  what decides the raw `city` spelling a summary carries when one street's
 *  rows disagree about capitalisation. */
async function allAddresses() {
  const rows = []
  const PAGE = 5000
  for (let offset = 0; ; offset += PAGE) {
    const page = await sql(
      `select id, street, city from public.addresses order by id limit ${PAGE} offset ${offset}`,
    )
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

/** The client's own summary build (addToIndex in TurfView.vue), verbatim in
 *  intent: key on NAME|UPPERCASE CITY, skip rows with no street name, keep the
 *  first-seen raw city, and track count plus the house-number span. */
function clientSummaries(rows) {
  const byKey = new Map()
  for (const a of rows) {
    const name = streetNameOf(a.street)
    if (!name) continue
    const key = `${name}|${a.city.toUpperCase()}`
    const n = houseNumber(a.street)
    const sum = byKey.get(key)
    if (!sum) byKey.set(key, { street_name: name, city: a.city, count: 1, lo: n, hi: n })
    else {
      sum.count++
      if (n < sum.lo) sum.lo = n
      if (n > sum.hi) sum.hi = n
    }
  }
  return byKey
}

const rows = await allAddresses()
console.log(`Read ${rows.length} address rows.`)

const mine = clientSummaries(rows)

const viewRows = await sql(
  'select street_name, city, door_count, lo, hi from public.street_summary order by street_name, city',
)
const theirs = new Map(
  viewRows.map((r) => [
    `${r.street_name}|${r.city.toUpperCase()}`,
    { street_name: r.street_name, city: r.city, count: r.door_count, lo: r.lo, hi: r.hi },
  ]),
)

const problems = []
if (theirs.size !== viewRows.length) {
  problems.push(`view returned ${viewRows.length} rows but only ${theirs.size} distinct street keys`)
}
for (const [key, a] of mine) {
  const b = theirs.get(key)
  if (!b) {
    problems.push(`missing from view: ${key} (${a.count} doors)`)
    continue
  }
  for (const field of ['street_name', 'city', 'count', 'lo', 'hi']) {
    if (a[field] !== b[field]) {
      problems.push(`${key} · ${field}: client ${JSON.stringify(a[field])} vs view ${JSON.stringify(b[field])}`)
    }
  }
}
for (const key of theirs.keys()) {
  if (!mine.has(key)) problems.push(`extra in view, not in client index: ${key}`)
}

console.log(`Client computed ${mine.size} streets; view returned ${theirs.size}.`)
const totalDoors = [...mine.values()].reduce((n, s) => n + s.count, 0)
console.log(`Doors covered by summaries: ${totalDoors} of ${rows.length}.`)

if (problems.length) {
  console.error(`\nMISMATCH — ${problems.length} problem(s):`)
  for (const p of problems.slice(0, 40)) console.error('  ' + p)
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`)
  process.exit(1)
}
console.log('\nEXACT MATCH on street_name, city, count, lo and hi for every street.')
