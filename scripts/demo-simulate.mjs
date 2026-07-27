// Run the Demo Campaign as a world, day by day, and write what happened.
//
//   node scripts/demo-simulate.mjs --dry-run     # model + stats, writes nothing
//   node scripts/demo-simulate.mjs               # history, then today up to now
//   node scripts/demo-simulate.mjs --today       # only advance today to now
//   node scripts/demo-simulate.mjs --wipe        # remove all generated activity
//
// Re-running is safe and is the point: --today is incremental, so it can be run
// again an hour later and only adds the knocks that would have happened since.
//
// The model, its sources, and the arithmetic check are written up in
// research/notes/simulation-model.md. The short version:
//
//   P(answer) = 0.41 × at-home × canvasser skill × time-of-day × attempt decay
//   P(sign)   = 0.40 × household support × canvasser skill
//
// 0.41 is DellaVigna, List & Malmendier (2012). 0.40 is DERIVED, not cited —
// per-conversation petition conversion is not published anywhere. Attempt decay
// takes Groves & Heeringa's SIGN and not their magnitude.
//
// ─────────────────────────────────────────────────────────────────────────────
// DICE BELONG AT THE DOOR, NOT IN THE DISPATCHER.
//
// Every DECISION is reasoned: which turf a crew takes, how many people it needs,
// how the leader splits it, who is likely to be home. Every OUTCOME is rolled.
// That split is what makes the analytics survive a drill-down — sign rate falls
// with attempt number because the model says it must, areas differ because
// support genuinely clusters, and the thin parts of the map are thin for a
// reason somebody can discover rather than because a mask was painted on.
//
// Turf choice is scored, never sampled. Each squad-day draws its OWN weighting
// over five real motives — fresh doors, walkable density, finishing a started
// turf, drifting toward ground that signs well, and sweeping up not-homes — so
// crews disagree with each other without any single choice being arbitrary.
// ─────────────────────────────────────────────────────────────────────────────

import {
  supa, sql, fetchAll, insertChunked, makeRng, hashUnit, normal, clamp, shuffle,
  localDayString, addDays, daysBetween, dayStringToDate, atHour, DOW,
  DEMO_CITY, requireDemoCampaign,
} from './demo-lib.mjs'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const todayOnly = args.includes('--today')
const wipe = args.includes('--wipe')

const CAMPAIGN_START = '2026-06-15'
const TODAY = localDayString()

// ---- calibration (research/notes/simulation-model.md) ----------------------
const BASE_ANSWER = 0.41          // DellaVigna, List & Malmendier 2012
const BASE_SIGN = 0.40            // derived; ~5 knocks per signature
const P_HOSTILE = 0.03            // of answered doors
const P_SKIP = 0.02               // vacant / dog / no-trespass, per fresh door
const COVERAGE_TARGET = 0.85      // of turfed doors, by the end
const ACTIVE_TODAY_TARGET = 30
// Turfs the campaign never opens. Held out explicitly rather than hoped for:
// tuning capacity to leave a given number untouched does not converge, because
// changing any turnout parameter changes how many rng() draws happen and
// reshuffles every downstream roll. The same dial moved coverage from 70% to
// 90% to 100% in three passes, non-monotonically. The REASON is still real —
// these are the least walkable turfs on the board, the ones a coordinator keeps
// putting off — it is just enforced instead of emergent.
const RESERVED_TURFS = 5

const log = (...a) => console.log(...a)
const rng = makeRng(0xC0FFEE11)

// The generated roster, by id. A username heuristic is not good enough: three
// legacy QA accounts (qa-rapidclicker, qa-boundarytester, qa-permbreaker) carry
// hyphens too, and they belong in the signed-up-never-went-out cohort, not on
// the canvassing roster.
const MANIFEST = join(process.cwd(), 'demo-manifest.json')
const rosterIds = new Set(
  existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')).userIds ?? [] : [],
)

// ------------------------------------------------------------------ people

