<script setup lang="ts">
// Campaign Analytics — the campaign managers' numbers room. Loads the whole
// knock history once (paged, client-side), then every chart and probability
// table runs instantly in the browser: Netlify only ever serves static
// files, so ALL statistics (Wilson CIs, OLS) are computed client-side in
// src/lib/stats.ts.
//
// UI model (reworked 2026-07-21): NO global filter bar. The top of the page
// is tabs only; each tab carries its own scope — day chips on every tab, and
// tap-to-drill everywhere else (bars, dots, and table rows open the thing
// they name; drill views cross-link between tabs). Teaching copy lives in the
// per-tab help sheets
// (ANALYTICS_TAB_HELP → AppShell's "?"), never in chart subtitles — those
// stay at 2–3 word hints. (A logistic-regression "Predictor" tab existed
// until 2026-07-14 — removed as more than managers needed; stats.ts keeps
// the machinery if it ever comes back.)
import { computed, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import { onPageEnter } from '@/lib/pageState'
import ChartCard from '@/components/charts/ChartCard.vue'
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue'
import type { TimeSeries } from '@/components/charts/TimeSeriesChart.vue'
import StackedBarChart from '@/components/charts/StackedBarChart.vue'
import BarChart from '@/components/charts/BarChart.vue'
import ScatterChart from '@/components/charts/ScatterChart.vue'
import Heatmap from '@/components/charts/Heatmap.vue'
import type { BarItem } from '@/components/charts/BarChart.vue'
import type { ScatterPoint } from '@/components/charts/ScatterChart.vue'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { OUTCOMES } from '@/lib/outcomes'
import {
  appointmentSettings,
  ensureAppointmentSettings,
  windowLabel,
} from '@/lib/appointments'
import { useChartPalette, fmtPct, fmtCount } from '@/lib/chartTheme'
import { wilson, linearRegression } from '@/lib/stats'
import {
  buildOddsModel,
  doorOdds,
  percentileOf,
  scoreOddsModel,
  setOdds,
} from '@/lib/odds'
import { titleCase } from '@/lib/streetWalk'
import { ANALYTICS_TAB_HELP } from '@/lib/helpContent'
import type { KnockOutcome } from '@/types'

const palette = useChartPalette()
const cat = computed(() => palette.categorical.value)
const route = useRoute()

// ---------------------------------------------------------------- loading

interface KnockRow {
  outcome: KnockOutcome
  occurred_at: string
  household_id: string | null
  canvasser_id: string
  // Stamped at knock time by the DB (see 20260714120000): the squad the
  // canvasser was crewing with that day and the (top-level) turf the door
  // sat in. Snapshotted names, so history survives squads/turf being re-cut.
  squad_id: string | null
  squad_name: string | null
  turf_name: string | null
}

interface Knock {
  outcome: KnockOutcome
  ts: number
  day: string // local YYYY-MM-DD
  household: string
  canvasser: string
  squad: string
  /** The crew id stamped at knock time. Analytics groups by the NAME (squads
   *  dissolve nightly, so a snapshot is the only honest key across days); the
   *  id is what the Odds tab joins back to the turfs table to work out whose
   *  doors are whose. */
  squadId: string | null
  turf: string
  /** Tried the door: every outcome except Skip. See the two sets below. */
  interacted: boolean
  /** Somebody answered. See CONVERSATION below. */
  conversed: boolean
  signed: boolean
}

const NO_SQUAD = 'No squad'
const NO_TURF = 'No turf'

const loading = ref(true)
const loadNote = ref('Counting knocks…')
const loadError = ref('')
const knocks = shallowRef<Knock[]>([])
/** Every address on file. Range-independent by nature — the denominator for
 * "doors never knocked". */
const addressTotal = ref(0)

/** The address rows themselves, kept for the Odds tab: it looks a house up by
 * name, groups doors by street, and hands the lot to the predictor. */
interface DoorRow {
  id: string
  turf_id: string | null
  street: string
  city: string
  lat: number | null
  lng: number | null
  persons?: { count: number }[]
}
const doorRows = shallowRef<DoorRow[]>([])
/** Turf rows, for the Odds tab's turf and canvasser scopes. */
interface TurfRow {
  id: string
  name: string
  parent_turf_id: string | null
  assignee_id: string | null
  squad_id: string | null
  created_at: string
}
const turfRows = shallowRef<TurfRow[]>([])
/** Doors currently sitting in each turf (by turf name) — the denominator for
 * turf coverage. Current cut only; historical knocks keep their stamped name
 * even if that turf no longer exists (they just get no coverage bar). */
const turfAddressTotals = shallowRef<Map<string, number>>(new Map())
const canvasserNames = shallowRef<Map<string, string>>(new Map())

/** Come-back appointments (2026-07-26). Small table — loaded whole, and only
 * ever read here; whether one was KEPT is derived against the knock history
 * already in memory, exactly as the Appointments page derives it. */
interface Appt {
  household_id: string
  canvasser_id: string
  start: number
  end: number
  canceled: boolean
}
const appointments = shallowRef<Appt[]>([])

const PAGE = 1000

async function fetchAllPages<T>(
  table: string,
  cols: string,
  total: number,
  note: (done: number) => void,
): Promise<T[]> {
  const ranges: [number, number][] = []
  for (let from = 0; from < total; from += PAGE) ranges.push([from, from + PAGE - 1])
  const out: T[][] = new Array(ranges.length)
  let done = 0
  const BATCH = 6
  for (let i = 0; i < ranges.length; i += BATCH) {
    await Promise.all(
      ranges.slice(i, i + BATCH).map(async ([from, to], j) => {
        const { data, error } = await supabase.from(table).select(cols).order('id').range(from, to)
        if (error) throw new Error(error.message)
        out[i + j] = (data ?? []) as T[]
        done += out[i + j].length
        note(done)
      }),
    )
  }
  return out.flat()
}

// Throttled, because this is the most expensive read in the app — the whole
// knock log and every address id, some thirty paged requests — and the page is
// kept alive now (App.vue), so bouncing to /squad and back would otherwise pay
// for it again. Three minutes is still strictly cheaper than before pages were
// cached, when every single visit paid it.
//
// Nothing here touches the tab, the day chips, the custom range, the drill-down
// focus or the folded cards: the reload swaps the DATA underneath a page that
// otherwise stays exactly as it was. `loading` is deliberately not raised
// either, so a refresh shows the old numbers until the new ones land rather
// than blanking a report somebody is reading.
onPageEnter(async () => {
  try {
    const [{ count: knockCount }, { count: addrCount }] = await Promise.all([
      supabase.from('knock_logs').select('id', { count: 'exact', head: true }),
      supabase.from('addresses').select('id', { count: 'exact', head: true }),
    ])

    // The note used to name only the knocks, which was inaccurate and in the
    // wrong order of importance (2026-07-27, user call): the DOORS are the
    // bigger read by half again, and a door nobody has knocked has to be in
    // here or half of this page cannot ask about it. Both are reported, doors
    // first, and the two run concurrently so either can update the line.
    let knocksDone = 0
    let doorsDone = 0
    const note = () => {
      loadNote.value =
        `Loading ${fmtCount(doorsDone)} of ${fmtCount(addrCount ?? 0)} doors ` +
        `and ${fmtCount(knocksDone)} of ${fmtCount(knockCount ?? 0)} knocks…`
    }
    note()

    const [rows, addrs, profs, turfs, appts] = await Promise.all([
      fetchAllPages<KnockRow>(
        'knock_logs',
        'outcome, occurred_at, household_id, canvasser_id, squad_id, squad_name, turf_name',
        knockCount ?? 0,
        (n) => {
          knocksDone = n
          note()
        },
      ),
      // street/city/lat/lng/persons came back on 2026-07-27 for the Odds tab's
      // predictor: it needs to know which street a door is on, which streets
      // touch it, and how many people live there (only to tell a fully signed
      // door from a partly signed one). The read already pages all 22.7k rows,
      // so the marginal cost is the wider row rather than another round trip.
      fetchAllPages<DoorRow>(
        'addresses',
        'id, turf_id, street, city, lat, lng, persons(count)',
        addrCount ?? 0,
        (n) => {
          doorsDone = n
          note()
        },
      ),
      supabase
        .from('profiles')
        .select('id, username, display_name')
        .then(({ data, error }) => {
          if (error) throw new Error(error.message)
          return data ?? []
        }),
      supabase
        .from('turfs')
        .select('id, name, parent_turf_id, assignee_id, squad_id, created_at')
        .then(({ data, error }) => {
          if (error) throw new Error(error.message)
          return data ?? []
        }),
      fetchAllRows<{
        household_id: string
        canvasser_id: string
        starts_at: string
        ends_at: string
        status: string
      }>((from, to) =>
        supabase
          .from('appointments')
          .select('household_id, canvasser_id, starts_at, ends_at, status')
          .order('id')
          .range(from, to),
      ),
    ])

    // Whether the Appointments tab exists at all — a campaign that isn't
    // using them shouldn't be shown an empty one.
    void ensureAppointmentSettings()
    appointments.value = appts.map((a) => ({
      household_id: a.household_id,
      canvasser_id: a.canvasser_id,
      start: new Date(a.starts_at).getTime(),
      end: new Date(a.ends_at).getTime(),
      canceled: a.status === 'canceled',
    }))

    addressTotal.value = addrs.length
    doorRows.value = addrs
    turfRows.value = turfs
    // Doors per turf, resolved to the TOP-LEVEL turf name — same resolution
    // the knock stamps use, so numerator and denominator agree.
    const turfById = new Map(turfs.map((t) => [t.id, t]))
    const topTurfName = (id: string | null): string | null => {
      const t = id ? turfById.get(id) : undefined
      if (!t) return null
      const parent = t.parent_turf_id ? turfById.get(t.parent_turf_id) : undefined
      return (parent ?? t).name
    }
    const turfTotals = new Map<string, number>()
    for (const a of addrs) {
      const name = topTurfName(a.turf_id)
      if (name) turfTotals.set(name, (turfTotals.get(name) ?? 0) + 1)
    }
    turfAddressTotals.value = turfTotals
    canvasserNames.value = new Map(profs.map((p) => [p.id, p.display_name || p.username]))

    loadNote.value = 'Crunching…'
    knocks.value = enrich(rows)
    applyOddsDeepLink()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}, 180_000)

/** TWO tiers now, one word each (2026-07-27, user call: "we wanna call a not
 * home also an interaction. But then that means we also need to have another
 * classification… called a conversation, which is either not interested,
 * signed, or making an appointment to come back or hostile but not Skip").
 *
 * INTERACTION: the canvasser tried the door. Every outcome except Skip — a
 * skip is a door-level pass (loose dog, no trespassing) where nobody was
 * attempted, and if it counted, "interaction" would just mean "knock".
 *
 * CONVERSATION: somebody answered. Signed, Not Interested, Return, Hostile —
 * exactly the single set this page called INTERACTION from 2026-07-26 until
 * this split, and that day's reasoning still stands one tier down: a door
 * slammed in your face is a conversation that didn't sign, not one that
 * never happened.
 *
 * Answer rate = conversations ÷ interactions. Sign rate = signed ÷
 * conversations (or ÷ doors knocked; the chip pair below switches it). */
const CONVERSATION = new Set<KnockOutcome>(['signed', 'didnt_sign', 'maybe', 'hostile'])

/** Chart-local outcome order: the four conversation outcomes first, so the
 * stacked "What happened at doors" reads as a conversations band at the
 * bottom with Not Home and Skip piled on top — conversations per day straight
 * off the chart. outcomes.ts keeps its own order; it lays out the Talk grid.
 * (sort is stable, so each half keeps outcomes.ts's relative order.) */
const CHART_OUTCOMES = [...OUTCOMES].sort(
  (a, b) => Number(CONVERSATION.has(b.value)) - Number(CONVERSATION.has(a.value)),
)

function enrich(rows: KnockRow[]): Knock[] {
  const parsed = rows
    .filter((r) => r.household_id)
    .map((r) => {
      const d = new Date(r.occurred_at)
      return {
        outcome: r.outcome,
        ts: d.getTime(),
        day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        household: r.household_id!,
        canvasser: r.canvasser_id,
        squad: r.squad_name ?? NO_SQUAD,
        squadId: r.squad_id,
        turf: r.turf_name ?? NO_TURF,
        interacted: r.outcome !== 'skip',
        conversed: CONVERSATION.has(r.outcome),
        signed: r.outcome === 'signed',
      }
    })
    .sort((a, b) => a.ts - b.ts)

  /* This used to end with a per-household loop filling `attempt`,
   * `priorNotHomes`, `experience`, `hour` and `weekday`, and CLAUDE.md warned
   * at length that deleting the by-visit charts would orphan the predictor's
   * own inputs. It has not: they all moved INTO src/lib/odds.ts, which
   * recomputes them from raw knocks, because it had to anyway.
   *
   * It also had to compute them differently, and that is the part worth
   * knowing. The rule that two knocks at one door within ten minutes are ONE
   * visit lives there now (SAME_VISIT_MS), and it is applied to the OUTCOME as
   * well as to the count: this loop numbered the visits but still scored every
   * knock separately, which counted a couple both signing as two successful
   * trials. Per knock that reads as a 71.1% answer rate on a second visit to a
   * door somebody has answered before; per visit it is 43.3%.
   *
   * So the rule survives, in one place, with a reader, and the numbers it
   * produces are no longer quietly wrong. Nothing here needs restoring. */
  return parsed
}

// ---------------------------------------------------------------- time scope
// The one scope shared by every tab — rendered as chips INSIDE each tab's
// content (there is no global filter bar anymore).

// Every window is anchored to the CALENDAR, counting back from today, and
// every preset includes today: "3 days" is today and the two days before it.
// It used to be anchored to the latest knock in the data instead, which read
// the same while a campaign was active and quietly drifted once it went quiet
// — and "Today" cannot be expressed that way at all without lying about which
// day it means. One rule now covers the presets and the custom range both.
type RangeKey = '1' | '3' | '7' | '14' | '30' | 'all' | 'custom'

const RANGE_CHIPS: { value: RangeKey; label: string }[] = [
  { value: '1', label: 'Today' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
]

const rangeKey = ref<RangeKey>('30')
const customFrom = ref('') // YYYY-MM-DD, inclusive; blank = no limit that end
const customTo = ref('')

/** Local midnight `daysAgo` days back, in ms. Built from y/m/d components and
 * never by subtracting 86.4M ms: across a DST boundary that arithmetic lands
 * at 23:00 or 01:00 of the intended day rather than on midnight. */
function dayStartMs(daysAgo: number): number {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 0, 0, 0, 0).getTime()
}

/** Local midnight of a YYYY-MM-DD string (+ whole days), in ms. Split into
 * components for day.ts's reason: `new Date('2026-07-12')` parses as UTC
 * midnight, which is the day before in every US timezone. */
function dayStrMs(s: string, plusDays = 0): number | null {
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d + plusDays, 0, 0, 0, 0).getTime()
}

const isoDayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The window as [start, end) in ms. Presets deliberately have NO upper edge:
 * that keeps them behaving exactly as they always have (appointments run into
 * the future, and a preset is "since", not "between"). Only a custom range,
 * which is a pair of dates by definition, closes the far end. */
const rangeWindow = computed<{ start: number; end: number }>(() => {
  const k = rangeKey.value
  if (k === 'all') return { start: -Infinity, end: Infinity }
  if (k === 'custom') {
    const a = dayStrMs(customFrom.value)
    const b = dayStrMs(customTo.value, 1)
    // Ends the wrong way round has exactly one sensible reading, so read it.
    if (a != null && b != null && a >= b) {
      return { start: dayStrMs(customTo.value)!, end: dayStrMs(customFrom.value, 1)! }
    }
    return { start: a ?? -Infinity, end: b ?? Infinity }
  }
  return { start: dayStartMs(Number(k) - 1), end: Infinity }
})

const filtered = computed(() => {
  const { start, end } = rangeWindow.value
  return knocks.value.filter((k) => k.ts >= start && k.ts < end)
})

/** Tapping Custom seeds the dates from whatever window is already showing, so
 * the switch is continuous instead of landing on a blank pair (which would
 * read as an empty campaign). */
function pickRange(v: RangeKey) {
  if (v === 'custom' && !customFrom.value && !customTo.value) {
    const { start } = rangeWindow.value
    customFrom.value = Number.isFinite(start)
      ? isoDayOf(start)
      : (knocks.value[0]?.day ?? isoDayOf(dayStartMs(30)))
    customTo.value = isoDayOf(dayStartMs(0))
  }
  rangeKey.value = v
}

// ---------------------------------------------------------------- tabs

// "Turf" is singular everywhere it's user-facing (2026-07-26, user call:
// "wherever we're selecting it, they're both plural in reality"). The tab id
// stays `turfs` — it keys ANALYTICS_TAB_HELP and the focus switch.
// An "Areas" tab (sign rate / answer rate / coverage by town, taken from
// addresses.city) sat second until 2026-07-27. Removed: the demo canvasses
// Marysville and nothing else, so every chart on it was one bar. The user
// wants CUSTOM areas here in the future — a manager drawing their own regions
// rather than the address's own town — so rebuild it around that, not around
// the city column. Everything it needed is still in memory: the whole knock
// set, and the shared drill panel takes any predicate over it.
const ALL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'turfs', label: 'Turf' },
  { id: 'squads', label: 'Squads' },
  { id: 'appointments', label: 'Appointments' },
  { id: 'odds', label: 'Odds' },
  { id: 'canvassers', label: 'Canvassers' },
] as const
type TabId = (typeof ALL_TABS)[number]['id']

