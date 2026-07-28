/**
 * What happens on the next knock (2026-07-27).
 *
 * The Odds tab used to be four campaign-wide charts. It is a PREDICTOR now:
 * name a house, a street, a turf or one canvasser's doors, and this says what
 * the next knock there is likely to get. It also runs behind a
 * campaign-manager-only readout on Talk and on the Scout and turf-cutter maps,
 * which is why the whole model lives in a plain module with no Vue, no
 * Supabase, and no DOM: it has to be buildable from data three different
 * screens already hold, and it has to be testable from Node (it is, by
 * scripts/verify-odds-model.ts).
 *
 * ===========================================================================
 * THE UNIT IS A VISIT, NOT A KNOCK, AND THAT IS NOT A DETAIL
 * ===========================================================================
 *
 * Knocks at one door within ten minutes are one trip: a couple both signing is
 * two knock_logs rows and one visit. Everything here collapses to visits first,
 * and the reason is not tidiness, it is that the per-knock numbers are WRONG in
 * a way that looks authoritative. Measured on the live data both ways:
 *
 *   answer rate on a 2nd visit to a door somebody has answered before
 *      per knock: 611/859  = 71.1%      <- the number this page used to imply
 *      per visit: 217/501  = 43.3%      <- the truth
 *
 * The per-knock version counts the second signature at a door as a second
 * successful trial. Same artefact inflated the household-size effect until it
 * vanished entirely under the per-visit count (see ROSTER SIZE below).
 *
 * ===========================================================================
 * THE MODEL, AND WHY IT IS SHAPED LIKE THIS
 * ===========================================================================
 *
 * Two stages, matching the two words the rest of the app already uses:
 *
 *   P(signature) = P(somebody answers) x P(they sign | somebody answered)
 *
 * Both stages are the same machine: a campaign-wide BASE RATE for the exact
 * situation this door is in, then SHRUNKEN log-odds adjustments for everything
 * else we know. An adjustment is measured against what the base already
 * expects for that group's own mix of situations, never against the campaign
 * average: a street that has only ever been knocked once must not be compared
 * with a street that has been walked four times.
 *
 * Every shrinkage constant is estimated from the data by method of moments
 * (see `momentsK`), never picked by feel. That is what makes the whole thing
 * safe: where a signal is weak, k comes out large, the adjustment comes out
 * small, and the estimate stays near the campaign baseline instead of
 * inventing a story out of nine knocks.
 *
 * WHICH ADJUSTMENTS APPLY WHERE was settled by backtest, not by taste, and the
 * split is the most interesting thing the data had to say:
 *
 *   WHETHER SOMEBODY IS HOME depends on the household's own history and on the
 *   TIME OF DAY. It does NOT depend on the street.
 *
 *   WHETHER THEY SIGN depends on the STREET. It does not measurably depend on
 *   the time, the visit number, or how many people live there.
 *
 * The evidence, all of it out of sample (harness in the scratchpad of the
 * 2026-07-27 session; every figure below is a real measurement, not an
 * estimate):
 *
 *  - Base table (visit x ever-answered-here), prequential over the last 22
 *    days: log loss 0.6523 against 0.6643 for a flat campaign rate, AUC 0.565.
 *    Adding the time block took it to 0.6445 / AUC 0.610, the single biggest
 *    improvement available.
 *  - Street adjustment on the SIGN half, holding out half of every street's
 *    doors: AUC 0.520 -> 0.632, log loss 0.700 -> 0.673. Recomputed using only
 *    evidence from OTHER DAYS, to rule out "the crew was there on a good
 *    evening": AUC 0.532 -> 0.593. So about half the raw effect was same-day
 *    echo and half is a real, persistent property of the street. It survives.
 *  - Street adjustment on the ANSWER half, same test: the whole effect is the
 *    same-day echo. Excluding same-day evidence it is worth nothing at all
 *    (log loss 0.6091 with no street term, 0.6107 with one). So there is no
 *    street term on the answer half. That is a deliberate absence.
 *  - NEARBY STREETS were asked for by name ("this street and whatever streets
 *    directly connect with it, we add those in"). Honest result: on this data
 *    they are worth close to nothing. Predicting a whole untouched street from
 *    its neighbours alone moved AUC 0.5192 -> 0.5236 on the sign half and was
 *    slightly NEGATIVE on the answer half. They are kept anyway, for two
 *    reasons that are not sentimental: they are the only thing that has
 *    anything to say about a street nobody has knocked yet (80% of doors have
 *    knocked neighbours against 37% whose own street has been knocked), and
 *    method-of-moments shrinkage means they contribute exactly as much as they
 *    earn, which here is a whisper the evidence chain shows honestly. A real
 *    campaign may cluster harder than this simulated one; if it does, k drops
 *    and they start to count without anyone editing this file.
 *  - ROSTER SIZE is deliberately absent. Per knock it looked strong (answer
 *    35.7% at a one-person household against 42.5% at a two-person one). Per
 *    VISIT it is flat: 35.7% / 38.2% / 36.2%, and sign rate 44.9% / 45.1% /
 *    44.7%. It was the same-visit artefact again. Dropping it also means this
 *    module never has to load the 43.5k-row persons table.
 *  - PRIOR NOT-HOMES as a separate input is absent for the same kind of
 *    reason: it is nearly collinear with the visit number once you know
 *    whether anybody has ever answered (visit 2 never answered = 24.1%,
 *    prior-not-homes 1 and never answered = 24.1%). The base cell already
 *    carries it.
 *
 * ===========================================================================
 * WHAT THIS DOES NOT CLAIM
 * ===========================================================================
 *
 * The range on every number is how sure we are of the RATE, not what this one
 * door will do. A door either answers or it does not. Sixty percent means six
 * doors in ten, not a door that is 60% open.
 *
 * IT BARELY TELLS TWO DOORS APART, and the screen has to admit that. 7,136 of
 * the 8,803 doors ever knocked have exactly one visit, so for the ordinary
 * door there is no door-specific evidence at all and every unknocked house on
 * a street gets nearly the same number. Out of sample it picks the livelier of
 * two doors about 57 times in 100. Where it earns its keep is repeat visits,
 * time of day, and totals over a whole street or turf, where the per door
 * noise averages out. `scoreOddsModel` measures exactly this and the tab shows
 * the measurement, rather than a claim written once and left to rot.
 *
 * The strongest cell is also the most selected one. streetWalk's
 * CLOSED_OUTCOMES means the walk never returns to a door that refused, so
 * "somebody answered here before" at a second visit is mostly doors that asked
 * us to come back. That cell is a description of the doors the campaign chose
 * to revisit, not a law about doors that answer once.
 *
 * And the obvious free cross-check is NOT one: netlify/functions/chat.ts tells
 * the assistant that answer odds rise after contact and fall with each
 * no-answer, but that sentence and this history came from the same simulator,
 * so agreeing with it proves nothing. Nothing here is validated against real
 * knocks yet. Every constant is estimated at run time rather than written
 * down, which is what lets the model re-fit itself the day real ones arrive.
 *
 * A door the walk would never return to (everyone signed, or the last outcome
 * was Not Interested, Skip or Hostile) has no next knock, so it gets no
 * number at all. See `closedReason`. Printing a confident probability for a
 * door nobody will ever knock again is the one failure mode worth designing
 * against, because it is the one that looks most like working.
 */