/** Engagement tier. The single most load-bearing "people are not
 *  interchangeable" fact in the model — without it the crew knocks the whole
 *  town twice over and there is nothing left to show. Derived from the id hash
 *  so it is stable across runs. */
function tierOf(id) {
  const u = hashUnit(id, 'tier')
  if (u < 0.18) return { name: 'core', turnout: 0.62, shift: [2.5, 6.5] }
  if (u < 0.48) return { name: 'occasional', turnout: 0.22, shift: [2, 3.5] }
  return { name: 'rare', turnout: 0.035, shift: [1.5, 2.5] }
}

function personModel(p) {
  const tier = tierOf(p.id)
  return {
    ...p,
    tier,
    // 12-25 doors/hour: industry benchmark is 15-20 suburban.
    pace: 12 + hashUnit(p.id, 'pace') * 13,
    // ±35%. Contact rates across comparable canvasses run 22% to 75%, a spread
    // that dwarfs every treatment effect in the literature.
    skill: 0.65 + hashUnit(p.id, 'skill') * 0.7,
    joined: p.created_at.slice(0, 10),
    // Some people drift off. A campaign roster is not a fixed cast.
    quits: hashUnit(p.id, 'quit') < 0.22
      ? Math.floor(12 + hashUnit(p.id, 'quitday') * 30)
      : null,
  }
}

// ------------------------------------------------------------------ world

function householdModel(door, turfSupport) {
  const id = door.id
  // Hierarchy: turf -> street -> household. A flat per-door draw would make
  // every area identical once averaged, and the Areas tab would have nothing
  // real to find.
  const streetU = hashUnit(door.street_name, 'street')
  const support = clamp(
    0.45 * turfSupport + 0.30 * streetU + 0.25 * hashUnit(id, 'support'),
    0.05, 0.95,
  )
  // Contactability is drawn INDEPENDENTLY of support on purpose. Tying them
  // would quietly encode "people who are home agree with you", which is a real
  // bias in canvassing data and not something a simulator should manufacture.
  const atHome = clamp(0.45 + 1.1 * (hashUnit(id, 'home') - 0.5), 0.12, 0.95)
  return {
    id,
    turf_id: door.turf_id,
    street: door.street_name,
    num: door.num,
    persons: door.persons.map((x) => ({ id: x, signed: false, asked: false })),
    support, atHome,
    attempts: 0,
    closed: false,
    lastDay: null,
    returnOn: null,
  }
}

/** Answer-rate decay with repeated no-answers. Groves & Heeringa's screener
 *  model gives -0.12 logit per prior call; their magnitudes carry no standard
 *  errors and one coefficient is implausible on its face, so only the SIGN is
 *  taken and the size is tuned to keep attempt-4 visibly but not absurdly below
 *  attempt-1. */
const attemptDecay = (n) => Math.exp(-0.22 * n)

/** Evenings and weekends are when people are home. This is modelled as ground
 *  truth here, which is legitimate BECAUSE we are generating the world; the
 *  analytics side is careful to call it confounded, and it is — in real data
 *  you cannot separate who is home then from who was visited then. */
function timeOfDayFactor(hour, dow) {
  const weekend = dow === 0 || dow === 6
  if (weekend) return hour < 11 ? 0.85 : hour < 15 ? 1.05 : hour < 19 ? 1.0 : 0.8
  if (hour < 12) return 0.6
  if (hour < 16) return 0.68
  if (hour < 18) return 1.0
  if (hour < 20) return 1.15
  return 0.85
}

/** How many people go out at all on a given day. Weekends carry a volunteer
 *  campaign; Friday is the dead night everywhere. */
function dayTurnout(dow) {
  return [1.35, 0.75, 0.85, 0.9, 0.95, 0.6, 1.5][dow]
}

// ------------------------------------------------------------------ main