/** Appointments earns a tab only once the campaign turns them on — a seventh
 * tab is a real cost on a phone, and an empty one teaches nothing. */
const TABS = computed(() =>
  ALL_TABS.filter((t) => t.id !== 'appointments' || appointmentSettings.value.enabled),
)
const tab = ref<TabId>('overview')

/** The header "?" teaches whichever tab is on screen. */
const helpTopic = computed(() => ANALYTICS_TAB_HELP[tab.value])

// ---------------------------------------------------------------- drill focus
// Turf/Squads/Canvassers each hold a focused entity; the focus panel (one
// shared template block) replaces the tab's compare view. Focus sticks per
// tab, so flipping away and back keeps your place — the back chip clears.

const turfFocus = ref('')
const squadFocus = ref('')
const canvasserFocus = ref('') // profile id

interface Focus {
  kind: 'turf' | 'squad' | 'canvasser'
  label: string
  all: string
}

const focus = computed<Focus | null>(() => {
  switch (tab.value) {
    case 'turfs':
      return turfFocus.value ? { kind: 'turf', label: turfFocus.value, all: 'All turf' } : null
    case 'squads':
      return squadFocus.value ? { kind: 'squad', label: squadFocus.value, all: 'All squads' } : null
    case 'canvassers':
      return canvasserFocus.value
        ? {
            kind: 'canvasser',
            label: canvasserNames.value.get(canvasserFocus.value) ?? 'Unknown',
            all: 'Everyone',
          }
        : null
    default:
      return null
  }
})

function clearFocus() {
  if (tab.value === 'turfs') turfFocus.value = ''
  else if (tab.value === 'squads') squadFocus.value = ''
  else if (tab.value === 'canvassers') canvasserFocus.value = ''
}

/** Which knocks belong to the focused entity, as a predicate rather than a
 * list: the trend needs the same entity scope over TWO different time spans,
 * the visible window and the days behind it. */
const focusPick = computed<((k: Knock) => boolean) | null>(() => {
  const f = focus.value
  if (!f) return null
  switch (f.kind) {
    case 'turf':
      return (k) => k.turf === f.label
    case 'squad':
      return (k) => k.squad === f.label
    case 'canvasser':
      return (k) => k.canvasser === canvasserFocus.value
  }
})

const focusKnocks = computed<Knock[]>(() => {
  const pick = focusPick.value
  return pick ? filtered.value.filter(pick) : []
})

// Cross-tab jumps: rankings inside a focus panel open THEIR entity's tab.
function openTurf(item: BarItem) {
  turfFocus.value = item.label
  tab.value = 'turfs'
}
function openSquad(item: BarItem) {
  squadFocus.value = item.label
  tab.value = 'squads'
}
function openPerson(item: BarItem | ScatterPoint) {
  if (!item.id) return
  canvasserFocus.value = item.id
  tab.value = 'canvassers'
}
function openTurfRow(i: number) {
  turfFocus.value = turfStats.value[i].label
}
function openSquadRow(i: number) {
  squadFocus.value = squadStats.value[i].label
}
function openCanvasserRow(i: number) {
  canvasserFocus.value = canvasserStats.value[i].id
}

const scopeCount = computed(() =>
  // Odds reads everything, so the count beside it has to be everything too, or
  // the row says "every knock on record" next to a filtered number.
  tab.value === 'odds'
    ? knocks.value.length
    : focus.value
      ? focusKnocks.value.length
      : filtered.value.length,
)
const showTapHint = computed(
  () =>
    !focus.value &&
    tab.value !== 'overview' &&
    tab.value !== 'odds' &&
    tab.value !== 'appointments',
)

// ---------------------------------------------------------------- shared builders

/** Continuous local-day axis spanning a knock subset. */
function dayAxisFor(sub: Knock[]): string[] {
  if (!sub.length) return []
  const first = new Date(sub[0].ts)
  first.setHours(0, 0, 0, 0)
  const last = new Date(sub[sub.length - 1].ts)
  const days: string[] = []
  for (let t = first.getTime(); t <= last.getTime(); t += 86_400_000) {
    const d = new Date(t)
    days.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  }
  return days
}
const dayLabel = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

function dailyFor(sub: Knock[]) {
  const axis = dayAxisFor(sub)
  const idx = new Map(axis.map((d, i) => [d, i]))
  const knocksPerDay = new Array(axis.length).fill(0)
  const sigsPerDay = new Array(axis.length).fill(0)
  for (const k of sub) {
    const i = idx.get(k.day)
    if (i == null) continue
    knocksPerDay[i]++
    if (k.signed) sigsPerDay[i]++
  }
  return { axis, knocksPerDay, sigsPerDay }
}

/** Per-day totals keyed by local day, over a knock list that is deliberately
 * NOT time-filtered. `firstDay` is where the data itself begins. */
function dayTotals(sub: Knock[]) {
  const knocksByDay = new Map<string, number>()
  const sigsByDay = new Map<string, number>()
  for (const k of sub) {
    knocksByDay.set(k.day, (knocksByDay.get(k.day) ?? 0) + 1)
    if (k.signed) sigsByDay.set(k.day, (sigsByDay.get(k.day) ?? 0) + 1)
  }
  // `knocks` is sorted ascending by timestamp and every filter here preserves
  // that order, so the first row is the earliest day.
  return { knocksByDay, sigsByDay, firstDay: sub.length ? sub[0].day : null }
}

/** Trailing `win`-day mean for each day on `axis`, read out of `byDay`, which
 * covers every day LOADED rather than every day shown.
 *
 * Reaching back past the start of the window is the whole point (2026-07-27,
 * user call). The average used to be taken over the visible series alone, so
 * a window shorter than the window of the average had nothing to draw: the
 * "7 days" chip produced exactly one point, which renders as no line at all,
 * and "3 days" produced none. The line the page is read for disappeared on
 * precisely the ranges somebody checking on today's push would pick, and the
 * six days behind it were in memory the whole time.
 *
 * A day's seven-day average is a fact about that day, not about which chip is
 * selected. So it stays null only where the DATA runs out, never where the
 * window does: the first six days of a campaign have no seven-day average and
 * never will. Days inside the span with no knocks count as zero, exactly as
 * they did before, since the axis has always been contiguous.
 *
 * Day steps go through dayStrMs, never by subtracting 86.4M ms: across a DST
 * boundary that arithmetic lands at 23:00 or 01:00 of the intended day and
 * would silently double-count one day and skip another.
 */
