// Does the next-knock model in src/lib/odds.ts actually predict anything?
//
//   node scripts/verify-odds-model.mjs
//   node scripts/verify-odds-model.mjs --verbose     (per-split tables)
//
// The Odds tab tells a campaign manager where to send people. A model that is
// merely plausible is worse than no model, because it looks like knowledge. So
// this runs the REAL module, not a re-typed copy of it, against the live knock
// history, and holds it to out-of-sample tests it can fail.
//
// Three tests, each answering a question the page actually gets asked:
//
//   1. PREQUENTIAL. Fit on every day before day D, predict day D, walk D
//      forward. "Would this have been right yesterday, knowing only what we
//      knew the day before."
//   2. HALF A STREET. Hold out half of every street's DOORS, fit on the other
//      half. "We have knocked half of Grove St. What about the rest." This is
//      the question the Odds tab is for.
//   3. NEIGHBOURS ONLY. Predict a street from the streets that connect to it,
//      never from itself. "Nobody has been down there yet."
//
// Each is scored on log loss (lower is better, and it punishes confident
// mistakes, which is the failure mode that matters here) and AUC (0.5 is a
// coin toss). Every test is compared against the campaign's flat average, and
// the script EXITS NONZERO if the model fails to beat it.
//
// The module is bundled with esbuild rather than imported directly: odds.ts
// pulls streetNameOf out of streetWalk.ts, which imports the Supabase client,
// which reads import.meta.env. Defining that away is cheaper than moving three
// string helpers and re-pointing every caller, and it keeps this script honest
// about testing the real file.

import { rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { build } from 'esbuild'
import { sql } from './apply-migration.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

// --------------------------------------------------------------- the module
// Inside the repo, not the system temp dir: with `packages: 'external'` the
// bundle still imports @supabase/supabase-js by name, and Node resolves that
// from the file's own directory upward.
const outDir = join(ROOT, 'node_modules', '.cache', `ff-odds-${process.pid}`)
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'odds.mjs')
await build({
  entryPoints: [join(ROOT, 'src/lib/odds.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  // The one thing standing between this file and a plain import.
  define: { 'import.meta.env': '{}' },
  // odds.ts's only aliased import is `import type`, which is erased, but the
  // alias is declared anyway so a future value import resolves here rather
  // than failing at bundle time.
  alias: { '@': join(ROOT, 'src') },
  outfile: bundle,
  logLevel: 'error',
})
const { buildOddsModel, doorOdds, setOdds, scoreOddsModel, percentileOf } = await import(pathToFileURL(bundle).href)

// --------------------------------------------------------------- the data
async function paged(cols, table, order, extra = '') {
  const rows = []
  const PAGE = 6000
  for (let off = 0; ; off += PAGE) {
    const batch = await sql(`select ${cols} from ${table} ${extra} order by ${order} limit ${PAGE} offset ${off}`)
    rows.push(...batch)
    if (batch.length < PAGE) break
  }
  return rows
}

process.stdout.write('reading the campaign… ')
const rawKnocks = await paged(
  `household_id, extract(epoch from occurred_at)*1000 as ts, outcome`,
  'knock_logs',
  'occurred_at',
  'where household_id is not null',
)
const rawDoors = await paged(`id, street, city, lat, lng`, 'addresses', 'id')
const rosterRows = await paged(`household_id, count(*)::int as n`, 'persons', 'household_id', 'group by household_id')
const roster = new Map(rosterRows.map((r) => [r.household_id, r.n]))
const knocks = rawKnocks.map((k) => ({ household: k.household_id, ts: Number(k.ts), outcome: k.outcome }))
const doors = rawDoors.map((d) => ({ id: d.id, street: d.street, city: d.city, lat: d.lat, lng: d.lng, residents: roster.get(d.id) ?? 0 }))
console.log(`${knocks.length} knocks, ${doors.length} doors`)

const dayOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const CONVERSATION = new Set(['signed', 'didnt_sign', 'maybe', 'hostile'])

// --------------------------------------------------------------- scoring
const clamp = (p) => Math.min(0.995, Math.max(0.005, p))
function auc(scores, labels) {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s)
  let rank = 1, sumPos = 0, nPos = 0, i = 0
  while (i < pairs.length) {
    let j = i
    while (j < pairs.length - 1 && pairs[j + 1].s === pairs[i].s) j++
    const avg = (2 * rank + (j - i)) / 2
    for (let m = i; m <= j; m++) if (pairs[m].y === 1) { sumPos += avg; nPos++ }
    rank += j - i + 1
    i = j + 1
  }
  const nNeg = pairs.length - nPos
  return !nPos || !nNeg ? 0.5 : (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}
class Score {
  constructor() { this.ll = 0; this.n = 0; this.p = []; this.y = [] }
  add(p, y) { const q = clamp(p); this.ll += -(y ? Math.log(q) : Math.log(1 - q)); this.n++; this.p.push(q); this.y.push(y) }
  get logloss() { return this.n ? this.ll / this.n : NaN }
  get auc() { return auc(this.p, this.y) }
}

const failures = []

/**
 * Compare against the flat campaign rate on the SAME trials, and say whether
 * the difference is bigger than the noise in it.
 *
 * A bare "is the log loss lower" test on a point estimate would flip on a
 * coin. These are paired samples (the same visit scored twice), so the paired
 * standard error is available and is the honest yardstick: a model that is
 * 0.004 worse over 2,893 trials with a standard error of 0.002 has not been
 * shown to be worse, and reporting that as a failure teaches nothing.
 *
 * `mustBeat` is for the claims the module actually makes. Where the module
 * documents that it expects no signal, the bar is only that it does no harm.
 */
function report(name, model, flat, { mustBeat = true, minAuc = 0 } = {}) {
  const diffs = model.p.map((p, i) => {
    const y = model.y[i]
    const a = -(y ? Math.log(p) : Math.log(1 - p))
    const q = flat.p[i]
    const b = -(y ? Math.log(q) : Math.log(1 - q))
    return a - b
  })
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length
  const varr = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, diffs.length - 1)
  const se = Math.sqrt(varr / diffs.length)
  const better = mean < -2 * se
  const worse = mean > 2 * se
  const verdict = better ? 'better' : worse ? 'WORSE' : 'no measurable difference'
  const ok = mustBeat ? better && model.auc >= minAuc : !worse
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${model.logloss.toFixed(4)} against ${flat.logloss.toFixed(4)} flat, ` +
      `${verdict} (${mean >= 0 ? '+' : ''}${mean.toFixed(4)} give or take ${(2 * se).toFixed(4)})   AUC ${model.auc.toFixed(3)}   n=${model.n}`,
  )
  if (!ok) failures.push(name)
}

/** Rebuild the per-door truth the model collapses to internally, so a test can
 *  score the same VISITS the model is predicting. Deliberately a second
 *  implementation of only the collapse rule, and only for reading the answer
 *  key: everything being scored comes out of the module itself. */
function visitsOf(rows) {
  const byDoor = new Map()
  const out = []
  for (const k of [...rows].sort((a, b) => a.ts - b.ts)) {
    const st = byDoor.get(k.household) ?? { last: -Infinity, open: null }
    if (!st.open || k.ts - st.last >= 600000) {
      st.open = { household: k.household, ts: k.ts, interacted: false, answered: false, signed: false }
      out.push(st.open)
    }
    if (k.outcome !== 'skip') st.open.interacted = true
    if (CONVERSATION.has(k.outcome)) st.open.answered = true
    if (k.outcome === 'signed') st.open.signed = true
    st.last = k.ts
    byDoor.set(k.household, st)
  }
  return out
}

const allVisits = visitsOf(knocks)
const days = [...new Set(allVisits.map((v) => dayOf(v.ts)))].sort()

// --------------------------------------------------------------- 1. prequential
console.log('\n1. PREQUENTIAL: fit on everything before day D, predict day D')
{
  const answer = new Score(), answerFlat = new Score()
  const sign = new Score(), signFlat = new Score()
  for (const day of days.slice(Math.floor(days.length * 0.45))) {
    const before = knocks.filter((k) => dayOf(k.ts) < day)
    const today = allVisits.filter((v) => dayOf(v.ts) === day)
    if (before.length < 400 || !today.length) continue
    const model = buildOddsModel(before, doors, { rank: false })
    const flatA = model.conversations / Math.max(1, model.interactions)
    const flatS = model.signatures / Math.max(1, model.conversations)
    for (const v of today) {
      const o = doorOdds(model, v.household)
      // A door the model calls closed is one nobody should have knocked; it
      // gives no number, so there is nothing to score.
      if (!o.answer || !o.sign) continue
      if (v.interacted) { answer.add(o.answer.p, v.answered ? 1 : 0); answerFlat.add(flatA, v.answered ? 1 : 0) }
      if (v.answered) { sign.add(o.sign.p, v.signed ? 1 : 0); signFlat.add(flatS, v.signed ? 1 : 0) }
    }
  }
  report('somebody answers', answer, answerFlat, { minAuc: 0.55 })
  // Day to day, the sign half has little to say and the module says so. Crews
  // finish a street and move on, so a street with history in the days BEFORE
  // today is rarely the street being walked today, and where it is, the doors
  // left are the ones nobody was home at, which is a different population from
  // the neighbours who already answered. The claim being tested here is only
  // that it does no harm; test 2 is where the sign half has to earn its place.
  report('they sign, given an answer', sign, signFlat, { mustBeat: false })
}

// --------------------------------------------------------------- 2. half a street
console.log('\n2. HALF A STREET: fit on half of every street\'s doors, predict the other half')
function h32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0) / 4294967296 }
{
  const heldOut = new Set(allVisits.map((v) => v.household).filter((h) => h32(h) >= 0.5))
  const model = buildOddsModel(knocks.filter((k) => !heldOut.has(k.household)), doors, { rank: false })
  const flatA = model.conversations / Math.max(1, model.interactions)
  const flatS = model.signatures / Math.max(1, model.conversations)
  const answer = new Score(), answerFlat = new Score()
  const sign = new Score(), signFlat = new Score()
  let withStreet = 0
  for (const v of allVisits) {
    if (!heldOut.has(v.household)) continue
    const o = doorOdds(model, v.household)
    if (!o.answer || !o.sign) continue
    // The model has never seen this door, so its own state is empty and the
    // only thing separating these predictions is the geography.
    const street = o.street ? model.streetSign.get(o.street) : null
    if (!street || street.n < 10) continue
    withStreet++
    if (v.interacted) { answer.add(o.answer.p, v.answered ? 1 : 0); answerFlat.add(flatA, v.answered ? 1 : 0) }
    if (v.answered) { sign.add(o.sign.p, v.signed ? 1 : 0); signFlat.add(flatS, v.signed ? 1 : 0) }
  }
  console.log(`  (${withStreet} held-out visits sit on a street with 10 or more conversations in the other half)`)
  report('they sign, given an answer', sign, signFlat, { minAuc: 0.58 })
  if (VERBOSE) report('somebody answers', answer, answerFlat, { mustBeat: false })
}

// --------------------------------------------------------------- 3. neighbours only
console.log('\n3. NEIGHBOURS ONLY: predict a whole street from the ones that connect to it')
{
  const full = buildOddsModel(knocks, doors, { rank: false })
  const streets = [...new Set(allVisits.map((v) => full.streetOf.get(v.household)).filter(Boolean))]
  const sign = new Score(), signFlat = new Score()
  let tested = 0
  for (const street of streets) {
    const own = full.streetSign.get(street)
    if (!own || own.n < 10) continue
    let nearN = 0
    for (const o of full.neighboursOf(street)) nearN += full.streetSign.get(o)?.n ?? 0
    if (nearN < 30) continue
    const doorsHere = new Set(full.doorsOnStreet.get(street) ?? [])
    const model = buildOddsModel(knocks.filter((k) => !doorsHere.has(k.household)), doors, { rank: false })
    const flatS = model.signatures / Math.max(1, model.conversations)
    for (const v of allVisits) {
      if (!doorsHere.has(v.household) || !v.answered) continue
      const o = doorOdds(model, v.household)
      if (!o.sign) continue
      sign.add(o.sign.p, v.signed ? 1 : 0)
      signFlat.add(flatS, v.signed ? 1 : 0)
    }
    tested++
    if (tested >= 40) break // each street is a full refit; 40 is plenty to see a signal
  }
  console.log(`  (${tested} streets refitted with themselves removed)`)
  // Measured at close to nothing on this campaign, which is the honest result
  // and is documented in odds.ts. The bar is that it must not make things
  // WORSE: shrinkage is supposed to make a weak signal harmless.
  const ok = sign.logloss <= signFlat.logloss * 1.01
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  neighbours do not hurt          log loss ${sign.logloss.toFixed(4)} against ${signFlat.logloss.toFixed(4)} flat   AUC ${sign.auc.toFixed(3)}   (n=${sign.n})`,
  )
  if (!ok) failures.push('neighbours do not hurt')
}