import type { KnockOutcome } from '@/types'
import { streetNameOf } from './streetWalk'
import { wilson } from './stats'

// ---------------------------------------------------------------- inputs

/** One knock, as every caller already has it. */
export interface OddsKnock {
  household: string
  ts: number
  outcome: KnockOutcome
}

/** One door. `street` is the full line ("123 WALNUT ST"): the street name is
 *  parsed out with streetWalk's own streetNameOf, never a second parser.
 *
 *  `residents` is the roster size. It is NOT an input to either probability
 *  (see the header on why household size dropped out); it is only how a door
 *  where everybody has signed is told from one where somebody has. Leave it
 *  out and a partly signed door will never be recognised as finished. */
export interface OddsDoor {
  id: string
  street: string
  city: string
  lat: number | null
  lng: number | null
  residents?: number
  turf_id?: string | null
}

// ---------------------------------------------------------------- constants

/** Somebody answered. The same four outcomes the Analytics page calls a
 *  conversation. */
const CONVERSATION = new Set<KnockOutcome>(['signed', 'didnt_sign', 'maybe', 'hostile'])
/** The canvasser tried the door: everything except a Skip, which is a pass. */
const isInteraction = (o: KnockOutcome) => o !== 'skip'

/** Latest outcomes that retire a door, straight from streetWalk's own list. */
const CLOSED = new Set<KnockOutcome>(['hostile', 'didnt_sign', 'skip'])

/** Two knocks at one door inside this window are one trip. */
const SAME_VISIT_MS = 10 * 60 * 1000

/** Visit numbers past this are pooled. Beyond a 4th visit the campaign has a
 *  few hundred trials, not thousands, and the curve has flattened anyway. */
const MAX_VISIT_CELL = 4

/** A base cell needs this many trials before it counts toward the estimate of
 *  how much the cells really differ. */
const CELL_MIN_GROUP = 30

/** Two streets "connect" when a door of one is within this many metres of a
 *  door of the other. No street geometry exists anywhere in this app, so the
 *  doors themselves are the only evidence of a corner. 150m is generous enough
 *  to catch a corner across a wide intersection and tight enough that a street
 *  one block over does not qualify: it gives a median of about 6 neighbours. */
const NEAR_METRES = 150

/** Bounds on every estimated shrinkage constant. The floor stops a freak
 *  variance estimate handing a 6-knock street the whole answer; the ceiling
 *  stops a degenerate one silently switching an adjustment off. */
const K_MIN = 10
const K_MAX = 400

/** Used when there are too few populated groups to estimate k at all. */
const K_FALLBACK = 60

/** A group needs this many trials before it counts toward the variance
 *  estimate. Below it the binomial noise correction is doing all the work. */
const K_MIN_GROUP = 15

const METRES_PER_DEG_LAT = 111_320

// ---------------------------------------------------------------- math

const logit = (p: number) => Math.log(p / (1 - p))
const expit = (z: number) => 1 / (1 + Math.exp(-z))
/** Keeps logit finite. A campaign really can have a cell at 0 or 1. */
const clamp01 = (p: number) => Math.min(0.995, Math.max(0.005, p))

interface Tally {
  n: number
  hits: number
  /** Sum of the base-rate expectation over this group's own trials. Comparing
   *  against this rather than against the campaign average is what stops a
   *  street that has only ever had first visits looking unusually friendly. */
  expected: number
}

const emptyTally = (): Tally => ({ n: 0, hits: 0, expected: 0 })

/**
 * Method of moments for a shrinkage constant.
 *
 * For groups with n trials each, E[(observed - expected)^2] = sigma^2 +
 * p(1-p)/n, so subtracting the binomial noise from the observed spread leaves
 * the genuine between-group variance. A Beta prior with that variance has
 * concentration k = p(1-p)/sigma^2, which is exactly the number of pseudo
 * trials to mix in: a group with n trials then moves n/(n+k) of the way from
 * the baseline to its own observed rate.
 *
 * The whole safety property of this module rests here. Where a signal is not
 * real, sigma^2 collapses to the floor, k comes out at the ceiling, and the
 * adjustment is a whisper. Nobody has to decide that by hand per campaign.
 */
function momentsK(groups: Iterable<Tally>, minGroup = K_MIN_GROUP, minGroups = 8): number {
  let total = 0
  let spread = 0
  let noise = 0
  let expectedSum = 0
  let used = 0
  for (const g of groups) {
    if (g.n < minGroup) continue
    const x = clamp01(g.expected / g.n)
    const r = g.hits / g.n
    total += g.n
    spread += g.n * (r - x) ** 2
    // n * [x(1-x)/n] collapses to x(1-x)
    noise += x * (1 - x)
    expectedSum += g.expected
    used++
  }
  if (used < minGroups || total === 0) return K_FALLBACK
  const p = clamp01(expectedSum / total)
  const sigma2 = spread / total - noise / total
  if (!(sigma2 > 0)) return K_MAX
  return Math.min(K_MAX, Math.max(K_MIN, (p * (1 - p)) / sigma2))
}

/** A group's shrunken log-odds adjustment, plus how much evidence is behind
 *  it. `prior` is the adjustment to fall back toward, in log-odds: 0 means the
 *  campaign baseline, and the street level passes its neighbourhood's. */
function offsetOf(g: Tally, k: number, prior = 0): { delta: number; n: number } {
  if (g.n === 0) return { delta: prior, n: 0 }
  const pbar = clamp01(g.expected / g.n)
  const target = clamp01(expit(logit(pbar) + prior))
  const shrunk = clamp01((g.hits + k * target) / (g.n + k))
  return { delta: logit(shrunk) - logit(pbar), n: g.n }
}

// ---------------------------------------------------------------- visits

/** A door's whole record, as it stood at some moment. */
export interface DoorState {
  visits: number
  /** Anybody has ever come to this door. */
  everAnswered: boolean
  /** Distinct residents who have signed. */
  signed: number
  lastOutcome: KnockOutcome | null
  lastTs: number
}

interface Visit {
  household: string
  ts: number
  /** Which visit this was, 1-based. */
  visit: number
  /** State BEFORE this visit. */
  everAnswered: boolean
  partlySigned: boolean
  block: string
  interacted: boolean
  answered: boolean
  signed: boolean
}

/** Time blocks. Four parts of the day crossed with weekday/weekend, which is
 *  the coarsest cut that keeps the real pattern: on this campaign weekday
 *  mornings answer 25.1% and weekday evenings 42.3%, while every weekend block
 *  sits around 40 to 45%. Hour-by-hour would be 168 cells of noise. */