function trailingMean(
  axis: string[],
  byDay: Map<string, number>,
  firstDay: string | null,
  win = 7,
): (number | null)[] {
  if (firstDay == null) return axis.map(() => null)
  return axis.map((day) => {
    let sum = 0
    for (let back = 0; back < win; back++) {
      const ms = back === 0 ? dayStrMs(day) : dayStrMs(day, -back)
      if (ms == null) return null
      const d = isoDayOf(ms)
      if (d < firstDay) return null // ISO days sort lexicographically
      sum += byDay.get(d) ?? 0
    }
    return sum / win
  })
}

// Charts use OUTCOMES[].short, not .label — a bar's name lives in a 130px
// gutter, and a label is written for a full-width button (that was "Come back
// another time" when this split was made; "Return" since).
function mixFor(sub: Knock[]): BarItem[] {
  const counts = new Map<KnockOutcome, number>()
  for (const k of sub) counts.set(k.outcome, (counts.get(k.outcome) ?? 0) + 1)
  return CHART_OUTCOMES.map((o) => {
    const n = counts.get(o.value) ?? 0
    return {
      label: o.short,
      value: n,
      color: o.hex,
      detail: `${fmtPct(n / Math.max(1, sub.length), 1)} of the ${fmtCount(sub.length)} knocks logged`,
    }
  })
}

const fmtAvg = (v: number | null): string => (v == null ? 'none yet' : v.toFixed(1))

/** How sure the number is, said the way a person would say it. The stats are
 * unchanged (Wilson, 95%); "95% CI 31%–38%" simply isn't readable by the
 * people this page is for, and it carried an en dash besides. */
const likely = (lo: number, hi: number) => `Likely between ${fmtPct(lo)} and ${fmtPct(hi)}`

interface Tile {
  label: string
  value: string
  hint?: string
}

// ------------------------------------------------------------- rate bases
// "We can have sign rate by doors: answered, knocked, not knocked, not
// answered" (2026-07-26, user call). A sign rate needs a stated denominator or
// it means nothing, and the two a manager actually asks for are different
// questions: how well we do once somebody opens the door, versus how much a
// street of knocking is worth. One chip pair switches every sign-rate chart on
// the page, so the two readings can never be confused for each other.
type RateBase = 'conversation' | 'door'
const rateBase = ref<RateBase>('conversation')
const RATE_BASES: { value: RateBase; label: string }[] = [
  { value: 'conversation', label: 'Per conversation' },
  { value: 'door', label: 'Per door knocked' },
]
const baseWord = computed(() => (rateBase.value === 'door' ? 'doors knocked' : 'conversations'))
const signRateSubtitle = computed(() =>
  rateBase.value === 'door'
    ? 'share of doors knocked where somebody signed'
    : 'share of conversations that ended in a signature',
)

function rateItem(label: string, hits: number, of: number, unit: string, id?: string): BarItem {
  const w = wilson(hits, of)
  return {
    id,
    label,
    value: w.p,
    lo: w.lo,
    hi: w.hi,
    detail: `${fmtCount(hits)} of ${fmtCount(of)} ${unit}`,
    note: likely(w.lo, w.hi),
  }
}

// ---------------------------------------------------------------- overview

/** "How much of the county is left" — range-independent on purpose: a door
 * nobody has ever knocked is not a fact about the last 30 days. */
const everKnockedDoors = computed(() => new Set(knocks.value.map((k) => k.household)).size)

const kpis = computed<Tile[]>(() => {
  const f = filtered.value
  const doors = new Set(f.map((k) => k.household)).size
  const sigs = f.filter((k) => k.signed).length
  const conversations = f.filter((k) => k.conversed).length
  const interactions = f.filter((k) => k.interacted).length
  const people = new Set(f.map((k) => k.canvasser)).size
  const days = new Set(f.map((k) => k.day)).size
  const left = Math.max(0, addressTotal.value - everKnockedDoors.value)
  return [
    { label: 'Signatures', value: fmtCount(sigs) },
    {
      label: 'Signatures a day',
      value: days ? (sigs / days).toFixed(1) : 'none yet',
      hint: `over ${fmtCount(days)} days out`,
    },
    { label: 'Doors knocked', value: fmtCount(doors), hint: 'counted once each' },
    { label: 'Knocks', value: fmtCount(f.length), hint: 'every visit, repeats included' },
    {
      label: 'Conversations',
      value: fmtCount(conversations),
      hint: 'somebody came to the door',
    },
    {
      label: 'Answer rate',
      value: interactions ? fmtPct(conversations / interactions, 1) : 'none yet',
      hint: 'of interactions, somebody answered',
    },
    {
      label: 'Sign rate',
      value: conversations ? fmtPct(sigs / conversations, 1) : 'none yet',
      hint: 'of conversations, they signed',
    },
    { label: 'Canvassers out', value: fmtCount(people) },
    {
      label: 'Doors never knocked',
      value: fmtCount(left),
      hint: `of ${fmtCount(addressTotal.value)} on file`,
    },
  ]
})

const overviewDaily = computed(() => dailyFor(filtered.value))
// Totals over the WHOLE loaded set, not the window: see trailingMean.
const allDayTotals = computed(() => dayTotals(knocks.value))
const sigAvg = computed(() =>
  trailingMean(overviewDaily.value.axis, allDayTotals.value.sigsByDay, allDayTotals.value.firstDay),
)
const knockAvg = computed(() =>
  trailingMean(overviewDaily.value.axis, allDayTotals.value.knocksByDay, allDayTotals.value.firstDay),
)

// Signatures and knocks each get their OWN chart and scale — on a shared
// axis the knock line (10× bigger) squashed the signature series and its
// 7-day average into an unreadable sliver at the bottom.
const sigSeries = computed<TimeSeries[]>(() => [
  { name: 'Signatures', color: cat.value[0], values: overviewDaily.value.sigsPerDay, area: true },
  { name: '7-day average', color: cat.value[1], values: sigAvg.value, width: 3.5, dash: true },
])
const knockSeries = computed<TimeSeries[]>(() => [
  { name: 'Knocks', color: cat.value[0], values: overviewDaily.value.knocksPerDay, area: true },
  { name: '7-day average', color: cat.value[1], values: knockAvg.value, width: 3.5, dash: true },
])
const sigRows = computed(() =>
  overviewDaily.value.axis.map((d, i) => [d, overviewDaily.value.sigsPerDay[i], fmtAvg(sigAvg.value[i])]),
)
const knockRows = computed(() =>
  overviewDaily.value.axis.map((d, i) => [d, overviewDaily.value.knocksPerDay[i], fmtAvg(knockAvg.value[i])]),
)

const outcomeStack = computed(() => {
  const axis = overviewDaily.value.axis
  const idx = new Map(axis.map((d, i) => [d, i]))
  return CHART_OUTCOMES.map((o) => {
    const vals = new Array(axis.length).fill(0)
    for (const k of filtered.value) {
      if (k.outcome !== o.value) continue
      const i = idx.get(k.day)
      if (i != null) vals[i]++
    }
    return { name: o.short, color: o.hex, values: vals }
  })
})

const outcomeMix = computed(() => mixFor(filtered.value))

// ---------------------------------------------------------------- rates

function rateBy(
  key: (k: Knock) => string,
  num: (k: Knock) => boolean,
  den: (k: Knock) => boolean,
  unit: string,
  minDen = 25,
): BarItem[] {
  const per = new Map<string, { n: number; s: number }>()
  for (const k of filtered.value) {
    if (!den(k)) continue
    const e = per.get(key(k)) ?? { n: 0, s: 0 }
    e.n++
    if (num(k)) e.s++
    per.set(key(k), e)
  }
  return [...per.entries()]
    .filter(([, e]) => e.n >= minDen)
    .map(([label, e]) => rateItem(label, e.s, e.n, unit))
    .sort((a, b) => b.value - a.value)
}

/** The same rate counted over DOORS instead of knocks: a door counts once,
 * and it counts as signed if anybody there ever signed. */
function signRateByDoor(key: (k: Knock) => string, include: (k: Knock) => boolean, minDen: number): BarItem[] {
  const per = new Map<string, { knocked: Set<string>; signed: Set<string> }>()
  for (const k of filtered.value) {
    if (!include(k)) continue
    let e = per.get(key(k))
    if (!e) {
      e = { knocked: new Set(), signed: new Set() }
      per.set(key(k), e)
    }
    e.knocked.add(k.household)
    if (k.signed) e.signed.add(k.household)
  }
  return [...per.entries()]
    .filter(([, e]) => e.knocked.size >= minDen)
    .map(([label, e]) => rateItem(label, e.signed.size, e.knocked.size, 'doors knocked'))
    .sort((a, b) => b.value - a.value)
}

/** One entry point for every sign-rate chart, so the chip pair switches all
 * of them together and no two charts on screen can be on different bases. */
function signRateBy(key: (k: Knock) => string, include: (k: Knock) => boolean = () => true, minDen = 25) {
  return rateBase.value === 'door'
    ? signRateByDoor(key, include, minDen)
    : rateBy(key, (k) => k.signed, (k) => include(k) && k.conversed, 'conversations', minDen)
}


const rateRows = (items: BarItem[]) => items.map((i) => [i.label, fmtPct(i.value, 1), i.detail ?? ''])

/** Campaign-wide rates: the dashed "average" marker on every rate chart. The
 * sign one follows whichever base the chips are on, or the marker would be
 * measuring something the bars beside it are not. */
const overallRates = computed(() => {
  const f = filtered.value
  const sigs = f.filter((k) => k.signed).length
  const conversations = f.filter((k) => k.conversed).length
  const interactions = f.filter((k) => k.interacted).length
  const doors = new Set(f.map((k) => k.household)).size
  const signedDoors = new Set(f.filter((k) => k.signed).map((k) => k.household)).size
  return {
    sign:
      rateBase.value === 'door'
        ? doors
          ? signedDoors / doors
          : 0
        : conversations
          ? sigs / conversations
          : 0,
    answer: interactions ? conversations / interactions : 0,
  }
})

/** Percent-axis bound with headroom, keeping whiskers AND the avg marker on. */
const pctMax = (items: BarItem[], refVal = 0) =>
  Math.min(1, Math.max(...items.map((i) => i.hi ?? i.value), refVal, 0.1) * 1.15)

// ---------------------------------------------------------------- turfs & squads
// Both group off the names STAMPED on each knock at insert time (see the
// KnockRow comment) — squads dissolve nightly and turf gets re-cut, so the
// stamps are the only honest grouping across days. Recurring crews keep the
// same name day to day ("Omar's crew"), which is exactly what makes a squad
// trackable across its whole run.

interface GroupStats {
  label: string
  knocks: number
  doors: Set<string>
  interactions: number
  conversations: number
  sigs: number
  days: Set<string>
  signRate: number
}

function statsBy(key: (k: Knock) => string): GroupStats[] {
  const per = new Map<string, Omit<GroupStats, 'label' | 'signRate'>>()
  for (const k of filtered.value) {
    let e = per.get(key(k))
    if (!e) {
      e = { knocks: 0, doors: new Set(), interactions: 0, conversations: 0, sigs: 0, days: new Set() }
      per.set(key(k), e)
    }
    e.knocks++
    e.doors.add(k.household)
    e.days.add(k.day)
    if (k.interacted) e.interactions++
    if (k.conversed) e.conversations++
    if (k.signed) e.sigs++
  }
  return [...per.entries()]
    .map(([label, e]) => ({ label, ...e, signRate: e.conversations ? e.sigs / e.conversations : 0 }))
    .sort((a, b) => b.sigs - a.sigs)
}