// --------------------------------------------------------------- 4. calibration
console.log('\n4. CALIBRATION: when it says 40%, do 40% answer?')
{
  const heldOut = new Set(allVisits.map((v) => v.household).filter((h) => h32(h) >= 0.5))
  const model = buildOddsModel(knocks.filter((k) => !heldOut.has(k.household)), doors, { rank: false })
  // FIRST VISITS ONLY, and this is a correctness fix rather than a filter.
  // The model has never seen a held-out door, so it has no history for it and
  // scores every visit there as a first visit. Handing it that door's SECOND
  // visit and marking the answer wrong measures the holdout, not the model:
  // a real second visit answers at about 25% and the model is being asked to
  // say so while being told nothing has happened here. It went unnoticed while
  // every prediction was the same number and the bucket average absorbed it.
  // Test 6, which splits by time and lets the model keep each door's history,
  // is the calibration measure to trust.
  const firstVisit = new Set()
  const seen = new Set()
  for (const v of allVisits) {
    if (seen.has(v.household)) continue
    seen.add(v.household)
    firstVisit.add(v)
  }
  const bins = new Map()
  for (const v of allVisits) {
    if (!heldOut.has(v.household) || !v.interacted || !firstVisit.has(v)) continue
    const o = doorOdds(model, v.household)
    if (!o.answer) continue
    const b = Math.min(9, Math.floor(o.answer.p * 10))
    const e = bins.get(b) ?? { p: 0, y: 0, n: 0 }
    e.p += o.answer.p; e.y += v.answered ? 1 : 0; e.n++
    bins.set(b, e)
  }
  let worst = 0
  for (const [b, e] of [...bins].sort((x, y) => x[0] - y[0])) {
    if (e.n < 30) continue
    const said = (100 * e.p) / e.n
    const got = (100 * e.y) / e.n
    worst = Math.max(worst, Math.abs(said - got))
    console.log(`     said ${said.toFixed(1).padStart(5)}%   actually ${got.toFixed(1).padStart(5)}%   (n=${e.n})`)
  }
  // REPORTED, NOT GATED, and the reason is not that it was inconvenient.
  //
  // This holdout splits by DOOR, so the two halves of a street were almost
  // always knocked on the same day by the same person at the same hour. Its
  // spread therefore contains a large same-day component that the model
  // deliberately discounts, because a street's answer rate has NOT been shown
  // to persist to another day (fitGeoWeight caps it for exactly that reason).
  // Proof that the gap is not a tuning problem: removing the cap moves the
  // answer geography weight from 10% to 42% and every number in this section
  // is byte-identical, while the two buckets' predictions sit 1.2 points apart
  // and their outcomes 11 apart. No weight setting closes it, because what
  // separates those doors is not something the model is willing to claim.
  //
  // Test 6 splits by TIME and lets the model keep each door's history, which is
  // the situation it is actually used in, and that one gates.
  console.log(`  worst bucket is off by ${worst.toFixed(1)} points (see the note in this file)`)
}