const BLOCK_ORDER = [
  'morning|wd', 'midday|wd', 'afternoon|wd', 'evening|wd',
  'morning|we', 'midday|we', 'afternoon|we', 'evening|we',
] as const
export type TimeBlockKey = (typeof BLOCK_ORDER)[number]

const BLOCK_LABEL: Record<string, string> = {
  'morning|wd': 'Weekday morning',
  'midday|wd': 'Weekday midday',
  'afternoon|wd': 'Weekday afternoon',
  'evening|wd': 'Weekday evening',
  'morning|we': 'Weekend morning',
  'midday|we': 'Weekend midday',
  'afternoon|we': 'Weekend afternoon',
  'evening|we': 'Weekend evening',
}

/** Spelled out where a block label alone would not tell somebody when to go. */
const BLOCK_HOURS: Record<string, string> = {
  morning: 'before noon',
  midday: 'noon to 3 PM',
  afternoon: '3 to 5 PM',
  evening: 'after 5 PM',
}

export function blockOf(ts: number): TimeBlockKey {
  const d = new Date(ts)
  const h = d.getHours()
  const wd = d.getDay()
  const part = h < 12 ? 'morning' : h < 15 ? 'midday' : h < 17 ? 'afternoon' : 'evening'
  return `${part}|${wd === 0 || wd === 6 ? 'we' : 'wd'}` as TimeBlockKey
}

export const blockLabel = (key: string) => BLOCK_LABEL[key] ?? key
export const blockHours = (key: string) => BLOCK_HOURS[key.split('|')[0]] ?? ''

/**
 * Collapse knocks into visits and carry each door's state forward.
 *
 * Knocks arrive in whatever order the caller has them; this sorts. The state
 * captured on a visit is the state BEFORE it, which is exactly what would have
 * been known standing on the porch.
 */
function collapse(knocks: OddsKnock[]): { visits: Visit[]; state: Map<string, DoorState> } {
  const sorted = [...knocks].sort((a, b) => a.ts - b.ts)
  const state = new Map<string, DoorState>()
  // The open visit is tracked PER DOOR, not as one rolling "current". Knocks
  // are sorted by time across the whole campaign, so two knocks at one door
  // ten minutes apart almost always have other doors' knocks between them: a
  // single cursor would open a fresh visit for the second one and quietly
  // inflate every repeat-visit count in the model.
  const open = new Map<string, Visit>()
  const visits: Visit[] = []
  for (const k of sorted) {
    let st = state.get(k.household)
    if (!st) {
      st = { visits: 0, everAnswered: false, signed: 0, lastOutcome: null, lastTs: -Infinity }
      state.set(k.household, st)
    }
    let visit = open.get(k.household)
    if (!visit || st.visits === 0 || k.ts - st.lastTs >= SAME_VISIT_MS) {
      st.visits++
      visit = {
        household: k.household,
        ts: k.ts,
        visit: st.visits,
        everAnswered: st.everAnswered,
        partlySigned: st.signed > 0,
        block: blockOf(k.ts),
        interacted: false,
        answered: false,
        signed: false,
      }
      visits.push(visit)
      open.set(k.household, visit)
    }
    if (isInteraction(k.outcome)) visit.interacted = true
    if (CONVERSATION.has(k.outcome)) visit.answered = true
    if (k.outcome === 'signed') visit.signed = true
    st.lastTs = k.ts
    st.lastOutcome = k.outcome
    if (CONVERSATION.has(k.outcome)) st.everAnswered = true
    if (k.outcome === 'signed') st.signed++
  }
  return { visits, state }
}

// ---------------------------------------------------------------- model

const answerCell = (visit: number, everAnswered: boolean) =>
  `${Math.min(visit, MAX_VISIT_CELL)}|${everAnswered ? 1 : 0}`
const signCell = (visit: number, partlySigned: boolean) =>
  `${Math.min(visit, 3)}|${partlySigned ? 1 : 0}`

interface BaseTable {
  global: number
  globalN: number
  cells: Map<string, { p: number; n: number; raw: number }>
  /** How hard the cells were pulled toward the campaign rate. Large means the
   *  cells were not really different from each other. */
  k: number
}

/**
 * A base table is shrunk by the same rule as everything else here, and that is
 * the whole reason the sign half behaves.
 *
 * A fixed prior was tried first and it is subtly wrong in both directions at
 * once. The ANSWER cells are genuinely far apart (39.7% at a fresh door, 17.6%
 * on a fourth visit nobody has ever answered) and a fixed prior blunts a real
 * signal; the SIGN cells are 44% to 52% on samples of 23 to 3432, which is
 * noise wearing a pattern, and a fixed prior leaves most of it in place. Both
 * failures are invisible until something is scored: measured out of sample,
 * the fixed-prior sign table predicted day-to-day signing WORSE than simply
 * quoting the campaign average.
 *
 * Estimating k from the spread between the cells fixes both at once and
 * removes a hand-picked number. On this campaign it lands near the floor for
 * the answer table, which keeps its cells, and at the ceiling for the sign
 * table, which collapses toward one rate. If a future campaign really does
 * sign differently on a second visit, the same line notices.
 */
function baseTableOf(
  visits: Visit[],
  den: (v: Visit) => boolean,
  num: (v: Visit) => boolean,
  cellOf: (v: Visit) => string,
): BaseTable {
  let n = 0
  let hits = 0
  const raw = new Map<string, { n: number; hits: number }>()
  for (const v of visits) {
    if (!den(v)) continue
    n++
    if (num(v)) hits++
    const key = cellOf(v)
    const e = raw.get(key) ?? { n: 0, hits: 0 }
    e.n++
    if (num(v)) e.hits++
    raw.set(key, e)
  }
  const global = clamp01(n ? hits / n : 0.4)
  // Each cell's "expected" is simply the campaign rate: that is what it would
  // be if the situation made no difference, which is the null this is testing.
  const k = momentsK(
    [...raw.values()].map((e) => ({ n: e.n, hits: e.hits, expected: e.n * global })),
    CELL_MIN_GROUP,
    3,
  )
  const cells = new Map<string, { p: number; n: number; raw: number }>()
  for (const [key, e] of raw) {
    cells.set(key, {
      p: clamp01((e.hits + k * global) / (e.n + k)),
      n: e.n,
      raw: e.hits / e.n,
    })
  }
  return { global, globalN: n, cells, k }
}

const cellAt = (t: BaseTable, key: string) =>
  t.cells.get(key) ?? { p: t.global, n: t.globalN, raw: t.global }