async function main() {
  const campaign = await requireDemoCampaign()
  log(`Demo Campaign simulation — ${CAMPAIGN_START} to ${TODAY}${dryRun ? ' (dry run)' : ''}`)

  if (wipe) return doWipe()

  // ---- load the world
  const [turfRows, addrRows, personRows, profileRows] = await Promise.all([
    fetchAll('turfs', 'id, name, color, parent_turf_id'),
    fetchAll('addresses', 'id, street, city, lat, lng, turf_id', (q) => q.eq('city', DEMO_CITY).not('turf_id', 'is', null)),
    fetchAll('persons', 'id, household_id'),
    fetchAll('profiles', 'id, display_name, username, role, created_at, is_simulated, campaign_id'),
  ])

  const roster = profileRows
    .filter((p) => p.is_simulated && p.role !== 'admin' && p.campaign_id === campaign.id)
    .filter((p) => rosterIds.has(p.id))       // the generated 65, from demo-manifest.json
    .map(personModel)
  log(`  ${turfRows.length} turfs, ${addrRows.length} doors in turf, ${roster.length} simulated canvassers`)

  const personsByHouse = new Map()
  for (const p of personRows) {
    if (!p.household_id) continue
    let a = personsByHouse.get(p.household_id)
    if (!a) personsByHouse.set(p.household_id, (a = []))
    a.push(p.id)
  }

  // ---- build households
  const turfById = new Map(turfRows.map((t) => [t.id, t]))
  const households = new Map()
  const doorsByTurf = new Map()
  for (const a of addrRows) {
    const street_name = String(a.street).replace(/^\d+\s*/, '').trim().toUpperCase()
    const num = Number((String(a.street).match(/^\d{1,9}/) ?? [0])[0])
    const turfSupport = hashUnit(a.turf_id, 'turfsupport')
    const h = householdModel(
      { id: a.id, turf_id: a.turf_id, street_name, num, persons: personsByHouse.get(a.id) ?? [] },
      turfSupport,
    )
    h.lat = a.lat; h.lng = a.lng
    households.set(a.id, h)
    let arr = doorsByTurf.get(a.turf_id)
    if (!arr) doorsByTurf.set(a.turf_id, (arr = []))
    arr.push(h)
  }
  // Walk order: street, then house number. This is how a person actually moves.
  for (const arr of doorsByTurf.values()) {
    arr.sort((x, y) => x.street.localeCompare(y.street) || x.num - y.num)
  }

  // ---- turf state, for the dispatcher to score
  const turfState = new Map()
  for (const t of turfRows) {
    if (t.parent_turf_id) continue
    const doors = doorsByTurf.get(t.id) ?? []
    if (!doors.length) continue
    turfState.set(t.id, {
      id: t.id, name: t.name, doors,
      total: doors.length,
      knocked: 0, signed: 0, answered: 0, notHome: 0,
      density: densityOf(doors),
      lastWorked: null,
      everWorked: false,
    })
  }
  // Least walkable first: these are the ones that never get opened.
  for (const t of [...turfState.values()].sort((a, b) => a.density - b.density).slice(0, RESERVED_TURFS)) {
    t.reserved = true
  }
  log(`  ${turfState.size} turfs, ${RESERVED_TURFS} held back as never opened`)

  // Coverage is steered directly. Once the target is reached crews keep working
  // — there is a whole roster out there — but they stop opening new ground and
  // spend the rest of the campaign on return visits to doors that were not home,
  // which is what a drive actually does once it has been down every street.
  const world = { touched: 0, total: addrRows.length }

  // ---- the run
  const out = { squads: [], members: [], knocks: [] }
  const days = []
  for (let d = CAMPAIGN_START; daysBetween(d, TODAY) >= 0; d = addDays(d, 1)) days.push(d)

  const startAt = todayOnly ? days.length - 1 : 0
  for (let i = startAt; i < days.length; i++) {
    simulateDay(days[i], { roster, turfState, households, out, world, isToday: days[i] === TODAY })
  }

  report(out, turfState, households, roster)
  if (dryRun) return log('\n[dry-run] nothing written')

  await writeAll(out, todayOnly)
}