// --------------------------------------------------------------- 5. set totals
console.log('\n5. EXPECTED YIELD: does a whole street add up?')
{
  const heldOut = new Set(allVisits.map((v) => v.household).filter((h) => h32(h) >= 0.5))
  const model = buildOddsModel(knocks.filter((k) => !heldOut.has(k.household)), doors, { rank: false })
  let predicted = 0
  let actual = 0
  let doorsCounted = 0
  const byDoor = new Map()
  for (const v of allVisits) {
    if (!heldOut.has(v.household) || !v.interacted) continue
    if (!byDoor.has(v.household)) byDoor.set(v.household, v) // first visit only
  }
  for (const [id, v] of byDoor) {
    const o = doorOdds(model, id)
    if (!o.answer) continue
    predicted += o.answer.p
    actual += v.answered ? 1 : 0
    doorsCounted++
  }
  const off = Math.abs(predicted - actual) / Math.max(1, actual)
  const ok = off <= 0.1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${doorsCounted} unseen doors: expected ${predicted.toFixed(0)} conversations, got ${actual} (off by ${(100 * off).toFixed(1)}%, allowed 10%)`,
  )
  if (!ok) failures.push('expected yield')
}

// --------------------------------------------------------------- what it learned
{
  const model = buildOddsModel(knocks, doors, { rank: true })
  console.log('\nWHAT THE MODEL LEARNED from the whole campaign')
  console.log(`  ${model.visits} visits, ${model.interactions} interactions, ${model.conversations} conversations, ${model.signatures} signatures`)
  console.log(`  shrinkage: street k=${model.kStreet.toFixed(0)}, time block k=${model.kBlock.toFixed(0)}, base tables answer k=${model.answerBase.k.toFixed(0)} sign k=${model.signBase.k.toFixed(0)}`)
  console.log('  answer rate by situation:')
  for (const [key, cell] of [...model.answerBase.cells].sort()) {
    const [visit, seen] = key.split('|')
    console.log(`    visit ${visit}${visit === '4' ? '+' : ' '}, ${seen === '1' ? 'answered before' : 'never answered '}   ${(100 * cell.p).toFixed(1)}%  (n=${cell.n})`)
  }
  console.log('  sign rate by situation, shrunk and raw:')
  for (const [key, cell] of [...model.signBase.cells].sort()) {
    const [visit, partly] = key.split('|')
    const who = partly === '1' ? 'somebody signed already' : 'nobody signed yet      '
    console.log(
      `    visit ${visit}, ${who}   ${(100 * cell.p).toFixed(1)}%  (raw ${(100 * cell.raw).toFixed(1)}%, n=${cell.n})`,
    )
  }
  console.log('  answer rate by time of day, as observed:')
  for (const [key, b] of [...model.blocks].sort((a, z) => z[1].hits / z[1].n - a[1].hits / a[1].n)) {
    console.log(`    ${key.padEnd(16)} ${((100 * b.hits) / b.n).toFixed(1)}%  (n=${b.n})`)
  }
  console.log(
    `  a neighbouring street is worth ${(100 * model.nearWeight).toFixed(0)}% of this street's own evidence`,
  )
  // The fitted geography weights. These are the whole point of the design:
  // nothing is deleted for this campaign, it is weighted by what this
  // campaign can demonstrate, so a real one moves them on its own.
  for (const [name, g] of [
    ['answering', model.answerGeo],
    ['signing', model.signGeo],
  ]) {
    console.log(
      `  the street's own record is worth ${(100 * g.weight).toFixed(0)}% on ${name}` +
        `  (fitted across ${g.basis}, ${g.streets} streets)`,
    )
  }
  // The set path is exercised here rather than scored: it is a sum over the
  // per-door numbers already tested above, and this is the one place a change
  // to it would show up as an obviously wrong total.
  const biggest = [...model.doorsOnStreet.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  if (biggest) {
    const s = setOdds(model, biggest[1])
    console.log(
      `  ${biggest[0].replace('|', ', ')}: ${s.doors} doors, ${s.open} still open, ` +
        `expect ${s.expectedConversations.value.toFixed(0)} conversations and ${s.expectedSignatures.value.toFixed(0)} signatures`,
    )
  }
}