const turfStats = computed(() => statsBy((k) => k.turf))
const squadStats = computed(() => statsBy((k) => k.squad))

/** Knocks with no stamp would dwarf the real bars (most sim history predates
 * any turf being cut) — charts skip that bucket, the tables keep it. The
 * help sheet tells the story; there's no inline footnote anymore. */
const chartableTurfs = computed(() => turfStats.value.filter((t) => t.label !== NO_TURF))
const chartableSquads = computed(() => squadStats.value.filter((s) => s.label !== NO_SQUAD))

const signaturesByTurf = computed<BarItem[]>(() =>
  chartableTurfs.value.map((t) => ({
    label: t.label,
    value: t.sigs,
    detail: `${fmtCount(t.knocks)} knocks, ${fmtCount(t.conversations)} conversations`,
    note: `Sign rate ${fmtPct(t.signRate, 1)}`,
  })),
)
const signRateByTurf = computed(() => signRateBy((k) => k.turf, (k) => k.turf !== NO_TURF, 10))
const coverageByTurf = computed<BarItem[]>(() =>
  chartableTurfs.value
    .filter((t) => (turfAddressTotals.value.get(t.label) ?? 0) > 0)
    .map((t) => {
      const total = turfAddressTotals.value.get(t.label)!
      return {
        label: t.label,
        value: Math.min(1, t.doors.size / total),
        detail: `${fmtCount(t.doors.size)} of ${fmtCount(total)} doors in the turf`,
        note: `${fmtCount(Math.max(0, total - t.doors.size))} still to knock`,
      }
    })
    .sort((a, b) => b.value - a.value),
)

const groupRows = (stats: GroupStats[]) =>
  stats.map((e) => [
    e.label,
    e.days.size,
    e.knocks,
    e.doors.size,
    e.conversations,
    e.sigs,
    fmtPct(e.signRate, 1),
    fmtPct(e.interactions ? e.conversations / e.interactions : 0, 1),
  ])
const GROUP_COLUMNS = ['', 'Days out', 'Knocks', 'Doors', 'Conversations', 'Signatures', 'Sign rate', 'Answer rate']

const signaturesBySquad = computed<BarItem[]>(() =>
  chartableSquads.value.map((s) => ({
    label: s.label,
    value: s.sigs,
    detail: `${s.days.size} day${s.days.size === 1 ? '' : 's'} out, ${fmtCount(s.knocks)} knocks`,
    note: `Sign rate ${fmtPct(s.signRate, 1)}`,
  })),
)
const signRateBySquad = computed(() => signRateBy((k) => k.squad, (k) => k.squad !== NO_SQUAD, 10))

// ---------------------------------------------------------------- odds
// The Odds tab is a PREDICTOR, not a set of charts (2026-07-27, user call:
// "get rid of all of these and just have a place here that lets you put in a
// particular address, and it gives you the probabilities of what will happen
// on the next knock"). Four campaign-wide charts went: answer and sign rate by
// visit, the weekday-by-hour heatmap, and the door funnel. The inputs they
// used to justify still exist in enrich() and are read HERE now.
//
// IT DELIBERATELY IGNORES THE DAY CHIPS, and that is the one trap worth
// naming: every other tab filters what it reports, so the default behaviour of
// this shared scope row is that this tab would filter what it LEARNS FROM.
// Under the Today chip the model would have nothing to fit at all. Same
// reasoning the trailing 7-day mean already applies by reaching back past the
// window: a door's odds are a fact about the door, not about which chip is
// selected. The chips are hidden here and the scope row says what is in use.

/** Built from every knock and every door, once. `rank: true` scores the whole
 *  county so a single house can be placed against all of them, which is what
 *  "compare one house to everything" needs. */
const oddsModel = computed(() =>
  knocks.value.length && doorRows.value.length
    ? buildOddsModel(
        knocks.value.map((k) => ({ household: k.household, ts: k.ts, outcome: k.outcome })),
        doorRows.value.map((d) => ({
          id: d.id,
          street: d.street,
          city: d.city,
          lat: d.lat,
          lng: d.lng,
          residents: d.persons?.[0]?.count ?? 0,
        })),
        { rank: true },
      )
    : null,
)

/** How well it did on knocks it was not shown. Measured rather than claimed,
 *  because the history it learns from is mostly simulated and any sentence
 *  written here would be a claim about a simulator. */
const oddsScore = computed(() =>
  knocks.value.length && doorRows.value.length
    ? scoreOddsModel(
        knocks.value.map((k) => ({ household: k.household, ts: k.ts, outcome: k.outcome })),
        doorRows.value.map((d) => ({
          id: d.id,
          street: d.street,
          city: d.city,
          lat: d.lat,
          lng: d.lng,
          residents: d.persons?.[0]?.count ?? 0,
        })),
      )
    : null,
)

/**
 * ONE BOX (2026-07-27, user call: "rather than have the toggles for a house, a
 * street, or a canvasser, it should just have that all combined in one box that
 * we can type anything, any of those things, and then when we select them, then
 * it does the comparisons").
 *
 * Four scope chips and four different pickers underneath them was four controls
 * for one intent, and it made you say what KIND of thing you were looking for
 * before you could look for it, which is a question nobody has an opinion
 * about. You know the name. Type the name.
 */
type PickKind = 'house' | 'street' | 'turf' | 'canvasser'

interface OddsHit {
  kind: PickKind
  /** Household id, street key, turf id, or profile id. */
  id: string
  label: string
  sub: string
}

const KIND_LABEL: Record<PickKind, string> = {
  house: 'House',
  street: 'Street',
  turf: 'Turf',
  canvasser: 'Canvasser',
}

const oddsQuery = ref('')
const oddsPick = ref<OddsHit | null>(null)
const pickedDay = ref('') // canvasser only. '' = every day

/** Doors currently sitting in each turf, for the hint and for the door set. */
const doorsPerTurf = computed(() => {
  const held = new Map<string, number>()
  for (const d of doorRows.value) {
    if (d.turf_id) held.set(d.turf_id, (held.get(d.turf_id) ?? 0) + 1)
  }
  return held
})

/**
 * Everything the box can find, mixed.
 *
 * Order is by KIND rather than by score, because the kinds answer questions of
 * very different sizes and a manager typing "mil" wants Milford Ave before
 * 1465 Milford Ave. Houses come last for the same reason: there are 22.7k of
 * them and they are the narrowest thing here. The exception is a query with a
 * digit in it, which is somebody typing a house number, so houses go first.
 */
const oddsHits = computed<OddsHit[]>(() => {
  const m = oddsModel.value
  const q = oddsQuery.value.trim().toUpperCase()
  if (!m || q.length < 2) return []

  const streets: OddsHit[] = []
  for (const [key, ids] of m.doorsOnStreet) {
    const [name, city] = key.split('|')
    if (!name.includes(q) && !city.toUpperCase().startsWith(q)) continue
    streets.push({
      kind: 'street',
      id: key,
      label: titleCase(name),
      sub: `${city}, ${fmtCount(ids.length)} doors`,
    })
    if (streets.length > 200) break
  }
  streets.sort(
    (a, b) => Number(b.label.toUpperCase().startsWith(q)) - Number(a.label.toUpperCase().startsWith(q)),
  )

  const turfs: OddsHit[] = turfRows.value
    .filter((t) => t.name.toUpperCase().includes(q) && (doorsPerTurf.value.get(t.id) ?? 0) > 0)
    .map((t) => ({
      kind: 'turf' as const,
      id: t.id,
      label: t.name,
      sub: `${fmtCount(doorsPerTurf.value.get(t.id) ?? 0)} doors`,
    }))

  const people: OddsHit[] = canvasserStats.value
    .filter((c) => c.name.toUpperCase().includes(q))
    .map((c) => ({
      kind: 'canvasser' as const,
      id: c.id,
      label: c.name,
      sub: `${fmtCount(c.knocks)} knocks`,
    }))

  // Houses come from the raw address rows, so they need the same town filter
  // the model applied to everything else: without it the box happily offers a
  // house in a town the campaign has never knocked, whose odds would be the
  // bare campaign baseline dressed up as a reading about that house.
  const onGround = m.cities ? new Set(m.cities) : null
  const houses: OddsHit[] = doorRows.value
    .filter((d) => d.street.toUpperCase().includes(q) && (!onGround || onGround.has(d.city)))
    .slice(0, 60)
    .map((d) => ({ kind: 'house' as const, id: d.id, label: d.street, sub: d.city }))
  houses.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))

  const hasNumber = /\d/.test(q)
  const groups = hasNumber
    ? [houses.slice(0, 25), streets.slice(0, 6), turfs.slice(0, 4), people.slice(0, 4)]
    : [streets.slice(0, 10), turfs.slice(0, 6), people.slice(0, 6), houses.slice(0, 20)]
  return groups.flat()
})

/** Clearing the box clears the pick: the panel below must never be describing
 *  something the box no longer names. */
function pickOdds(hit: OddsHit) {
  oddsPick.value = hit
  pickedDay.value = ''
  oddsQuery.value = ''
}
function clearOddsPick() {
  oddsPick.value = null
  oddsQuery.value = ''
}

/**
 * Arriving from somewhere else with a door already in mind.
 *
 * Talk and the two maps carry a compact odds panel for managers, and its "Open
 * on Odds" link lands here as `?tab=odds&door=<id>`. Resolved after the load
 * rather than on mount, because the label comes out of the address rows and
 * there are none until then.
 */
function applyOddsDeepLink() {
  const q = route.query
  if (q.tab !== 'odds') return
  tab.value = 'odds'
  const id = typeof q.door === 'string' ? q.door : ''
  if (!id) return
  const d = doorRows.value.find((x) => x.id === id)
  if (d) oddsPick.value = { kind: 'house', id: d.id, label: d.street, sub: d.city }
}

/** Days that canvasser was out, newest first. */
const personDays = computed(() => {
  const pick = oddsPick.value
  if (pick?.kind !== 'canvasser') return []
  const days = new Set<string>()
  for (const k of knocks.value) if (k.canvasser === pick.id) days.add(k.day)
  return [...days].sort().reverse().slice(0, 30)
})

/**
 * The doors one canvasser is responsible for, resolved in a stated order.
 *
 * Turf in this app is usually dispatched to a SQUAD rather than to a person,
 * and on a fresh cut it may be dispatched to nobody at all, so a single rule
 * would leave this empty most days. Three rules, and the panel says which one
 * it used, so the number is never quietly about something other than what was
 * asked for.
 */
const personDoors = computed<{ ids: string[]; how: string }>(() => {
  const pick = oddsPick.value
  if (pick?.kind !== 'canvasser') return { ids: [], how: '' }
  const person = pick.id
  const day = pickedDay.value
  const inDay = (k: Knock) => k.canvasser === person && (!day || k.day === day)

  // 1. Turf handed to them by name.
  const mine = new Set(turfRows.value.filter((t) => t.assignee_id === person).map((t) => t.id))
  if (mine.size) {
    const ids = doorRows.value.filter((d) => d.turf_id && mine.has(d.turf_id)).map((d) => d.id)
    if (ids.length) return { ids, how: 'Turf assigned to them' }
  }

  // 2. Turf dispatched to a crew they were out with, taken from the squad
  //    stamped on their own knocks.
  const squads = new Set<string>()
  for (const k of knocks.value) if (inDay(k) && k.squadId) squads.add(k.squadId)
  if (squads.size) {
    const crew = new Set(
      turfRows.value.filter((t) => t.squad_id && squads.has(t.squad_id)).map((t) => t.id),
    )
    if (crew.size) {
      const ids = doorRows.value.filter((d) => d.turf_id && crew.has(d.turf_id)).map((d) => d.id)
      if (ids.length) return { ids, how: "Their crew's turf" }
    }
  }

  // 3. The doors they actually knocked. Always something, and a perfectly good
  //    question: what is left at the doors they worked.
  const ids = [...new Set(knocks.value.filter(inDay).map((k) => k.household))]
  return { ids, how: 'Doors they knocked' }
})