function densityOf(doors) {
  const pts = doors.filter((d) => d.lat != null)
  if (pts.length < 3) return 0.3
  const lat0 = 40.24
  const xs = pts.map((p) => p.lng * 111320 * Math.cos((lat0 * Math.PI) / 180))
  const ys = pts.map((p) => p.lat * 111320)
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  const km2 = Math.max(0.05, (w * h) / 1e6)
  return clamp(pts.length / km2 / 400, 0, 1)
}

// ------------------------------------------------------------------ a day

function simulateDay(day, ctx) {
  const { roster, turfState, households, out, world, isToday } = ctx
  const dow = DOW(day)
  const dayIdx = daysBetween(CAMPAIGN_START, day)

  // Who is out. Tier turnout × day-of-week, and people who joined later or
  // already drifted off are simply not available.
  const available = roster.filter((p) => {
    if (daysBetween(p.joined, day) < 0) return false
    if (p.quits != null && daysBetween(p.joined, day) > p.quits) return false
    return true
  })
  // Turnout RAMPS across the campaign. A drive does not start at full strength:
  // the roster grows, crews get organised, and the habit sets in. Without the
  // ramp the first week is as busy as the last, which both reads wrong and
  // burns the whole town's doors before the roster has finished growing.
  const totalDays = daysBetween(CAMPAIGN_START, TODAY) || 1
  const ramp = 0.25 + 0.40 * (dayIdx / totalDays)
  const turnoutMul = dayTurnout(dow)
  let active = available.filter((p) => rng() < p.tier.turnout * turnoutMul * ramp)

  // Today is the demo, and a campaign genuinely does organise a big push. Top
  // up to the target from whoever is available rather than inflating turnout
  // for the whole six weeks.
  if (isToday) {
    const want = Math.min(ACTIVE_TODAY_TARGET, available.length)
    const rest = shuffle(available.filter((p) => !active.includes(p)), rng)
    while (active.length < want && rest.length) active.push(rest.pop())
  }
  if (active.length < 2) return

  // Fresh squads daily, whoever showed up: shuffle, then group. Leaders spread
  // across crews first so most squads have one.
  const leads = shuffle(active.filter((p) => p.role !== 'canvasser'), rng)
  const plain = shuffle(active.filter((p) => p.role === 'canvasser'), rng)
  // Smaller crews. Total capacity is unchanged, but each squad takes one turf
  // per day, so squad COUNT is the hard ceiling on how many turfs ever get
  // touched: at 4-person crews only ~56 of 72 turfs could ever be reached, no
  // matter how the scoring was tuned. Crews of 2 to 3 are the common real shape
  // anyway, and they spread the same number of knocks across more ground.
  const squadCount = Math.max(1, Math.round(active.length / 2.6))
  const squads = []
  for (let i = 0; i < squadCount; i++) {
    squads.push({ id: randomUUID(), members: [], lead: leads[i] ?? null })
    if (leads[i]) squads[i].members.push(leads[i])
  }
  for (let i = 0; i < plain.length; i++) squads[i % squadCount].members.push(plain[i])
  for (let i = squadCount; i < leads.length; i++) squads[i % squadCount].members.push(leads[i])

  const takenToday = new Set()
  for (const sq of squads) {
    if (!sq.members.length) continue

    // Capacity first: how many doors can THIS crew actually cover? Turf choice
    // follows from the crew that showed up, which is the real causality.
    const shiftHours = sq.members.map((m) => {
      const [lo, hi] = m.tier.shift
      return lo + rng() * (hi - lo)
    })
    const capacity = Math.round(
      sq.members.reduce((s, m, i) => s + m.pace * shiftHours[i], 0),
    )

    const chaseFresh = world.touched / world.total < COVERAGE_TARGET
    const turf = pickTurf(turfState, takenToday, capacity, day, chaseFresh)
    if (!turf) continue
    takenToday.add(turf.id)

    // Crews split between a morning shift and an evening one, rather than the
    // evenings-only pattern real canvassing follows. Two reasons, and the first
    // is the demo's: a recording made at 9.30am has to show a campaign that is
    // already moving, and an evenings-only model is empty until four o'clock.
    // The second is that it keeps the time-of-day analysis meaningful — if every
    // shift started at the same hour there would be nothing for the hour-by-hour
    // answer-rate chart to compare, and the evening advantage (people are home)
    // only shows up if somebody actually knocks in the morning to lose against.
    const startHour = rng() < 0.55 ? 9 + rng() * 2.5 : 16 + rng() * 2.5
    const name = squadName(sq, rng)
    out.squads.push({ id: sq.id, name, squad_date: day, created_by: (sq.lead ?? sq.members[0]).id })
    for (const m of sq.members) out.members.push({ squad_id: sq.id, user_id: m.id })

    walkTurf({ sq, turf, day, dow, startHour, shiftHours, households, out, world, isToday })
    turf.lastWorked = day
    turf.everWorked = true
  }
}