/**
 * Everything needed to say "compared with what".
 *
 * A number on its own is not an answer: 42% is encouraging for a fourth visit
 * and dismal for a fresh door. Two comparisons are carried, deliberately both,
 * because they answer different questions and confusing them is the easiest
 * way to mislead somebody:
 *
 *   AGAINST EVERY DOOR: is this worth knocking at all. What a manager means by
 *   "how does this street compare".
 *
 *   AGAINST DOORS IN THE SAME SITUATION: is this street or house unusual. A
 *   third visit that answers 22% is not a bad street, it is a third visit.
 *
 * `verdict` is only allowed to say above or below when the campaign figure
 * falls OUTSIDE the estimate's own range. Inside it, the honest word is
 * typical, however different the two numbers look.
 */
export interface Benchmark {
  /** The campaign-wide figure on the same denominator. */
  campaign: number
  /** Percentage points above (positive) or below it. */
  lift: number
  verdict: 'above' | 'below' | 'typical'
}

function benchmark(est: Estimate | null, campaign: number): Benchmark {
  if (!est) return { campaign, lift: 0, verdict: 'typical' }
  const inside = campaign >= est.lo && campaign <= est.hi
  return {
    campaign,
    lift: (est.p - campaign) * 100,
    verdict: inside ? 'typical' : est.p > campaign ? 'above' : 'below',
  }
}

export interface OddsModel {
  /** Every door's record as it stands now. */
  state: Map<string, DoorState>
  streetOf: Map<string, string>
  residentsOf: Map<string, number>
  /** Doors on each street, so a street scope needs no second index. */
  doorsOnStreet: Map<string, string[]>
  answerBase: BaseTable
  signBase: BaseTable
  /** Answer rate by time block, as shrunken adjustments plus their raw rates. */
  blocks: Map<string, { delta: number; n: number; hits: number }>
  /** Street and neighbourhood adjustments to the SIGN half only. */
  streetSign: Map<string, Tally>
  kStreet: number
  /** 0 to 1: how much of a neighbourhood's lean carries to a street, measured
   *  on this campaign's own data. Near 0 means knocking next door tells you
   *  nothing about here. */
  nearWeight: number
  kBlock: number
  /** Lazily resolved and memoised: which streets connect to this one. */
  neighboursOf: (street: string) => string[]
  /** Every knockable door's chance of a signature, sorted ascending. The
   *  yardstick behind "better than 78% of doors in the campaign". */
  doorScores: Float64Array
  /** Streets with enough evidence to be ranked, friendliest first. */
  streetRanking: { key: string; sign: number; n: number }[]
  /** What one knock is worth at a door picked at random. */
  campaignAnswer: number
  campaignSign: number
  campaignSignature: number
  /** Totals, for the "what this is built on" line. */
  visits: number
  interactions: number
  conversations: number
  signatures: number
  streets: number
}

/**
 * Build the model. Pure: hand it knocks and doors and it holds no references
 * to anything else. Roughly 60ms on the live 11.7k knocks / 22.7k doors.
 */
export function buildOddsModel(
  knocks: OddsKnock[],
  doors: OddsDoor[],
  // Ranking scores every door in the county, which is most of the build cost
  // and is only ever read by the Analytics tab. Talk and the maps ask about
  // one door and skip it.
  opts: { rank?: boolean } = {},
): OddsModel {
  const { visits, state } = collapse(knocks)

  const streetOf = new Map<string, string>()
  const doorsOnStreet = new Map<string, string[]>()
  const residentsOf = new Map<string, number>()
  for (const d of doors) {
    const key = `${streetNameOf(d.street)}|${d.city}`
    streetOf.set(d.id, key)
    if (d.residents) residentsOf.set(d.id, d.residents)
    const list = doorsOnStreet.get(key)
    if (list) list.push(d.id)
    else doorsOnStreet.set(key, [d.id])
  }

  const answerBase = baseTableOf(
    visits,
    (v) => v.interacted,
    (v) => v.answered,
    (v) => answerCell(v.visit, v.everAnswered),
  )
  const signBase = baseTableOf(
    visits,
    (v) => v.answered,
    (v) => v.signed,
    (v) => signCell(v.visit, v.partlySigned),
  )

  // Time of day, on the answer half. Measured against what the base already
  // expects for that block's own mix, so "evenings are better" cannot just be
  // "evenings are when the repeat visits happen".
  const blockTally = new Map<string, Tally>()
  for (const v of visits) {
    if (!v.interacted) continue
    const e = blockTally.get(v.block) ?? emptyTally()
    e.n++
    if (v.answered) e.hits++
    e.expected += cellAt(answerBase, answerCell(v.visit, v.everAnswered)).p
    blockTally.set(v.block, e)
  }
  const kBlock = momentsK(blockTally.values(), 50)
  const blocks = new Map<string, { delta: number; n: number; hits: number }>()
  for (const [key, t] of blockTally) {
    blocks.set(key, { ...offsetOf(t, kBlock), hits: t.hits })
  }

  // Street, on the sign half only. See the header: on the answer half the
  // street effect is entirely a same-day echo and is deliberately absent.
  const streetSign = new Map<string, Tally>()
  for (const v of visits) {
    if (!v.answered) continue
    const key = streetOf.get(v.household)
    if (!key) continue
    const e = streetSign.get(key) ?? emptyTally()
    e.n++
    if (v.signed) e.hits++
    e.expected += cellAt(signBase, signCell(v.visit, v.partlySigned)).p
    streetSign.set(key, e)
  }
  const kStreet = momentsK(streetSign.values())
  const neighboursOf = neighbourIndex(doors)
  // How much a street's neighbours are worth is MEASURED, not assumed. See
  // fitNeighbourWeight: on this campaign it comes back near zero, and that is
  // the honest answer rather than a reason to drop the level.
  const nearWeight = fitNeighbourWeight(streetSign, neighboursOf, kStreet)

  const model: OddsModel = {
    state,
    streetOf,
    residentsOf,
    doorsOnStreet,
    answerBase,
    signBase,
    blocks,
    streetSign,
    kStreet,
    nearWeight,
    kBlock,
    neighboursOf,
    doorScores: new Float64Array(0),
    streetRanking: [],
    campaignAnswer: answerBase.global,
    campaignSign: signBase.global,
    campaignSignature: answerBase.global * signBase.global,
    visits: visits.length,
    interactions: visits.filter((v) => v.interacted).length,
    conversations: visits.filter((v) => v.answered).length,
    signatures: visits.filter((v) => v.signed).length,
    streets: doorsOnStreet.size,
  }

  if (!opts.rank) return model

  // The two yardsticks. Both need a finished model to score against, so they
  // are filled in afterwards rather than threaded through everything above.
  const scores: number[] = []
  for (const d of doors) {
    const o = doorOdds(model, d.id)
    if (o.signature) scores.push(o.signature.p)
  }
  scores.sort((a, b) => a - b)
  model.doorScores = Float64Array.from(scores)

  // A street is rankable once it has enough conversations to say anything.
  // Below that the shrinkage has pulled it onto the campaign average anyway,
  // so a rank would be a list of ties pretending to be an order.
  //
  // Ranked on the street's rate for a FRESH door, not for whichever door
  // happens to be first in the list: a street whose first house is on its
  // fourth visit would otherwise be compared against streets on their first.
  // Comparing like with like is the whole point of a ranking.
  for (const [key, t] of streetSign) {
    if (t.n < K_MIN_GROUP) continue
    model.streetRanking.push({ key, sign: streetSignRate(model, key).p, n: t.n })
  }
  model.streetRanking.sort((a, b) => b.sign - a.sign)

  return model
}