/** The door ids the pick resolves to. Null for a single house, which has its
 *  own panel. */
const oddsDoorSet = computed<{ ids: string[]; title: string; how: string } | null>(() => {
  const m = oddsModel.value
  const pick = oddsPick.value
  if (!m) return null
  // Nothing typed yet: the whole county, which is the amalgamation of every
  // door and the thing every other answer on this tab gets compared against
  // (2026-07-27, user call). It is a real reading in its own right: how much
  // is left out there, and what one knock is worth on average.
  if (!pick) {
    // The model's OWN door set, not every row fetched: it keeps only the towns
    // the campaign has actually knocked in, so this cannot quietly average in
    // 10k doors in places nobody has ever been.
    return {
      ids: [...m.doorsOnStreet.values()].flat(),
      title: 'The average door',
      how: m.cities?.length ? `every door in ${m.cities.join(', ')}` : 'every door on file',
    }
  }
  if (pick.kind === 'street') {
    return { ids: m.doorsOnStreet.get(pick.id) ?? [], title: pick.label, how: pick.sub }
  }
  if (pick.kind === 'turf') {
    return {
      ids: doorRows.value.filter((d) => d.turf_id === pick.id).map((d) => d.id),
      title: pick.label,
      how: 'Turf',
    }
  }
  if (pick.kind === 'canvasser') {
    const { ids, how } = personDoors.value
    return { ids, title: pick.label, how }
  }
  return null
})

const setResult = computed(() => {
  const m = oddsModel.value
  const set = oddsDoorSet.value
  return m && set && set.ids.length ? setOdds(m, set.ids) : null
})

const houseResult = computed(() => {
  const m = oddsModel.value
  const pick = oddsPick.value
  if (!m || pick?.kind !== 'house') return null
  return doorOdds(m, pick.id)
})

const housePercentile = computed(() => {
  const m = oddsModel.value
  const h = houseResult.value
  return m && h?.signature ? percentileOf(m, h.signature.p) : null
})

const pickedDoorRow = computed(() =>
  oddsPick.value?.kind === 'house'
    ? (doorRows.value.find((d) => d.id === oddsPick.value!.id) ?? null)
    : null,
)

/** "1st", "2nd", "12th". Only ever used for a street's place in a ranking. */
function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

const scoreSubtitle = computed(() =>
  oddsScore.value ? `tested on the last ${oddsScore.value.days} days, held back` : '',
)

const oddsPct = (p: number) => fmtPct(p, 1)
const oddsBand = (e: { lo: number; hi: number }) =>
  `Likely between ${fmtPct(e.lo)} and ${fmtPct(e.hi)}`

/** "9 points above the campaign average", or that it is not really different. */
function versusText(b: { lift: number; verdict: string } | undefined, what: string): string {
  if (!b) return ''
  if (b.verdict === 'typical') return `About average for the campaign on ${what}`
  return `${Math.abs(b.lift).toFixed(1)} points ${b.verdict} the campaign on ${what}`
}

const houseTiles = computed<Tile[]>(() => {
  const h = houseResult.value
  if (!h || !h.answer || !h.sign || !h.signature) return []
  return [
    {
      label: 'Somebody answers',
      value: oddsPct(h.answer.p),
      hint: oddsBand(h.answer),
    },
    {
      label: 'They sign, if they answer',
      value: oddsPct(h.sign.p),
      hint: oddsBand(h.sign),
    },
    {
      label: 'A signature this knock',
      value: oddsPct(h.signature.p),
      hint: versusText(h.vsCampaign?.signature, 'a knock'),
    },
    {
      // Said forwards, not as a percentile: "top 71%" is true of a door in the
      // bottom three quarters and reads like praise.
      label: 'Against every door',
      value:
        housePercentile.value == null ? 'none yet' : `better than ${housePercentile.value}%`,
      hint: `of the ${fmtCount(oddsModel.value?.doorScores.length ?? 0)} doors still worth knocking`,
    },
  ]
})

const setTiles = computed<Tile[]>(() => {
  const s = setResult.value
  if (!s) return []
  const perDoor = s.open ? s.expectedSignatures.value / s.open : 0
  const rates: Tile[] = [
    {
      label: 'Somebody answers',
      value: s.answer ? oddsPct(s.answer.p) : 'none yet',
      hint: versusText(s.vsCampaign?.answer, 'answering'),
    },
    {
      label: 'They sign, if they answer',
      value: s.sign ? oddsPct(s.sign.p) : 'none yet',
      hint: versusText(s.vsCampaign?.sign, 'signing'),
    },
  ]

  // THE AVERAGE DOOR GETS RATES, NOT A FORECAST (2026-07-27, user call:
  // "expected conversations and expected signatures doesn't make any sense
  // [there], that's covered by somebody answers and they sign if they
  // answer"). Over the whole campaign those totals are only the rates times
  // the door count, so they add nothing and read as a projection nobody made;
  // and "the same doors on average ground" is comparing the average with
  // itself. For a street or a turf they are the whole point, because that is
  // somebody deciding how to spend a morning.
  if (!oddsPick.value) {
    // These are FORWARD numbers over the doors that are left, so comparing
    // them against the campaign is comparing the average with itself and
    // reads as a verdict on nothing. What is worth saying is the contrast:
    // the remaining doors answer less often than the ones already worked,
    // because the easy ones have been done. Stating the historical figure
    // beside it is also what keeps this from repeating the Overview tab,
    // which reports that figure and only that figure.
    const m = oddsModel.value
    return [
      { label: 'Doors', value: fmtCount(s.doors), hint: `${fmtCount(s.open)} still worth knocking` },
      {
        label: 'Somebody answers',
        value: s.answer ? oddsPct(s.answer.p) : 'none yet',
        hint: m ? `${oddsPct(m.campaignAnswer)} of interactions so far` : undefined,
      },
      {
        label: 'They sign, if they answer',
        value: s.sign ? oddsPct(s.sign.p) : 'none yet',
        hint: m ? `${oddsPct(m.campaignSign)} of conversations so far` : undefined,
      },
      { label: 'A signature this knock', value: oddsPct(perDoor), hint: 'the two multiplied' },
    ]
  }

  return [
    { label: 'Doors', value: fmtCount(s.doors), hint: `${fmtCount(s.open)} still worth knocking` },
    {
      label: 'Expected conversations',
      value: s.expectedConversations.value.toFixed(0),
      hint: `${s.expectedConversations.lo.toFixed(0)} to ${s.expectedConversations.hi.toFixed(0)}`,
    },
    {
      label: 'Expected signatures',
      value: s.expectedSignatures.value.toFixed(0),
      hint: `${s.expectedSignatures.lo.toFixed(0)} to ${s.expectedSignatures.hi.toFixed(0)}`,
    },
    {
      label: 'The same doors, average ground',
      value: s.typicalYield.signatures.toFixed(0),
      hint: 'signatures, at the campaign average',
    },
    ...rates,
  ]
})

/**
 * When to go, as a grid rather than a bar chart (2026-07-27, user call: "a lot
 * of the words are kind of cut off on the left, really we could just put a
 * regular time grid like we have on the other page, and it should tell us the
 * odds that they will answer and the odds that they will sign").
 *
 * A bar chart puts its labels in a 130px gutter and "Weekday afternoon, 3 to 5
 * PM" does not fit in one. A grid gives the label two axes to live on.
 *
 * TWO grids, because they answer different questions and only one of them
 * varies with the clock: the chance somebody ANSWERS moves a lot by time of
 * day, and the chance they SIGN once they have answered does not move
 * measurably at all (see odds.ts). So the second grid is the two multiplied,
 * which is what a signature costs at that hour, and it varies for the honest
 * reason rather than by pretending signing has a timetable.
 */
const TIME_ROWS = ['Weekday', 'Weekend']
const TIME_COLS = ['Morning', 'Midday', 'Afternoon', 'Evening']
const TIME_PARTS = ['morning', 'midday', 'afternoon', 'evening']

const timeGrid = computed(() => {
  const list = setResult.value?.bestTimes ?? houseResult.value?.bestTimes ?? []
  const by = new Map(list.map((b) => [b.key, b]))
  const signP = setResult.value?.sign?.p ?? houseResult.value?.sign?.p ?? 0
  const answer: (number | null)[][] = []
  const signature: (number | null)[][] = []
  const counts: number[][] = []
  for (const w of ['wd', 'we']) {
    const a: (number | null)[] = []
    const s: (number | null)[] = []
    const c: number[] = []
    for (const part of TIME_PARTS) {
      const b = by.get(`${part}|${w}`)
      a.push(b ? b.p : null)
      s.push(b ? b.p * signP : null)
      c.push(b?.n ?? 0)
    }
    answer.push(a)
    signature.push(s)
    counts.push(c)
  }
  return { answer, signature, counts, any: list.length > 0 }
})

const timeRows = (values: (number | null)[][]) =>
  TIME_ROWS.map((r, i) => [r, ...values[i].map((v) => (v == null ? 'too few' : fmtPct(v, 1)))])

/** Where each closed door went, so a small "still open" number explains
 *  itself instead of just looking wrong. */
const closedRows = computed(() =>
  (setResult.value?.closedBreakdown ?? []).map((c) => [c.label, c.count]),
)

const streetsInSet = computed<BarItem[]>(() =>
  (setResult.value?.streets ?? []).map((s) => ({
    label: titleCase(s.name),
    value: s.open,
    detail: `${fmtCount(s.doors)} doors, ${fmtCount(s.open)} still worth knocking`,
  })),
)

// ---------------------------------------------------------------- canvassers

const canvasserStats = computed(() => {
  const per = new Map<string, { knocks: number; interactions: number; conversations: number; sigs: number }>()
  for (const k of filtered.value) {
    const e = per.get(k.canvasser) ?? { knocks: 0, interactions: 0, conversations: 0, sigs: 0 }
    e.knocks++
    if (k.interacted) e.interactions++
    if (k.conversed) e.conversations++
    if (k.signed) e.sigs++
    per.set(k.canvasser, e)
  }
  return [...per.entries()]
    .map(([id, e]) => ({
      id,
      name: canvasserNames.value.get(id) ?? 'Unknown',
      ...e,
      signRate: e.conversations ? e.sigs / e.conversations : 0,
    }))
    .sort((a, b) => b.sigs - a.sigs)
})

const scatterPoints = computed<ScatterPoint[]>(() =>
  canvasserStats.value
    .filter((c) => c.conversations >= 20)
    .map((c) => ({ x: c.knocks, y: c.signRate, label: c.name, id: c.id })),
)
const scatterFit = computed(() => linearRegression(scatterPoints.value.map((p) => ({ x: p.x, y: p.y }))))

/** The whole roster, longest bar first. It used to carry its own Everyone /
 * Top 12 chip pair; BarChart's own cap does that for every long chart on the
 * page now, and two controls for one intent is one too many. */
const signatureEarners = computed<BarItem[]>(() =>
  canvasserStats.value.map((c) => ({
    id: c.id,
    label: c.name,
    value: c.sigs,
    detail: `${fmtCount(c.knocks)} knocks, ${fmtCount(c.conversations)} conversations`,
    note: `Sign rate ${fmtPct(c.signRate, 1)}`,
  })),
)

const canvasserRows = computed(() =>
  canvasserStats.value.map((c) => [
    c.name,
    c.knocks,
    c.conversations,
    c.sigs,
    fmtPct(c.signRate, 1),
    fmtPct(c.interactions ? c.conversations / c.interactions : 0, 1),
  ]),
)
const CANVASSER_COLUMNS = ['Canvasser', 'Knocks', 'Conversations', 'Signatures', 'Sign rate', 'Answer rate']