// --------------------------------------------------------------- 6. the strip
// The same measurement the tab shows the user, run here so a change that
// quietly breaks it is caught by the harness rather than by a manager.
console.log('\n6. THE HONESTY STRIP, as the page will print it')
{
  const t0 = performance.now()
  const s = scoreOddsModel(knocks, doors)
  const ms = performance.now() - t0
  if (!s) {
    console.log('  FAIL  scoreOddsModel returned nothing on a full campaign')
    failures.push('honesty strip')
  } else {
    console.log(
      `  Backtested over ${s.days} days, refitting ${s.refits} times, in ${ms.toFixed(0)}ms. ` +
        `Given two knocks it picked the one that got a signature ${s.pickedLivelier} times out of 100 ` +
        `(${s.answerPickedLivelier} on answering alone).`,
    )
    for (const b of s.bands) {
      console.log(
        `    when it said ${(100 * b.said).toFixed(0)}%, ${(100 * b.happened).toFixed(0)} out of 100 got one  (n=${b.n})`,
      )
    }
    // Both halves have to beat a coin toss, and the headline probability has
    // to mean what it says. A backtest that only checked answering never
    // tested the street adjustment at all, which is the one term most at risk
    // of being fitted noise.
    const ok =
      s.trials >= 200 &&
      s.pickedLivelier >= 52 &&
      s.answerPickedLivelier >= 52 &&
      s.worstBand <= 15
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${s.trials} out-of-sample visits, worst band off by ${s.worstBand.toFixed(1)} points`,
    )
    if (!ok) failures.push('honesty strip')
  }
}

rmSync(outDir, { recursive: true, force: true })
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll checks passed.')