/**
 * How much a street's neighbours actually tell you about it, from 0 to 1.
 *
 * "This street and whatever streets directly connect with it, we add those in.
 * Hoping to get a large enough sample for it to skew things. But we don't
 * wanna make it too heavy either." The last sentence is the hard part, and
 * guessing at it is how a model starts inventing things: a pool of six streets
 * carries several hundred conversations, so ordinary shrinkage alone would
 * hand it most of the weight simply for being large, whether or not a
 * neighbouring street has ever predicted anything.
 *
 * So it is fitted. For every street with enough of its own evidence, take how
 * far its neighbours lean (excluding itself) and how far it leans, and
 * regress the second on the first. The slope IS the answer to "how heavy":
 * 1 means a street is its neighbourhood, 0 means the neighbourhood says
 * nothing. Weighted by each street's own sample, clamped to [0, 1] because a
 * negative slope is noise rather than a discovery that neighbours are
 * opposites.
 *
 * Noise in the neighbourhood offset attenuates the slope toward 0, which is
 * left uncorrected on purpose: erring toward the campaign baseline is the safe
 * direction for a number somebody plans a Saturday around.
 *
 * On the live campaign this comes back at roughly 0.1, and the backtest agrees
 * it should: predicting a whole untouched street from its neighbours alone
 * moved AUC from 0.519 to 0.524. The level stays because it is the only thing
 * with anything at all to say about ground nobody has knocked, and because a
 * real campaign that clusters harder will push this number up on its own.
 */
function fitNeighbourWeight(
  streetSign: Map<string, Tally>,
  neighboursOf: (street: string) => string[],
  kStreet: number,
): number {
  let sxy = 0
  let sxx = 0
  for (const [street, own] of streetSign) {
    if (own.n < K_MIN_GROUP) continue
    let n = 0
    let hits = 0
    let expected = 0
    for (const other of neighboursOf(street)) {
      const t = streetSign.get(other)
      if (!t) continue
      n += t.n
      hits += t.hits
      expected += t.expected
    }
    if (n < 20) continue
    const near = offsetOf({ n, hits, expected }, kStreet)
    const mine = offsetOf(own, 0)
    sxy += own.n * near.delta * mine.delta
    sxx += own.n * near.delta * near.delta
  }
  if (sxx <= 0) return 0
  return Math.min(1, Math.max(0, sxy / sxx))
}

/**
 * Which streets connect to which, from door coordinates alone.
 *
 * Built as a grid of every geocoded door, then resolved per street on demand
 * and memoised: the Odds tab only ever asks about streets it is showing, and
 * the Talk and map readouts ask about exactly one. Building the whole graph up
 * front would be several hundred milliseconds of work almost none of which any
 * screen uses.
 *
 * Geocoding is uneven (Marysville is 97% located, Plain City 13%), so plenty
 * of streets resolve to no neighbours at all. That is handled where it lands:
 * an empty neighbourhood contributes nothing and the estimate falls back to
 * the campaign baseline, which is the honest answer for ground nobody has been
 * near.
 */
function neighbourIndex(doors: OddsDoor[]): (street: string) => string[] {
  interface P { s: string; x: number; y: number }
  const cells = new Map<string, P[]>()
  const byStreet = new Map<string, P[]>()
  for (const d of doors) {
    if (d.lat == null || d.lng == null) continue
    const y = d.lat * METRES_PER_DEG_LAT
    const x = d.lng * METRES_PER_DEG_LAT * Math.cos((d.lat * Math.PI) / 180)
    const p: P = { s: `${streetNameOf(d.street)}|${d.city}`, x, y }
    const key = `${Math.floor(x / NEAR_METRES)},${Math.floor(y / NEAR_METRES)}`
    const c = cells.get(key)
    if (c) c.push(p)
    else cells.set(key, [p])
    const b = byStreet.get(p.s)
    if (b) b.push(p)
    else byStreet.set(p.s, [p])
  }
  const memo = new Map<string, string[]>()
  const R2 = NEAR_METRES * NEAR_METRES
  return (street: string) => {
    let hit = memo.get(street)
    if (hit) return hit
    const mine = byStreet.get(street)
    // Two DISTINCT doors of ours have to be near a street before it counts as
    // connected. One is a geocode: 136 doors once sat stacked on 9 exact
    // coordinates in this very table, 83 of them on a town centroid, and a
    // single bad one must not be able to invent a corner that isn't there.
    const votes = new Map<string, Set<number>>()
    if (mine) {
      for (let i = 0; i < mine.length; i++) {
        const p = mine[i]
        const cx = Math.floor(p.x / NEAR_METRES)
        const cy = Math.floor(p.y / NEAR_METRES)
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const q of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
              if (q.s === street) continue
              if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 > R2) continue
              const v = votes.get(q.s)
              if (v) v.add(i)
              else votes.set(q.s, new Set([i]))
            }
          }
        }
      }
    }
    hit = [...votes.entries()].filter(([, v]) => v.size >= 2).map(([s]) => s)
    memo.set(street, hit)
    return hit
  }
}

// ---------------------------------------------------------------- prediction

export interface Estimate {
  p: number
  lo: number
  hi: number
  /** Effective trials behind the estimate. The whiskers everywhere else on
   *  Analytics are Wilson intervals on a count, so this is one too. */
  n: number
}

/**
 * A Wilson interval at an effective sample size.
 *
 * In log-odds the variance of the estimate is the base cell's plus the
 * adjustment's, and a binomial proportion's variance in log-odds is
 * 1/(n p (1-p)). So the two combine as 1/n_eff = 1/n_base + 1/(n_group + k),
 * and the interval is the ordinary Wilson one at n_eff. A door on a street
 * nobody has knocked lands at roughly n_eff = k, which is right: we know the
 * campaign rate precisely and still have no idea which way this street leans.
 *
 * `k` of 0 means there is no group term at all rather than a group term with
 * no evidence, so its variance contribution is zero and n_eff is the base's
 * own count. Collapsing those two cases is what makes a well measured campaign
 * rate come back as "give or take 40 percentage points".
 */
function estimate(p: number, nBase: number, nGroup = 0, k = 0): Estimate {
  const group = k > 0 ? Math.max(1, nGroup + k) : Infinity
  const nEff = 1 / (1 / Math.max(1, nBase) + 1 / group)
  const w = wilson(p * nEff, nEff)
  return { p, lo: w.lo, hi: w.hi, n: Math.round(nEff) }
}