// ---------------------------------------------------------------- focus panel
// ---------------------------------------------------------------- appointments
// The "Return" follow-up (2026-07-26). Nothing here is
// stored: an appointment is KEPT when a knock landed at that door inside its
// window, LATE when the return came after it, MISSED when nobody ever went
// back — read straight off the knock history already in memory. Only
// "canceled" comes from the row itself, because no knock can imply it.

type ApptState = 'kept' | 'late' | 'missed' | 'pending' | 'canceled'

interface ApptResult {
  appt: Appt
  state: ApptState
  /** Outcome of the first knock at or after the window opened — what going
   * back actually got. Null until somebody goes. */
  outcome: KnockOutcome | null
}

/** Every door's knocks, ts-ascending (knocks.value is already sorted). */
const knocksByDoor = computed(() => {
  const by = new Map<string, Knock[]>()
  for (const k of knocks.value) {
    const list = by.get(k.household)
    if (list) list.push(k)
    else by.set(k.household, [k])
  }
  return by
})

const apptResults = computed<ApptResult[]>(() => {
  const now = Date.now()
  const { start, end } = rangeWindow.value
  const out: ApptResult[] = []
  for (const a of appointments.value) {
    if (a.start < start || a.start >= end) continue
    const back = knocksByDoor.value.get(a.household_id)?.find((k) => k.ts >= a.start) ?? null
    let state: ApptState
    if (a.canceled) state = 'canceled'
    else if (back && back.ts <= a.end) state = 'kept'
    else if (now <= a.end) state = 'pending'
    else if (back) state = 'late'
    else state = 'missed'
    out.push({ appt: a, state, outcome: back?.outcome ?? null })
  }
  return out
})

/** Windows that have closed and weren't called off — the only ones a kept
 * rate can honestly be taken over. */
const apptResolved = computed(() =>
  apptResults.value.filter((r) => r.state !== 'pending' && r.state !== 'canceled'),
)
const apptKeptRate = computed(() => {
  const res = apptResolved.value
  return res.length ? res.filter((r) => r.state === 'kept').length / res.length : 0
})

const apptTiles = computed<Tile[]>(() => {
  const r = apptResults.value
  const count = (s: ApptState) => r.filter((x) => x.state === s).length
  const signed = r.filter((x) => x.state === 'kept' && x.outcome === 'signed').length
  const kept = count('kept')
  return [
    { label: 'Booked', value: fmtCount(r.length) },
    { label: 'Kept', value: fmtCount(kept), hint: 'went back inside the window' },
    {
      label: 'Kept rate',
      value: apptResolved.value.length ? fmtPct(apptKeptRate.value, 1) : 'none yet',
      hint: 'of windows already closed',
    },
    { label: 'Missed', value: fmtCount(count('missed')) },
    { label: 'Back late', value: fmtCount(count('late')) },
    { label: 'Still to come', value: fmtCount(count('pending')) },
    {
      label: 'Signed on return',
      value: fmtCount(signed),
      hint: kept ? `${fmtPct(signed / kept, 1)} of kept` : undefined,
    },
  ]
})

const apptDayKey = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Own day axis, not the knock one: appointments run into the future, and a
 * chart that stops at yesterday's last knock would hide what's booked. */
const apptDaily = computed(() => {
  const rs = apptResults.value
  const axis: string[] = []
  const booked: number[] = []
  const kept: number[] = []
  if (!rs.length) return { axis, booked, kept }
  let min = Infinity
  let max = -Infinity
  for (const r of rs) {
    min = Math.min(min, r.appt.start)
    max = Math.max(max, r.appt.start)
  }
  // Stepped by calendar day rather than +86.4e6 ms, so a DST change doesn't
  // slide every later bucket by an hour.
  const cursor = new Date(min)
  cursor.setHours(0, 0, 0, 0)
  const maxKey = apptDayKey(max)
  for (;;) {
    const key = apptDayKey(cursor.getTime())
    axis.push(key)
    if (key === maxKey || axis.length > 400) break
    cursor.setDate(cursor.getDate() + 1)
  }
  const idx = new Map(axis.map((d, i) => [d, i]))
  booked.push(...new Array(axis.length).fill(0))
  kept.push(...new Array(axis.length).fill(0))
  for (const r of rs) {
    const i = idx.get(apptDayKey(r.appt.start))
    if (i == null) continue
    booked[i]++
    if (r.state === 'kept') kept[i]++
  }
  return { axis, booked, kept }
})

const apptSeries = computed<TimeSeries[]>(() => [
  { name: 'Booked', color: cat.value[0], values: apptDaily.value.booked, area: true },
  { name: 'Kept', color: cat.value[1], values: apptDaily.value.kept },
])

/** Kept rate per time-of-day window, in clock order — which windows people
 * are actually home for. The one number that changes how a crew plans. */
const keptByWindow = computed<BarItem[]>(() => {
  const per = new Map<number, { n: number; k: number; label: string }>()
  for (const r of apptResolved.value) {
    const start = new Date(r.appt.start)
    const key = start.getHours() * 60 + start.getMinutes()
    const e = per.get(key) ?? { n: 0, k: 0, label: windowLabel(start, new Date(r.appt.end)) }
    e.n++
    if (r.state === 'kept') e.k++
    per.set(key, e)
  }
  return [...per.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => rateItem(e.label, e.k, e.n, 'windows kept'))
})

/** What the return visit got, counting kept AND late returns — the door was
 * worked either way. */
const apptOutcomeMix = computed<BarItem[]>(() => {
  const counts = new Map<KnockOutcome, number>()
  let total = 0
  for (const r of apptResults.value) {
    if (!r.outcome || (r.state !== 'kept' && r.state !== 'late')) continue
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
    total++
  }
  return OUTCOMES.map((o) => ({
    label: o.short,
    value: counts.get(o.value) ?? 0,
    color: o.hex,
    detail: `${fmtPct((counts.get(o.value) ?? 0) / Math.max(1, total), 1)} of the ${fmtCount(total)} return visits`,
  }))
})