/** Score every eligible turf and take the best. Each squad-day draws its own
 *  weights, so two crews on the same morning legitimately disagree — but no
 *  single choice is arbitrary. */
function pickTurf(turfState, taken, capacity, day, chaseFresh) {
  // Normalised exponential draws: a Dirichlet in spirit. Means encode the
  // ordering the user asked for — fresh and dense lead, the rest vary.
  const w = {
    fresh: 2.1 * -Math.log(1 - rng()),
    dense: 1.4 * -Math.log(1 - rng()),
    finish: 1.0 * -Math.log(1 - rng()),
    support: 0.7 * -Math.log(1 - rng()),
    revisit: 1.1 * -Math.log(1 - rng()),
  }
  let best = null
  let bestScore = -Infinity
  for (const t of turfState.values()) {
    if (taken.has(t.id) || t.reserved) continue
    const remaining = t.total - t.knocked
    // Eligibility is "has doors still worth knocking", which is NOT the same as
    // "has doors nobody has touched". A turf walked end to end is still full of
    // not-homes that are worth another pass, and testing untouched doors alone
    // retired every worked turf and left the last crews of the campaign with
    // nowhere to go at all.
    const workable = t.doors.reduce((n, h) => n + (h.closed ? 0 : 1), 0)
    if (workable <= 3) continue
    // Once the campaign has been down every street it means to walk, it stops
    // opening new ground. Crews still go out — the roster is unchanged — but the
    // work becomes return visits, which is what a drive actually turns into.
    if (!chaseFresh && !t.everWorked) continue

    const freshness = remaining / t.total
    const partial = t.knocked > 0 && freshness > 0.12 ? 1 : 0
    const observed = t.answered > 0 ? t.signed / t.answered : 0.3
    const backlog = t.notHome / Math.max(1, t.total)
    // Worked very recently is a mild penalty: a crew does not re-walk last
    // night's ground, but a week later the not-homes are worth another pass.
    const rest = t.lastWorked ? clamp(daysBetween(t.lastWorked, day) / 9, 0, 1) : 1

    const score =
      // Opening ground nobody has touched is its own pull, and a stronger one
      // than "this turf is mostly unworked". A canvasser would rather have a
      // street nobody has been down than the leftovers of one somebody already
      // walked, and without this the campaign revisits its favourites and
      // leaves a fifth of the town never opened at all.
      (!t.everWorked && chaseFresh ? w.fresh * 3.2 : 0) +
      (chaseFresh ? w.fresh * freshness : 0) +
      w.dense * t.density +
      w.finish * partial +
      w.support * observed * 2 +
      // Return visits are held back until the town has been covered, then take
      // over. Without the damping, a turf full of not-homes outscores an unopened
      // street from the first week onward and the campaign spends six weeks
      // re-walking its earliest ground: coverage stalled at 61%.
      w.revisit * backlog * (chaseFresh ? 0.5 : 6) +
      rest * 0.5
    if (score > bestScore) { bestScore = score; best = t }
  }
  return best
}