/** One line of the chain that produced a number: what was taken into account,
 *  where the estimate stood afterwards, and how much evidence moved it. */
export interface EvidenceStep {
  label: string
  detail: string
  /** The running estimate AFTER this step. */
  p: number
  /** Change in percentage points this step made. */
  shift: number
  n: number
}

export type ClosedReason = 'signed' | 'refused' | 'hostile' | 'skipped'

const CLOSED_TEXT: Record<ClosedReason, string> = {
  signed: 'Everybody here has signed.',
  refused: 'Not Interested, so the walk does not come back.',
  hostile: 'Hostile, so the walk does not come back.',
  skipped: 'Skipped, so the walk does not come back.',
}

export interface DoorOdds {
  household: string
  /** Which visit the next knock would be. */
  visit: number
  everAnswered: boolean
  partlySigned: boolean
  signed: number
  residents: number
  lastOutcome: KnockOutcome | null
  /** Set when the walk would never send anybody back. Every probability below
   *  is null in that case: a door with no next knock has no next-knock odds. */
  closed: ClosedReason | null
  closedNote: string
  answer: Estimate | null
  /** Chance of a signature GIVEN somebody answers. */
  sign: Estimate | null
  /** Chance this one knock ends in a signature. */
  signature: Estimate | null
  answerWhy: EvidenceStep[]
  signWhy: EvidenceStep[]
  /** Answer chance by time of day, best first. Empty when the door is closed. */
  bestTimes: { key: string; label: string; hours: string; p: number; n: number }[]
  street: string | null
  /** Against every door in the campaign: is this one worth knocking. */
  vsCampaign: { answer: Benchmark; sign: Benchmark; signature: Benchmark } | null
  /** Against doors in the SAME situation: is this street unusual. */
  vsSimilar: Benchmark | null
}

function closedReasonOf(st: DoorState | undefined, residents: number): ClosedReason | null {
  if (!st || st.visits === 0) return null
  if (residents > 0 && st.signed >= residents) return 'signed'
  if (st.lastOutcome && CLOSED.has(st.lastOutcome)) {
    return st.lastOutcome === 'hostile' ? 'hostile' : st.lastOutcome === 'skip' ? 'skipped' : 'refused'
  }
  return null
}

/**
 * The geography half of the sign estimate, as one chain: campaign base, then
 * the streets that connect to this one, then the street itself.
 *
 * Shared by `doorOdds` and by the street ranking so the two can never disagree
 * about what a street's rate is. `groupN` and `groupK` come back together
 * because evidence pooled from neighbours is not evidence about this street:
 * it buys a wider prior, and carrying only a count would lose that.
 */
function signChain(
  model: OddsModel,
  street: string | null,
  cellP: number,
): { p: number; why: EvidenceStep[]; groupN: number; groupK: number } {
  let z = logit(cellP)
  const why: EvidenceStep[] = []
  let groupN = 0
  let groupK = model.kStreet
  if (street) {
    const near = pooledNear(model, street)
    // Shrunk for its own sampling noise, then scaled by how much a
    // neighbourhood has been worth on this campaign at all.
    const raw = offsetOf(near, model.kStreet)
    const nearOff = { delta: raw.delta * model.nearWeight, n: raw.n }
    if (near.n > 0) {
      const after = clamp01(expit(z + nearOff.delta))
      why.push({
        label: 'Streets that connect to this one',
        detail: `${near.hits} of ${near.n} conversations nearby ended in a signature`,
        p: after,
        shift: (after - expit(z)) * 100,
        n: near.n,
      })
      z = logit(after)
      // The neighbourhood is worth `nearWeight` of a street's evidence, so it
      // buys that share of the concentration a street of the same size would.
      groupK = model.nearWeight > 0 ? model.kStreet / model.nearWeight : K_MAX
    }
    const own = model.streetSign.get(street) ?? emptyTally()
    if (own.n > 0) {
      // The street shrinks toward its neighbourhood, so the two levels are one
      // chain rather than two adjustments applied to the same baseline.
      const withPrior = offsetOf(own, model.kStreet, nearOff.delta)
      const after = clamp01(expit(logit(cellP) + withPrior.delta))
      why.push({
        label: 'This street',
        // The expected count is what makes this hand-checkable, and it is the
        // only line on the page a canvasser who knows the street can argue
        // with: 29 signed where 27 were expected is a street a little above
        // average, and anyone can see that is not much.
        detail:
          `${own.hits} of ${own.n} conversations here ended in a signature, ` +
          `against ${own.expected.toFixed(0)} expected`,
        p: after,
        shift: (after - expit(z)) * 100,
        n: own.n,
      })
      z = logit(after)
      groupN = own.n
      groupK = model.kStreet
    }
  }
  return { p: clamp01(expit(z)), why, groupN, groupK }
}

/**
 * A street's sign rate for a FRESH door, which is what makes two streets
 * comparable: a street whose houses are mostly on a third visit is not
 * friendlier than one on its first, it has simply been worked harder.
 */
export function streetSignRate(model: OddsModel, street: string): Estimate {
  const cell = cellAt(model.signBase, signCell(1, false))
  const chain = signChain(model, street, cell.p)
  return estimate(chain.p, cell.n, chain.groupN, chain.groupK)
}

/**
 * Where a probability sits among every knockable door in the campaign, 0 to
 * 100. The plain answer to "compare this house to everything".
 */
export function percentileOf(model: OddsModel, p: number): number | null {
  const s = model.doorScores
  if (!s.length) return null
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s[mid] < p) lo = mid + 1
    else hi = mid
  }
  return Math.round((100 * lo) / s.length)
}

/**
 * The odds at one door.
 *
 * `residents` overrides the roster size the model was built with, for callers
 * that know better (Talk has the roster in hand). It is used only to tell a
 * fully signed door from a partly signed one: it is NOT an input to either
 * probability, see the header on why household size dropped out.
 */
export function doorOdds(model: OddsModel, household: string, residents?: number): DoorOdds {
  const st = model.state.get(household)
  const street = model.streetOf.get(household) ?? null
  const roster = residents ?? model.residentsOf.get(household) ?? 0
  const visits = st?.visits ?? 0
  const everAnswered = st?.everAnswered ?? false
  const signed = st?.signed ?? 0
  const partlySigned = signed > 0 && (roster === 0 || signed < roster)
  const closed = closedReasonOf(st, roster)

  const out: DoorOdds = {
    household,
    visit: visits + 1,
    everAnswered,
    partlySigned,
    signed,
    residents: roster,
    lastOutcome: st?.lastOutcome ?? null,
    closed,
    closedNote: closed ? CLOSED_TEXT[closed] : '',
    answer: null,
    sign: null,
    signature: null,
    answerWhy: [],
    signWhy: [],
    bestTimes: [],
    street,
    vsCampaign: null,
    vsSimilar: null,
  }
  if (closed) return out

  // ---- answer
  const aCell = cellAt(model.answerBase, answerCell(visits + 1, everAnswered))
  out.answer = estimate(aCell.p, aCell.n)
  out.answerWhy = [
    {
      // "Answered before and still open" rather than "answered before", and
      // the difference is the whole honesty of this cell: the walk retires a
      // door that refused (CLOSED_OUTCOMES), so a door that answered AND is
      // still on the list is mostly one that asked us to come back. Calling it
      // "doors that answer once, answer again" would be a law; this is a
      // description of the doors the campaign chose to revisit.
      label:
        visits === 0
          ? 'Never knocked'
          : everAnswered
            ? `Visit ${visits + 1}, somebody answered here before and the door is still open`
            : `Visit ${visits + 1}, nobody has answered yet`,
      detail: `${formatPct(model.answerBase.global)} across the whole campaign, ${formatPct(aCell.p)} for doors in this situation`,
      p: aCell.p,
      shift: (aCell.p - model.answerBase.global) * 100,
      n: aCell.n,
    },
  ]

  // ---- sign, given somebody answers
  const sCell = cellAt(model.signBase, signCell(visits + 1, partlySigned))
  const chain = signChain(model, street, sCell.p)
  out.sign = estimate(chain.p, sCell.n, chain.groupN, chain.groupK)
  out.signWhy = [
    {
      // "After talking", not "campaign wide" (2026-07-27, user call): this
      // whole stage is conditional on somebody having come to the door, and
      // the label is the only thing on screen that can say so.
      label: partlySigned ? 'Somebody here has already signed' : 'Signing after talking',
      detail: `${formatPct(sCell.p)} of conversations end in a signature`,
      p: sCell.p,
      shift: (sCell.p - model.signBase.global) * 100,
      n: sCell.n,
    },
    ...chain.why,
  ]

  // ---- the two multiplied
  const both = out.answer.p * chain.p
  out.signature = {
    p: both,
    lo: out.answer.lo * out.sign.lo,
    hi: out.answer.hi * out.sign.hi,
    n: Math.min(out.answer.n, out.sign.n),
  }

  // ---- compared with what
  out.vsCampaign = {
    answer: benchmark(out.answer, model.campaignAnswer),
    sign: benchmark(out.sign, model.campaignSign),
    signature: benchmark(out.signature, model.campaignSignature),
  }
  // The second comparison, against doors in the SAME situation: this is what
  // separates "a bad street" from "a fourth visit". Only the sign half can
  // differ from its own base, since the answer half has no street term.
  out.vsSimilar = benchmark(out.sign, sCell.p)

  // ---- when to go
  out.bestTimes = BLOCK_ORDER.map((key) => {
    const b = model.blocks.get(key)
    const p = clamp01(expit(logit(aCell.p) + (b?.delta ?? 0)))
    return { key, label: blockLabel(key), hours: blockHours(key), p, n: b?.n ?? 0 }
  })
    .filter((b) => b.n > 0)
    .sort((a, b) => b.p - a.p)

  return out
}

/** Every knocked conversation on the streets that connect to this one. */
function pooledNear(model: OddsModel, street: string): Tally {
  const out = emptyTally()
  for (const other of model.neighboursOf(street)) {
    const t = model.streetSign.get(other)
    if (!t) continue
    out.n += t.n
    out.hits += t.hits
    out.expected += t.expected
  }
  return out
}

const formatPct = (p: number) => `${(p * 100).toFixed(1)}%`

// ---------------------------------------------------------------- sets

export interface SetOdds {
  doors: number
  /** Doors the walk would still send somebody to. */
  open: number
  neverKnocked: number
  closed: number
  closedBreakdown: { reason: ClosedReason; label: string; count: number }[]
  /** Average chance across the open doors. */
  answer: Estimate | null
  sign: Estimate | null
  /** Expected counts if every open door were knocked once. */
  expectedConversations: { value: number; lo: number; hi: number }
  expectedSignatures: { value: number; lo: number; hi: number }
  /** Answer chance by time of day over the open doors, best first. */
  bestTimes: { key: string; label: string; hours: string; p: number; n: number }[]
  /** The one street or the streets in the set, biggest first. */
  streets: { key: string; name: string; city: string; doors: number; open: number }[]
  /** Against every door in the campaign. */
  vsCampaign: { answer: Benchmark; sign: Benchmark } | null
  /** What the SAME number of open doors would be worth at the campaign
   *  average. The comparison a manager is really making when they ask whether
   *  a street is worth the morning. */
  typicalYield: { conversations: number; signatures: number }
  /** Set only for a scope that is exactly one street with enough evidence to
   *  be ranked: where it sits among every such street, 1 = friendliest. */
  streetRank: { place: number; of: number } | null
}

const CLOSED_LABEL: Record<ClosedReason, string> = {
  signed: 'everybody signed',
  refused: 'not interested',
  hostile: 'hostile',
  skipped: 'skipped',
}

/**
 * The odds across a set of doors: a street, a turf, one canvasser's ground.
 *
 * The headline is EXPECTED YIELD, not an average percentage, because that is
 * the number somebody plans a Saturday with: knock these 137 and expect about
 * 54 conversations and 24 signatures. Closed doors are excluded from it and
 * reported separately, since a turf that is 60% retired has a much smaller
 * afternoon in it than its door count suggests.
 *
 * The range on a total is the sum of the per-door ranges rather than anything
 * narrower. Errors here are correlated, not independent: these doors mostly
 * share a street, so if the street estimate is high they are all high
 * together, and a range built on independence would be far too tight.
 */