const apptByCanvasser = computed<BarItem[]>(() => {
  const per = new Map<string, { n: number; k: number }>()
  for (const r of apptResults.value) {
    const e = per.get(r.appt.canvasser_id) ?? { n: 0, k: 0 }
    e.n++
    if (r.state === 'kept') e.k++
    per.set(r.appt.canvasser_id, e)
  }
  return [...per.entries()]
    .map(([id, e]) => ({
      id,
      label: canvasserNames.value.get(id) ?? 'Unknown',
      value: e.n,
      detail: `${fmtCount(e.k)} of them kept`,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
})

const apptRows = computed(() =>
  apptDaily.value.axis.map((d, i) => [d, apptDaily.value.booked[i], apptDaily.value.kept[i]]),
)

// One shared drill-down layout for whichever entity is focused: tiles, the
// signatures trend with its 7-day average, two cross-linking rankings, and
// the outcome mix.

const focusDaily = computed(() => dailyFor(focusKnocks.value))
// Same entity, every day loaded — the trend's average reaches back past the
// window exactly as the overview's does.
const focusDayTotals = computed(() => {
  const pick = focusPick.value
  return dayTotals(pick ? knocks.value.filter(pick) : [])
})
const focusSigAvg = computed(() =>
  trailingMean(focusDaily.value.axis, focusDayTotals.value.sigsByDay, focusDayTotals.value.firstDay),
)
const focusTrend = computed<TimeSeries[]>(() => [
  { name: 'Signatures', color: cat.value[0], values: focusDaily.value.sigsPerDay, area: true },
  { name: '7-day average', color: cat.value[1], values: focusSigAvg.value, width: 3.5, dash: true },
])
const focusTrendRows = computed(() =>
  focusDaily.value.axis.map((d, i) => [d, focusDaily.value.sigsPerDay[i], fmtAvg(focusSigAvg.value[i])]),
)
const focusMix = computed(() => mixFor(focusKnocks.value))

const focusTiles = computed<Tile[]>(() => {
  const f = focus.value
  const sub = focusKnocks.value
  const doors = new Set(sub.map((k) => k.household)).size
  const sigs = sub.filter((k) => k.signed).length
  const conversations = sub.filter((k) => k.conversed).length
  const interactions = sub.filter((k) => k.interacted).length
  const days = new Set(sub.map((k) => k.day)).size
  const people = new Set(sub.map((k) => k.canvasser)).size
  const tiles: Tile[] = [
    { label: 'Signatures', value: fmtCount(sigs) },
    { label: 'Doors knocked', value: fmtCount(doors), hint: 'counted once each' },
    { label: 'Knocks', value: fmtCount(sub.length), hint: 'every visit, repeats included' },
    { label: 'Conversations', value: fmtCount(conversations), hint: 'somebody came to the door' },
    {
      label: 'Answer rate',
      value: interactions ? fmtPct(conversations / interactions, 1) : 'none yet',
      hint: 'of interactions, somebody answered',
    },
    {
      label: 'Sign rate',
      value: conversations ? fmtPct(sigs / conversations, 1) : 'none yet',
      hint: 'of conversations, they signed',
    },
    { label: 'Days active', value: fmtCount(days) },
  ]
  if (f && f.kind !== 'canvasser') tiles.push({ label: 'Canvassers', value: fmtCount(people) })
  const total = f?.kind === 'turf' ? turfAddressTotals.value.get(f.label) : undefined
  if (total) {
    tiles.push({
      label: 'Coverage',
      value: fmtPct(Math.min(1, doors / total), 1),
      hint: `${fmtCount(doors)} of ${fmtCount(total)} doors reached`,
    })
  }
  return tiles
})

function rankBy(sub: Knock[], key: (k: Knock) => string, exclude?: string): BarItem[] {
  const per = new Map<string, { knocks: number; sigs: number; conversations: number }>()
  for (const k of sub) {
    const label = key(k)
    if (label === exclude) continue
    let e = per.get(label)
    if (!e) {
      e = { knocks: 0, sigs: 0, conversations: 0 }
      per.set(label, e)
    }
    e.knocks++
    if (k.signed) e.sigs++
    if (k.conversed) e.conversations++
  }
  return [...per.entries()]
    .map(([label, e]) => ({
      label,
      value: e.sigs,
      detail: `${fmtCount(e.knocks)} knocks, ${fmtCount(e.conversations)} conversations`,
      note: `Sign rate ${fmtPct(e.conversations ? e.sigs / e.conversations : 0, 1)}`,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
}

function rankPeople(sub: Knock[]): BarItem[] {
  const per = new Map<string, { knocks: number; sigs: number; conversations: number }>()
  for (const k of sub) {
    let e = per.get(k.canvasser)
    if (!e) {
      e = { knocks: 0, sigs: 0, conversations: 0 }
      per.set(k.canvasser, e)
    }
    e.knocks++
    if (k.signed) e.sigs++
    if (k.conversed) e.conversations++
  }
  return [...per.entries()]
    .map(([id, e]) => ({
      id,
      label: canvasserNames.value.get(id) ?? 'Unknown',
      value: e.sigs,
      detail: `${fmtCount(e.knocks)} knocks, ${fmtCount(e.conversations)} conversations`,
      note: `Sign rate ${fmtPct(e.conversations ? e.sigs / e.conversations : 0, 1)}`,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
}

interface FocusRank {
  title: string
  items: BarItem[]
  open: (item: BarItem) => void
}

const focusRanks = computed<FocusRank[]>(() => {
  const f = focus.value
  if (!f) return []
  const sub = focusKnocks.value
  switch (f.kind) {
    case 'turf':
      return [
        { title: 'Crews here', items: rankBy(sub, (k) => k.squad, NO_SQUAD), open: openSquad },
        { title: 'Canvassers here', items: rankPeople(sub), open: openPerson },
      ]
    case 'squad':
      return [
        { title: 'Turf worked', items: rankBy(sub, (k) => k.turf, NO_TURF), open: openTurf },
        { title: 'Members', items: rankPeople(sub), open: openPerson },
      ]
    case 'canvasser':
      return [
        { title: 'Turf worked', items: rankBy(sub, (k) => k.turf, NO_TURF), open: openTurf },
        { title: 'Crews joined', items: rankBy(sub, (k) => k.squad, NO_SQUAD), open: openSquad },
      ]
  }
})
</script>

<template>
  <AppShell title="Analytics" :help-topic="helpTopic">
    <div v-if="loading" class="card center">
      <p class="muted">{{ loadNote }}</p>
    </div>
    <div v-else-if="loadError" class="card center">
      <p class="error">Couldn't load knock data: {{ loadError }}</p>
    </div>

    <template v-else>
      <div class="tabs" role="tablist" data-help="analytics-tabs">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="tab"
          role="tab"
          :aria-selected="tab === t.id"
          :class="{ active: tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <section class="stack">
        <!-- Every tab's own scope row: day chips + live knock count, plus the
             back chip and entity name once something is focused. -->
        <div class="scope" data-help="analytics-scope">
          <template v-if="focus">
            <button class="chip back-chip" type="button" @click="clearFocus">
              ‹ {{ focus.all }}
            </button>
            <span class="focus-name">{{ focus.label }}</span>
          </template>
          <!-- No day chips on the Odds tab: a chip there would filter what the
               model LEARNS from, and under "Today" it would have nothing to
               fit at all. It said "Every knock on record" instead until
               2026-07-27; that came out with the user's call, because the tab
               lands on the average door and the panel already names what is
               being looked at, so the line was a caption for a caption. -->
          <div v-if="tab !== 'odds'" class="chip-row" role="group" aria-label="Time window">
            <button
              v-for="r in RANGE_CHIPS"
              :key="r.value"
              type="button"
              class="chip"
              :class="{ on: rangeKey === r.value }"
              @click="pickRange(r.value)"
            >
              {{ r.label }}
            </button>
          </div>
          <span v-if="tab !== 'odds'" class="scope-right muted">
            {{ fmtCount(scopeCount) }} knocks<span v-if="showTapHint">, tap once to read, again to open</span>
          </span>
          <!-- Its own line (flex-basis 100%): the pair needs ~340px, which is
               most of a phone, so letting it flow beside the chips would only
               wrap it there anyway, mid row. -->
          <div v-if="rangeKey === 'custom' && tab !== 'odds'" class="custom-range">
            <input
              v-model="customFrom"
              type="date"
              class="day-input"
              aria-label="Window starts"
            />
            <span class="muted">to</span>
            <input v-model="customTo" type="date" class="day-input" aria-label="Window ends" />
          </div>
        </div>

        <!-- ============================== Focused entity (shared drill panel) -->
        <template v-if="focus">
          <div class="tiles">
            <div v-for="t in focusTiles" :key="t.label" class="tile">
              <span class="tile-label muted">{{ t.label }}</span>
              <span class="tile-value">{{ t.value }}</span>
              <span v-if="t.hint" class="tile-hint muted">{{ t.hint }}</span>
            </div>
          </div>

          <ChartCard
            title="Signatures per day"
            :columns="['Day', 'Signatures', 'Average of the last 7 days']"
            :rows="focusTrendRows"
          >
            <TimeSeriesChart :labels="focusDaily.axis.map(dayLabel)" :series="focusTrend" />
          </ChartCard>

          <div class="two-col">
            <ChartCard
              v-for="r in focusRanks"
              :key="r.title"
              :title="r.title"
              subtitle="most signatures first"
              :columns="[r.title, 'Signatures', 'Detail']"
              :rows="r.items.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart
                :items="r.items"
                :color="cat[0]"
                measure="Signatures"
                selectable
                @select="r.open"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="What happened at these doors"
            :columns="['Outcome', 'Knocks', 'Share']"
            :rows="focusMix.map((i) => [i.label, i.value, i.detail ?? ''])"
          >
            <BarChart :items="focusMix" :color="cat[0]" measure="Knocks logged" />
          </ChartCard>
        </template>

        <!-- ============================== Overview -->
        <template v-else-if="tab === 'overview'">
          <div class="tiles" data-help="analytics-tiles">
            <div v-for="k in kpis" :key="k.label" class="tile">
              <span class="tile-label muted">{{ k.label }}</span>
              <span class="tile-value">{{ k.value }}</span>
              <span v-if="k.hint" class="tile-hint muted">{{ k.hint }}</span>
            </div>
          </div>

          <div class="two-col">
            <ChartCard
              title="Signatures per day"
              :columns="['Day', 'Signatures', 'Average of the last 7 days']"
              :rows="sigRows"
            >
              <TimeSeriesChart :labels="overviewDaily.axis.map(dayLabel)" :series="sigSeries" />
            </ChartCard>

            <ChartCard
              title="Knocks per day"
              data-help="overview-trend"
              :columns="['Day', 'Knocks', 'Average of the last 7 days']"
              :rows="knockRows"
            >
              <TimeSeriesChart :labels="overviewDaily.axis.map(dayLabel)" :series="knockSeries" />
            </ChartCard>
          </div>

          <div class="two-col">
            <ChartCard
              title="What happened at doors"
              subtitle="knocks each day, by outcome"
              :columns="['Day', ...CHART_OUTCOMES.map((o) => o.short)]"
              :rows="overviewDaily.axis.map((d, i) => [d, ...outcomeStack.map((s) => s.values[i])])"
            >
              <StackedBarChart :labels="overviewDaily.axis.map(dayLabel)" :series="outcomeStack" :height="230" />
            </ChartCard>

            <ChartCard
              title="Outcomes in total"
              subtitle="every knock in the window"
              :columns="['Outcome', 'Knocks', 'Share']"
              :rows="outcomeMix.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="outcomeMix" :color="cat[0]" measure="Knocks logged" />
            </ChartCard>
          </div>
        </template>

        <!-- ============================== Turf (compare) -->
        <template v-else-if="tab === 'turfs'">
          <div class="two-col">
            <ChartCard
              title="Signatures by turf"
              subtitle="most first"
              :columns="['Turf', 'Signatures', 'Detail']"
              :rows="signaturesByTurf.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart
                :items="signaturesByTurf"
                :color="cat[0]"
                measure="Signatures"
                selectable
                @select="openTurf"
              />
            </ChartCard>

            <ChartCard
              title="Sign rate by turf"
              data-help="turfs-rate"
              :subtitle="signRateSubtitle"
              :columns="['Turf', 'Sign rate', 'Detail']"
              :rows="rateRows(signRateByTurf)"
            >
              <div class="chip-row base-row" role="group" aria-label="Count sign rate out of">
                <button
                  v-for="b in RATE_BASES"
                  :key="b.value"
                  type="button"
                  class="chip"
                  :class="{ on: rateBase === b.value }"
                  @click="rateBase = b.value"
                >
                  {{ b.label }}
                </button>
              </div>
              <BarChart
                :items="signRateByTurf"
                :color="cat[0]"
                percent
                selectable
                measure="Sign rate"
                :ref-value="overallRates.sign"
                ref-label="campaign average"
                :max="pctMax(signRateByTurf, overallRates.sign)"
                @select="openTurf"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Turf coverage"
            data-help="turfs-coverage"
            subtitle="share of the turf's doors knocked at least once"
            :columns="['Turf', 'Coverage', 'Detail']"
            :rows="rateRows(coverageByTurf)"
          >
            <BarChart
              :items="coverageByTurf"
              :color="cat[0]"
              percent
              :max="1"
              selectable
              measure="Turf coverage"
              @select="openTurf"
            />
          </ChartCard>

          <ChartCard
            title="All turf, by the numbers"
            data-help="turfs-table"
            :columns="['Turf', ...GROUP_COLUMNS.slice(1)]"
            :rows="groupRows(turfStats)"
            table-only
            selectable-rows
            @select-row="openTurfRow"
          />
        </template>

        <!-- ============================== Squads (compare) -->
        <template v-else-if="tab === 'squads'">
          <div class="two-col">
            <ChartCard
              title="Signatures by squad"
              data-help="squads-chart"
              subtitle="most first"
              :columns="['Squad', 'Signatures', 'Detail']"
              :rows="signaturesBySquad.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart
                :items="signaturesBySquad"
                :color="cat[0]"
                measure="Signatures"
                selectable
                @select="openSquad"
              />
            </ChartCard>

            <ChartCard
              title="Sign rate by squad"
              :subtitle="signRateSubtitle"
              :columns="['Squad', 'Sign rate', 'Detail']"
              :rows="rateRows(signRateBySquad)"
            >
              <div class="chip-row base-row" role="group" aria-label="Count sign rate out of">
                <button
                  v-for="b in RATE_BASES"
                  :key="b.value"
                  type="button"
                  class="chip"
                  :class="{ on: rateBase === b.value }"
                  @click="rateBase = b.value"
                >
                  {{ b.label }}
                </button>
              </div>
              <BarChart
                :items="signRateBySquad"
                :color="cat[0]"
                percent
                selectable
                measure="Sign rate"
                :ref-value="overallRates.sign"
                ref-label="campaign average"
                :max="pctMax(signRateBySquad, overallRates.sign)"
                @select="openSquad"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="All squads, by the numbers"
            data-help="squads-table"
            :columns="['Squad', ...GROUP_COLUMNS.slice(1)]"
            :rows="groupRows(squadStats)"
            table-only
            selectable-rows
            @select-row="openSquadRow"
          />
        </template>

        <!-- ============================== Appointments -->
        <template v-else-if="tab === 'appointments'">
          <div class="tiles" data-help="appt-tiles">
            <div v-for="t in apptTiles" :key="t.label" class="tile">
              <span class="tile-label muted">{{ t.label }}</span>
              <span class="tile-value">{{ t.value }}</span>
              <span v-if="t.hint" class="tile-hint muted">{{ t.hint }}</span>
            </div>
          </div>

          <ChartCard
            title="Kept rate by window"
            data-help="appt-windows"
            subtitle="share of closed windows somebody went back for"
            :columns="['Window', 'Kept rate', 'Detail']"
            :rows="rateRows(keptByWindow)"
          >
            <BarChart
              :items="keptByWindow"
              :color="cat[0]"
              percent
              measure="Kept rate"
              :ref-value="apptKeptRate"
              ref-label="overall"
              :max="pctMax(keptByWindow, apptKeptRate)"
            />
          </ChartCard>

          <div class="two-col">
            <ChartCard
              title="Appointments per day"
              data-help="appt-trend"
              :columns="['Day', 'Booked', 'Kept']"
              :rows="apptRows"
            >
              <TimeSeriesChart :labels="apptDaily.axis.map(dayLabel)" :series="apptSeries" />
            </ChartCard>

            <ChartCard
              title="What the return visit got"
              subtitle="outcome of the knock that went back"
              :columns="['Outcome', 'Visits', 'Share']"
              :rows="apptOutcomeMix.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="apptOutcomeMix" :color="cat[0]" measure="Return visits" />
            </ChartCard>
          </div>

          <ChartCard
            title="Who books them"
            subtitle="most first"
            :columns="['Canvasser', 'Booked', 'Detail']"
            :rows="apptByCanvasser.map((i) => [i.label, i.value, i.detail ?? ''])"
          >
            <BarChart
              :items="apptByCanvasser"
              :color="cat[0]"
              measure="Appointments booked"
              selectable
              @select="openPerson"
            />
          </ChartCard>
        </template>

        <!-- ============================== Odds (the next-knock predictor) -->
        <template v-else-if="tab === 'odds'">
          <!-- One box for all four kinds of thing. Tap a result to see it. -->
          <input
            v-if="!oddsPick"
            v-model="oddsQuery"
            class="odds-search"
            type="search"
            placeholder="A house, a street, turf, or a canvasser"
            aria-label="Find something to work out the odds for"
            data-help="odds-scope"
          />
          <ul v-if="oddsHits.length && !oddsPick" class="odds-hits">
            <li v-for="h in oddsHits" :key="h.kind + h.id">
              <button type="button" class="odds-hit" @click="pickOdds(h)">
                <span class="odds-hit-kind">{{ KIND_LABEL[h.kind] }}</span>
                <span class="odds-hit-name">{{ h.label }}</span>
                <span class="muted odds-hit-sub">{{ h.sub }}</span>
              </button>
            </li>
          </ul>
          <p
            v-else-if="!oddsPick && oddsQuery.trim().length >= 2"
            class="muted odds-empty"
          >
            Nothing by that name.
          </p>

          <!-- Which day, once a canvasser is picked. -->
          <div
            v-if="oddsPick?.kind === 'canvasser' && personDays.length"
            class="chip-row"
            role="group"
            aria-label="Which day"
          >
            <button
              type="button"
              class="chip"
              :class="{ on: pickedDay === '' }"
              @click="pickedDay = ''"
            >
              Every day
            </button>
            <button
              v-for="d in personDays"
              :key="d"
              type="button"
              class="chip"
              :class="{ on: pickedDay === d }"
              @click="pickedDay = d"
            >
              {{ dayLabel(d) }}
            </button>
          </div>

          <!-- ONE HOUSE -->
          <template v-if="houseResult">
            <div class="scope">
              <button class="chip back-chip" type="button" @click="clearOddsPick">
                ‹ Something else
              </button>
              <span class="focus-name">{{ pickedDoorRow?.street }}</span>
              <span class="scope-right muted">{{ pickedDoorRow?.city }}</span>
            </div>

            <p v-if="houseResult.closed" class="card odds-closed">
              <strong>No next knock here.</strong> {{ houseResult.closedNote }}
            </p>

            <template v-else>
              <div class="tiles" data-help="odds-house">
                <div v-for="t in houseTiles" :key="t.label" class="tile">
                  <span class="tile-label muted">{{ t.label }}</span>
                  <span class="tile-value">{{ t.value }}</span>
                  <span v-if="t.hint" class="tile-hint muted">{{ t.hint }}</span>
                </div>
              </div>

              <ChartCard
                title="Where this comes from"
                data-help="odds-why"
                :columns="['Taken into account', 'Running estimate', 'Evidence']"
                :rows="
                  [...houseResult.answerWhy, ...houseResult.signWhy].map((s) => [
                    s.label,
                    fmtPct(s.p, 1),
                    s.detail,
                  ])
                "
                table-only
              />
            </template>
          </template>

          <!-- A SET OF DOORS -->
          <template v-else-if="setResult && oddsDoorSet">
            <div class="scope">
              <button
                v-if="oddsPick"
                class="chip back-chip"
                type="button"
                @click="clearOddsPick"
              >
                ‹ Something else
              </button>
              <span class="focus-name">{{ oddsDoorSet.title }}</span>
              <span v-if="oddsDoorSet.how" class="scope-right muted">{{ oddsDoorSet.how }}</span>
            </div>

            <div class="tiles" data-help="odds-set">
              <div v-for="t in setTiles" :key="t.label" class="tile">
                <span class="tile-label muted">{{ t.label }}</span>
                <span class="tile-value">{{ t.value }}</span>
                <span v-if="t.hint" class="tile-hint muted">{{ t.hint }}</span>
              </div>
            </div>

            <p v-if="setResult.streetRank" class="muted odds-rank">
              {{ ordinal(setResult.streetRank.place) }} friendliest of
              {{ fmtCount(setResult.streetRank.of) }} streets with enough knocks behind them.
            </p>

            <div class="two-col">
              <ChartCard
                v-if="closedRows.length"
                title="Doors already closed"
                subtitle="left out of the totals above"
                :columns="['Why', 'Doors']"
                :rows="closedRows"
                table-only
              />

              <!-- Only once something is picked: unpicked this is every street
                   in the county, which is a directory rather than a reading. -->
              <ChartCard
                v-if="oddsPick && streetsInSet.length > 1"
                title="Streets in here"
                data-help="odds-streets"
                subtitle="doors still worth knocking"
                :columns="['Street', 'Open doors', 'Detail']"
                :rows="streetsInSet.map((i) => [i.label, i.value, i.detail ?? ''])"
              >
                <BarChart
                  :items="streetsInSet"
                  :color="cat[0]"
                  measure="Doors still worth knocking"
                />
              </ChartCard>
            </div>
          </template>

          <!-- When to go. Two grids: answering moves with the clock, signing
               does not, so the second is the two multiplied. -->
          <div v-if="timeGrid.any" class="two-col">
            <ChartCard
              title="When somebody answers"
              data-help="odds-times"
              subtitle="morning before noon, midday to 3 PM, afternoon to 5 PM, evening after 5"
              :columns="['', ...TIME_COLS]"
              :rows="timeRows(timeGrid.answer)"
            >
              <Heatmap
                :row-labels="TIME_ROWS"
                :col-labels="TIME_COLS"
                :values="timeGrid.answer"
                :counts="timeGrid.counts"
                :label-width="66"
                unit="interactions"
                :dark="palette.dark.value"
              />
            </ChartCard>

            <ChartCard
              title="When a knock gets a signature"
              subtitle="the two chances multiplied"
              :columns="['', ...TIME_COLS]"
              :rows="timeRows(timeGrid.signature)"
            >
              <Heatmap
                :row-labels="TIME_ROWS"
                :col-labels="TIME_COLS"
                :values="timeGrid.signature"
                :counts="timeGrid.counts"
                :label-width="66"
                unit="interactions"
                :dark="palette.dark.value"
              />
            </ChartCard>
          </div>

          <!-- How much to trust any of it. Measured, not written. -->
          <ChartCard
            v-if="oddsScore"
            title="How good is this guess"
            data-help="odds-quality"
            :subtitle="scoreSubtitle"
            :columns="['It said', 'That many answered', 'Doors']"
            :rows="oddsScore.bands.map((b) => [fmtPct(b.said), fmtPct(b.happened), b.n])"
            table-only
          >
            <p class="odds-quality">
              Given two doors it picked the livelier one
              <strong>{{ oddsScore.pickedLivelier }} times out of 100</strong>. Fifty would be a
              coin toss.
            </p>
          </ChartCard>
        </template>

        <!-- ============================== Canvassers (compare) -->
        <template v-else>
          <div class="two-col">
            <ChartCard
              title="Knocks against sign rate"
              data-help="canvassers-scatter"
              subtitle="one dot per canvasser"
              :columns="CANVASSER_COLUMNS"
              :rows="canvasserRows"
            >
              <ScatterChart
                :points="scatterPoints"
                :color="cat[0]"
                :fit="scatterFit"
                x-label="knocks"
                y-label="sign rate"
                y-percent
                selectable
                @select="openPerson"
              />
            </ChartCard>

            <ChartCard
              title="Signatures by canvasser"
              subtitle="most first"
              :columns="['Canvasser', 'Signatures']"
              :rows="signatureEarners.map((i) => [i.label, i.value])"
            >
              <BarChart
                :items="signatureEarners"
                :color="cat[0]"
                measure="Signatures"
                selectable
                @select="openPerson"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Everyone, by the numbers"
            data-help="canvassers-table"
            :columns="CANVASSER_COLUMNS"
            :rows="canvasserRows"
            table-only
            selectable-rows
            @select-row="openCanvasserRow"
          />
        </template>
      </section>
    </template>
  </AppShell>
</template>

<style scoped>
.center {
  text-align: center;
  padding: 3rem 1rem;
}
.error {
  color: var(--danger);
}

/* All six tabs on ONE line, at any width (2026-07-26, user call — Canvassers
   was dropping to a second row). Never wraps: the type shrinks with the
   column instead (`--app-vw`, so a 430px desktop column measures itself as
   the phone it's drawing, per style.css), capped by `--ui-scale` like every
   other bit of chrome that mustn't grow with the Text size pref.

   Measured against a replica of the stack: the six tabs fit 375 / 393 / 430px
   in both a system sans and Verdana (the widest font on offer). The overflow
   scroller is the fallback for the combinations that can't fit — Appointments
   switched on below ~430px, or a wide font on a 320px phone — because a tab
   you can swipe to beats one that's clipped off the edge, and clipped is what
   the no-sideways-scrolling rule would otherwise give it. */
.tabs {
  display: flex;
  flex-wrap: nowrap;
  justify-content: space-between;
  gap: 0;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar {
  display: none;
}
.tab {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: calc(clamp(0.7rem, calc(3 * var(--app-vw)), 0.85rem) * var(--ui-scale));
  padding: 0.45rem 0.22rem;
  flex: 0 0 auto;
  white-space: nowrap;
  cursor: pointer;
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.two-col {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr));
  gap: 1rem;
}

/* --- scope row + chips (each tab's own controls) --- */

.scope {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.chip-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.chip {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0.28rem 0.7rem;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}
.chip:hover {
  color: var(--text);
}
.chip.on {
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  border-color: var(--accent);
  color: var(--text);
}
.back-chip {
  color: var(--accent);
  font-weight: 700;
}
.focus-name {
  font-weight: 800;
  font-size: 1.05rem;
}
.scope-right {
  font-size: 0.82rem;
  margin-left: auto;
}

/* The custom window's two dates, on their own line under the chips. */
.custom-range {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  font-size: 0.82rem;
}
.day-input {
  min-height: 36px;
  padding: 0.25rem 0.5rem;
  font: inherit;
  /* The 16px floor is non-negotiable: iOS Safari zooms the whole page in
     whenever a focused field is under it. input[type=date] isn't covered by
     style.css's global field rule, so it takes the floor here. */
  font-size: max(16px, calc(0.85rem * var(--ui-scale, 1)));
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.day-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
  border-color: var(--accent);
}

/* "Per interaction / Per door knocked", inside each sign-rate card: the knob
   belongs on the chart it changes, not in a page-level filter bar. */
.base-row {
  margin-bottom: 0.5rem;
}

/* --- the Odds tab's own pickers --- */

.odds-search {
  width: 100%;
}
.odds-search {
  min-height: 40px;
  padding: 0.4rem 0.7rem;
  font: inherit;
  /* The 16px floor is not optional: iOS Safari zooms the whole page in on a
     focused field under it. type=search is covered by style.css's global
     field rule, and this restates the floor because the padding here is
     custom and the two are read together. */
  font-size: max(16px, calc(0.9rem * var(--ui-scale, 1)));
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.odds-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
  border-color: var(--accent);
}
.odds-hits {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  max-height: 40vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.odds-hit {
  appearance: none;
  width: 100%;
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  font-size: 0.9rem;
  /* A <button> centres and clamps its contents under the UA styles, same
     lesson as the Squad tiles and the streets list. */
  text-align: left;
  white-space: normal;
  padding: 0.55rem 0.7rem;
  cursor: pointer;
}
.odds-hits li:last-child .odds-hit {
  border-bottom: none;
}
/* A fixed-width kind tag, so a mixed list reads as columns rather than as one
   run-on sentence per row. */
.odds-hit-kind {
  flex: 0 0 4.6rem;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.odds-hit-name {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
}
.odds-hit-sub {
  flex: 0 0 auto;
  font-size: 0.78rem;
}
.odds-hit:hover {
  background: var(--row-tint-hover, color-mix(in srgb, var(--accent) 8%, var(--surface)));
}
.odds-empty,
.odds-rank {
  font-size: 0.85rem;
  margin: 0;
}
.odds-closed {
  padding: 0.9rem 1rem;
  margin: 0;
}
.odds-quality {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.7rem;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.tile-label {
  font-size: 0.75rem;
}
.tile-value {
  font-size: 1.5rem;
  font-weight: 600;
  line-height: 1.2;
}
.tile-hint {
  font-size: 0.7rem;
}
</style>