const CREW_WORDS = ['crew', 'squad', 'team']
function squadName(sq, rand) {
  const who = (sq.lead ?? sq.members[0]).display_name ?? 'Crew'
  const first = who.split(' ')[0]
  return `${first}'s ${CREW_WORDS[Math.floor(rand() * CREW_WORDS.length)]}`
}

/** The leader splits the turf, each member walks their slice in street order. */
function walkTurf({ sq, turf, day, dow, startHour, shiftHours, households, out, world, isToday }) {
  // Doors worth knocking, in walk order. Closed doors are skipped entirely —
  // same rule as the app's CLOSED_OUTCOMES.
  const queue = turf.doors.filter((h) => !h.closed && (h.returnOn == null || daysBetween(h.returnOn, day) >= 0))
  if (!queue.length) return

  // Split by capacity, not evenly: a faster person takes a bigger slice, which
  // is exactly what a leader does on the Squad page.
  const budgets = sq.members.map((m, i) => Math.max(6, Math.round(m.pace * shiftHours[i])))
  const totalBudget = budgets.reduce((s, n) => s + n, 0)
  let cursor = 0
  const slices = budgets.map((b) => {
    const take = Math.round((b / totalBudget) * Math.min(queue.length, totalBudget))
    const slice = queue.slice(cursor, cursor + take)
    cursor += take
    return slice
  })

  sq.members.forEach((m, mi) => {
    const slice = slices[mi]
    if (!slice?.length) return
    let hour = startHour
    const perDoor = 1 / m.pace
    for (const h of slice) {
      if (hour > startHour + shiftHours[mi]) break
      // Today only runs up to the clock — that is what makes --today
      // re-runnable an hour later and additive.
      if (isToday && hour > nowHour()) break
      hour += perDoor

      const res = knockDoor(h, m, hour, dow, day)
      if (!res) continue
      for (const k of res) {
        out.knocks.push({
          client_id: randomUUID(),
          household_id: h.id,
          person_id: k.person_id,
          canvasser_id: m.id,
          outcome: k.outcome,
          occurred_at: atHour(day, Math.floor(hour), (hour % 1) * 60),
        })
        if (k.firstTouch) { turf.knocked++; world.touched++ }
        if (k.outcome === 'signed') { turf.signed++; turf.answered++ }
        else if (k.outcome === 'didnt_sign' || k.outcome === 'maybe' || k.outcome === 'hostile') turf.answered++
        else if (k.outcome === 'not_home') turf.notHome++
      }
    }
  })
}

function nowHour() {
  const d = new Date()
  return d.getHours() + d.getMinutes() / 60
}

/** One door. Returns the knock rows it produced. */
function knockDoor(h, canvasser, hour, dow, day) {
  const firstTouch = h.attempts === 0
  h.attempts++
  h.lastDay = day

  // Vacant / dog / no-trespass, decided once on the first visit.
  if (firstTouch && rng() < P_SKIP) {
    h.closed = true
    return [{ outcome: 'skip', person_id: null, firstTouch }]
  }

  const pAnswer = clamp(
    BASE_ANSWER * (h.atHome / 0.45) * canvasser.skill *
    timeOfDayFactor(hour, dow) * attemptDecay(h.attempts - 1),
    0.02, 0.95,
  )
  if (rng() > pAnswer) {
    // Four misses and a door stops being worth the walk.
    if (h.attempts >= 5) h.closed = true
    return [{ outcome: 'not_home', person_id: null, firstTouch }]
  }

  if (rng() < P_HOSTILE) {
    h.closed = true
    return [{ outcome: 'hostile', person_id: null, firstTouch }]
  }

  const rows = []
  const unsigned = h.persons.filter((p) => !p.signed && !p.asked)
  if (!unsigned.length) {
    h.closed = true
    return [{ outcome: 'didnt_sign', person_id: null, firstTouch }]
  }

  // The person who came to the door. A spouse sometimes signs in the same
  // visit, which is why this can return two rows.
  const answering = unsigned[0]
  const pSign = clamp(BASE_SIGN * (h.support / 0.5) * canvasser.skill, 0.02, 0.92)
  const roll = rng()
  if (roll < pSign) {
    answering.signed = true
    answering.asked = true
    rows.push({ outcome: 'signed', person_id: answering.id, firstTouch })
    // Second adult in the household, same doorstep.
    const other = unsigned[1]
    if (other && rng() < 0.42 * (h.support / 0.5)) {
      other.signed = true
      other.asked = true
      rows.push({ outcome: 'signed', person_id: other.id, firstTouch: false })
    }
  } else if (roll < pSign + 0.22) {
    // "Come back another time" — a real return visit, 4 to 9 days out, with a
    // better close rate on the second ask.
    h.returnOn = addDays(day, 4 + Math.floor(rng() * 6))
    h.support = clamp(h.support * 1.25, 0, 0.95)
    rows.push({ outcome: 'maybe', person_id: answering.id, firstTouch })
  } else {
    answering.asked = true
    rows.push({ outcome: 'didnt_sign', person_id: answering.id, firstTouch })
  }

  if (h.persons.every((p) => p.signed || p.asked)) h.closed = true
  return rows
}