export function setOdds(model: OddsModel, households: string[]): SetOdds {
  const closedCounts = new Map<ClosedReason, number>()
  const streetCounts = new Map<string, { doors: number; open: number }>()
  let sumA = 0
  let sumALo = 0
  let sumAHi = 0
  let sumS = 0
  let sumSLo = 0
  let sumSHi = 0
  let open = 0
  let neverKnocked = 0
  let answerN = 0
  let signN = 0
  const blockSums = new Map<string, { p: number; n: number }>()

  for (const id of households) {
    const st = model.streetOf.get(id)
    if (st) {
      const e = streetCounts.get(st) ?? { doors: 0, open: 0 }
      e.doors++
      streetCounts.set(st, e)
    }
    const o = doorOdds(model, id)
    if (o.closed) {
      closedCounts.set(o.closed, (closedCounts.get(o.closed) ?? 0) + 1)
      continue
    }
    open++
    if (o.visit === 1) neverKnocked++
    if (st) streetCounts.get(st)!.open++
    if (o.answer && o.sign && o.signature) {
      sumA += o.answer.p
      sumALo += o.answer.lo
      sumAHi += o.answer.hi
      sumS += o.signature.p
      sumSLo += o.signature.lo
      sumSHi += o.signature.hi
      answerN += o.answer.n
      signN += o.sign.n
      for (const b of o.bestTimes) {
        const e = blockSums.get(b.key) ?? { p: 0, n: 0 }
        e.p += b.p
        e.n++
        blockSums.set(b.key, e)
      }
    }
  }

  const meanAnswer = open ? sumA / open : 0
  // Signature chance per door divided by answer chance per door recovers the
  // set's sign rate on the doors that will actually open, which is the number
  // that matches the per door reading. Averaging the per-door sign rates
  // instead would give equal weight to doors that will probably never open,
  // which is the wrong thing to average.
  const meanSign = sumA > 0 ? sumS / sumA : 0

  // n is the MEAN per-door effective sample, not a sum: these doors mostly
  // share a street, so their errors move together and the average is no more
  // certain than one door of it.
  const answerEst = open ? estimate(meanAnswer, Math.round(answerN / open)) : null
  const signEst = open ? estimate(meanSign, Math.round(signN / open)) : null

  const streetKeys = [...streetCounts.keys()]
  const rankIdx =
    streetKeys.length === 1
      ? model.streetRanking.findIndex((s) => s.key === streetKeys[0])
      : -1

  return {
    doors: households.length,
    open,
    neverKnocked,
    closed: households.length - open,
    closedBreakdown: [...closedCounts.entries()]
      .map(([reason, count]) => ({ reason, label: CLOSED_LABEL[reason], count }))
      .sort((a, b) => b.count - a.count),
    answer: answerEst,
    sign: signEst,
    expectedConversations: { value: sumA, lo: sumALo, hi: sumAHi },
    expectedSignatures: { value: sumS, lo: sumSLo, hi: sumSHi },
    vsCampaign: open
      ? {
          answer: benchmark(answerEst, model.campaignAnswer),
          sign: benchmark(signEst, model.campaignSign),
        }
      : null,
    typicalYield: {
      conversations: open * model.campaignAnswer,
      signatures: open * model.campaignSignature,
    },
    streetRank:
      rankIdx >= 0 ? { place: rankIdx + 1, of: model.streetRanking.length } : null,
    bestTimes: [...blockSums.entries()]
      .map(([key, e]) => ({
        key,
        label: blockLabel(key),
        hours: blockHours(key),
        p: e.p / e.n,
        n: model.blocks.get(key)?.n ?? 0,
      }))
      .sort((a, b) => b.p - a.p),
    streets: [...streetCounts.entries()]
      .map(([key, e]) => {
        const [name, city] = key.split('|')
        return { key, name, city, doors: e.doors, open: e.open }
      })
      .sort((a, b) => b.doors - a.doors),
  }
}

/** Every door on a street, by the key this module uses everywhere else. */
export const streetKeyOf = (street: string, city: string) => `${streetNameOf(street)}|${city}`

// ---------------------------------------------------------------- how good is it

export interface ModelScore {
  /** Days of knocks held back. */
  days: number
  /** Visits scored. */
  trials: number
  /** Out of 100 pairs of doors, how often the livelier one was picked. 50 is
   *  a coin toss. */
  pickedLivelier: number
  /** What it said against what happened, in ten-point bands. */
  bands: { said: number; happened: number; n: number }[]
  /** The worst band, in percentage points. */
  worstBand: number
}

/**
 * Measure the model against knocks it was not shown.
 *
 * This exists because of a problem no amount of care in the model can fix: the
 * history it learns from is mostly SIMULATED, so any sentence written here
 * about how well it works would be a claim about a simulator. A number
 * computed at run time is not. Replace the seeded history with real knocks and
 * this moves on its own, and nobody has to remember to edit a caveat.
 *
 * Method: refit on everything except the last `days` days, then predict those
 * days. It is the same prequential idea as the harness in
 * scripts/verify-odds-model.mjs, cut down to one split so it costs one extra
 * model build rather than twenty.
 *
 * It reports the two things a person can actually act on: whether it can tell
 * two doors apart at all (a rank statistic, which is what "picked the livelier
 * one" is), and whether the numbers mean what they say (calibration). Those
 * are different virtues, and this model is much better at the second, which is
 * exactly what a total over a turf rests on.
 *
 * Returns null when there is not enough held-back data to say anything, which
 * is a real state early in a campaign and must be shown as "not enough knocks
 * yet" rather than as a bad score.
 */
export function scoreOddsModel(
  knocks: OddsKnock[],
  doors: OddsDoor[],
  days = 7,
): ModelScore | null {
  if (!knocks.length) return null
  let latest = -Infinity
  for (const k of knocks) if (k.ts > latest) latest = k.ts
  const end = new Date(latest)
  const cutoff = new Date(
    end.getFullYear(),
    end.getMonth(),
    end.getDate() - (days - 1),
    0,
    0,
    0,
    0,
  ).getTime()

  const before = knocks.filter((k) => k.ts < cutoff)
  if (before.length < 300) return null
  const model = buildOddsModel(before, doors, { rank: false })

  const { visits } = collapse(knocks.filter((k) => k.ts >= cutoff))
  const ps: number[] = []
  const ys: number[] = []
  for (const v of visits) {
    if (!v.interacted) continue
    const o = doorOdds(model, v.household)
    // A door the model calls closed gives no number, so there is nothing to
    // score. Scoring it against the campaign average instead would be marking
    // its own homework with a different pen.
    if (!o.answer) continue
    ps.push(o.answer.p)
    ys.push(v.answered ? 1 : 0)
  }
  if (ps.length < 100) return null

  const bandMap = new Map<number, { said: number; happened: number; n: number }>()
  for (let i = 0; i < ps.length; i++) {
    const b = Math.min(9, Math.floor(ps[i] * 10))
    const e = bandMap.get(b) ?? { said: 0, happened: 0, n: 0 }
    e.said += ps[i]
    e.happened += ys[i]
    e.n++
    bandMap.set(b, e)
  }
  const bands = [...bandMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({ said: e.said / e.n, happened: e.happened / e.n, n: e.n }))
    .filter((b) => b.n >= 30)

  return {
    days,
    trials: ps.length,
    pickedLivelier: Math.round(100 * rankAuc(ps, ys)),
    bands,
    worstBand: bands.reduce((w, b) => Math.max(w, Math.abs(b.said - b.happened) * 100), 0),
  }
}

/** Mann-Whitney rank sum, tie-averaged. stats.ts has the same thing, but this
 *  module is deliberately free of anything it does not need. */
function rankAuc(scores: number[], labels: number[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s)
  let rank = 1
  let sumPos = 0
  let nPos = 0
  let i = 0
  while (i < pairs.length) {
    let j = i
    while (j < pairs.length - 1 && pairs[j + 1].s === pairs[i].s) j++
    const avg = (2 * rank + (j - i)) / 2
    for (let m = i; m <= j; m++) {
      if (pairs[m].y === 1) {
        sumPos += avg
        nPos++
      }
    }
    rank += j - i + 1
    i = j + 1
  }
  const nNeg = pairs.length - nPos
  if (!nPos || !nNeg) return 0.5
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}