// ------------------------------------------------------------------ output

function report(out, turfState, households, roster) {
  const total = households.size
  const touched = [...households.values()].filter((h) => h.attempts > 0).length
  const signed = out.knocks.filter((k) => k.outcome === 'signed').length
  const byOutcome = {}
  for (const k of out.knocks) byOutcome[k.outcome] = (byOutcome[k.outcome] ?? 0) + 1
  const worked = [...turfState.values()].filter((t) => t.knocked > 0).length

  log('\n── Result')
  log(`  knocks           ${out.knocks.length}`)
  log(`  doors touched    ${touched} / ${total} (${Math.round((100 * touched) / total)}%)`)
  log(`  signatures       ${signed}`)
  log(`  squads           ${out.squads.length}`)
  log(`  turfs worked     ${worked} / ${turfState.size} (${turfState.size - worked} never touched)`)
  log(`  knocks/signature ${(out.knocks.length / Math.max(1, signed)).toFixed(1)}`)
  log(`  outcomes         ${JSON.stringify(byOutcome)}`)

  const todays = out.squads.filter((s) => s.squad_date === TODAY)
  const activeToday = new Set(out.members.filter((m) => todays.some((s) => s.id === m.squad_id)).map((m) => m.user_id))
  log(`  today            ${todays.length} squads, ${activeToday.size} people out`)
}

async function writeAll(out, todayOnly) {
  log('\n── Writing')
  if (todayOnly) {
    await sql(`delete from public.knock_logs where occurred_at >= '${TODAY}T00:00:00-04:00'`)
    await sql(`delete from public.squad_members where squad_id in (select id from public.squads where squad_date = '${TODAY}')`)
    await sql(`delete from public.squads where squad_date = '${TODAY}'`)
  }
  await insertChunked('squads', out.squads, 200)
  log(`  ${out.squads.length} squads`)
  await insertChunked('squad_members', out.members, 400)
  log(`  ${out.members.length} squad memberships`)
  // Knocks last: stamp_knock_context reads squads/squad_members on insert.
  await insertChunked('knock_logs', out.knocks, 400)
  log(`  ${out.knocks.length} knocks`)

  // The cutter's working set is turfs created on the local day, so a demo run
  // on any later day needs the turf to be "today's" turf again.
  await sql(`update public.turfs set created_at = '${TODAY}T08:00:00-04:00' where parent_turf_id is null`)
  log('  turf re-stamped to today')
}

async function doWipe() {
  log('Wiping generated activity…')
  await sql(`delete from public.knock_logs`)
  await sql(`delete from public.squad_members`)
  await sql(`delete from public.squads`)
  await sql(`update public.addresses set turf_id = null where turf_id in (select id from public.turfs where parent_turf_id is not null)`)
  await sql(`delete from public.turfs where parent_turf_id is not null`)
  log('  done (top-level turf kept — re-run demo-turf.mjs to recut)')
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })
