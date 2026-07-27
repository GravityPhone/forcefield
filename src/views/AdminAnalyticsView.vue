<script setup lang="ts">
// Campaign Analytics — the campaign managers' numbers room. Loads the whole
// knock history once (paged, client-side), then every chart and probability
// table runs instantly in the browser: Netlify only ever serves static
// files, so ALL statistics (Wilson CIs, OLS) are computed client-side in
// src/lib/stats.ts.
//
// UI model (reworked 2026-07-21): NO global filter bar. The top of the page
// is tabs only; each tab carries its own scope — day chips on every tab, an
// area chip picker inside Areas, and tap-to-drill everywhere else (bars,
// dots, and table rows open the thing they name; drill views cross-link
// between tabs). Teaching copy lives in the per-tab help sheets
// (ANALYTICS_TAB_HELP → AppShell's "?"), never in chart subtitles — those
// stay at 2–3 word hints. (A logistic-regression "Predictor" tab existed
// until 2026-07-14 — removed as more than managers needed; stats.ts keeps
// the machinery if it ever comes back.)
import { computed, onMounted, ref, shallowRef } from 'vue'
import AppShell from '@/components/AppShell.vue'
import ChartCard from '@/components/charts/ChartCard.vue'
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue'
import type { TimeSeries } from '@/components/charts/TimeSeriesChart.vue'
import StackedBarChart from '@/components/charts/StackedBarChart.vue'
import BarChart from '@/components/charts/BarChart.vue'
import Heatmap from '@/components/charts/Heatmap.vue'
import ScatterChart from '@/components/charts/ScatterChart.vue'
import type { BarItem } from '@/components/charts/BarChart.vue'
import type { ScatterPoint } from '@/components/charts/ScatterChart.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { OUTCOMES } from '@/lib/outcomes'
import {
  appointmentSettings,
  ensureAppointmentSettings,
  windowLabel,
} from '@/lib/appointments'
import { useChartPalette, ordinalRamp, fmtPct, fmtCount } from '@/lib/chartTheme'
import { wilson, linearRegression, rollingMean } from '@/lib/stats'
import { ANALYTICS_TAB_HELP } from '@/lib/helpContent'
import type { KnockOutcome } from '@/types'

const palette = useChartPalette()
const cat = computed(() => palette.categorical.value)

// ---------------------------------------------------------------- loading

interface KnockRow {
  outcome: KnockOutcome
  occurred_at: string
  household_id: string | null
  canvasser_id: string
  // Stamped at knock time by the DB (see 20260714120000): the squad the
  // canvasser was crewing with that day and the (top-level) turf the door
  // sat in. Snapshotted names, so history survives squads/turf being re-cut.
  squad_name: string | null
  turf_name: string | null
}

interface Knock {
  outcome: KnockOutcome
  ts: number
  day: string // local YYYY-MM-DD
  hour: number
  weekday: number // 0 = Sunday
  household: string
  canvasser: string
  city: string
  squad: string
  turf: string
  attempt: number
  priorNotHomes: number
  experience: number // canvasser's knocks before this one
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
const cityAddressTotals = shallowRef<Map<string, number>>(new Map())
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

onMounted(async () => {
  try {
    const [{ count: knockCount }, { count: addrCount }] = await Promise.all([
      supabase.from('knock_logs').select('id', { count: 'exact', head: true }),
      supabase.from('addresses').select('id', { count: 'exact', head: true }),
    ])

    const [rows, addrs, profs, turfs, appts] = await Promise.all([
      fetchAllPages<KnockRow>(
        'knock_logs',
        'outcome, occurred_at, household_id, canvasser_id, squad_name, turf_name',
        knockCount ?? 0,
        (n) => (loadNote.value = `Loading knocks… ${fmtCount(n)} / ${fmtCount(knockCount ?? 0)}`),
      ),
      fetchAllPages<{ id: string; city: string; turf_id: string | null }>(
        'addresses',
        'id, city, turf_id',
        addrCount ?? 0,
        () => {},
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
        .select('id, name, parent_turf_id')
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

    const cityOf = new Map(addrs.map((a) => [a.id, a.city]))
    const totals = new Map<string, number>()
    for (const a of addrs) totals.set(a.city, (totals.get(a.city) ?? 0) + 1)
    cityAddressTotals.value = totals
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
    knocks.value = enrich(rows, cityOf)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

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

function enrich(rows: KnockRow[], cityOf: Map<string, string>): Knock[] {
  const parsed = rows
    .filter((r) => r.household_id)
    .map((r) => {
      const d = new Date(r.occurred_at)
      return {
        outcome: r.outcome,
        ts: d.getTime(),
        day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        hour: d.getHours(),
        weekday: d.getDay(),
        household: r.household_id!,
        canvasser: r.canvasser_id,
        city: cityOf.get(r.household_id!) ?? 'Unknown',
        squad: r.squad_name ?? NO_SQUAD,
        turf: r.turf_name ?? NO_TURF,
        attempt: 0,
        priorNotHomes: 0,
        experience: 0,
        interacted: r.outcome !== 'skip',
        conversed: CONVERSATION.has(r.outcome),
        signed: r.outcome === 'signed',
      }
    })
    .sort((a, b) => a.ts - b.ts)

  // attempt number + prior not-homes per household, experience per canvasser
  const perHouse = new Map<string, { attempts: number; notHomes: number; lastTs: number }>()
  const perCanvasser = new Map<string, number>()
  for (const k of parsed) {
    const h = perHouse.get(k.household) ?? { attempts: 0, notHomes: 0, lastTs: 0 }
    // knocks within 10 min at the same door are one visit (spouse signing too)
    const sameVisit = k.ts - h.lastTs < 10 * 60 * 1000 && h.attempts > 0
    if (!sameVisit) h.attempts++
    h.lastTs = k.ts
    k.attempt = h.attempts
    k.priorNotHomes = h.notHomes
    if (k.outcome === 'not_home') h.notHomes++
    perHouse.set(k.household, h)

    const xp = perCanvasser.get(k.canvasser) ?? 0
    k.experience = xp
    perCanvasser.set(k.canvasser, xp + 1)
  }
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
const ALL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'areas', label: 'Areas' },
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
// Areas/Turfs/Squads/Canvassers each hold a focused entity; the focus panel
// (one shared template block) replaces the tab's compare view. Focus sticks
// per tab, so flipping away and back keeps your place — the back chip clears.

const areaFocus = ref('')
const turfFocus = ref('')
const squadFocus = ref('')
const canvasserFocus = ref('') // profile id

interface Focus {
  kind: 'area' | 'turf' | 'squad' | 'canvasser'
  label: string
  all: string
}

const focus = computed<Focus | null>(() => {
  switch (tab.value) {
    case 'areas':
      return areaFocus.value ? { kind: 'area', label: areaFocus.value, all: 'All areas' } : null
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
  if (tab.value === 'areas') areaFocus.value = ''
  else if (tab.value === 'turfs') turfFocus.value = ''
  else if (tab.value === 'squads') squadFocus.value = ''
  else if (tab.value === 'canvassers') canvasserFocus.value = ''
}

const focusKnocks = computed<Knock[]>(() => {
  const f = focus.value
  if (!f) return []
  const src = filtered.value
  switch (f.kind) {
    case 'area':
      return src.filter((k) => k.city === f.label)
    case 'turf':
      return src.filter((k) => k.turf === f.label)
    case 'squad':
      return src.filter((k) => k.squad === f.label)
    case 'canvasser':
      return src.filter((k) => k.canvasser === canvasserFocus.value)
  }
})

// Cross-tab jumps: rankings inside a focus panel open THEIR entity's tab.
function openArea(item: BarItem) {
  areaFocus.value = item.label
  tab.value = 'areas'
}
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

const scopeCount = computed(() => (focus.value ? focusKnocks.value.length : filtered.value.length))
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

/** Every address on file, so "how much of the county is left" can be
 * answered. Range-independent on purpose: a door nobody has ever knocked is
 * not a fact about the last 30 days. */
const addressTotal = computed(() => {
  let n = 0
  for (const v of cityAddressTotals.value.values()) n += v
  return n
})
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
const sigAvg = computed(() => rollingMean(overviewDaily.value.sigsPerDay, 7))
const knockAvg = computed(() => rollingMean(overviewDaily.value.knocksPerDay, 7))

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

// ---------------------------------------------------------------- areas

/** Every area that has knocks, busiest first. A DROPDOWN since 2026-07-26
 * (user call: "rather than have them be bubbles you have to click, I'd rather
 * it be a drop down box") — the chip row grew a line every time the campaign
 * reached a new village, and a picker that reflows the page under your thumb
 * is worse than a list that opens over it. Each row carries its knock count,
 * which the chips had nowhere to put. */
const areaNames = computed(() => {
  const counts = new Map<string, number>()
  for (const k of knocks.value) counts.set(k.city, (counts.get(k.city) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
})

/** Reka refuses an empty-string option value, so "everything" needs a
 * sentinel of its own rather than reusing the empty focus. */
const ALL_AREAS = '__all'
const areaOptions = computed(() => [
  { value: ALL_AREAS, label: 'All areas' },
  ...areaNames.value.map(([name, n]) => ({ value: name, label: `${name} (${fmtCount(n)} knocks)` })),
])
const areaPick = computed({
  get: () => areaFocus.value || ALL_AREAS,
  set: (v: string) => (areaFocus.value = v === ALL_AREAS ? '' : v),
})

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

const signRateByCity = computed(() => signRateBy((k) => k.city))
const answerRateByCity = computed(() =>
  rateBy((k) => k.city, (k) => k.conversed, (k) => k.interacted, 'interactions', 50),
)
const coverageByCity = computed<BarItem[]>(() => {
  const knocked = new Map<string, Set<string>>()
  for (const k of filtered.value) {
    if (!knocked.has(k.city)) knocked.set(k.city, new Set())
    knocked.get(k.city)!.add(k.household)
  }
  return [...knocked.entries()]
    .map(([city, doors]) => {
      const total = cityAddressTotals.value.get(city) ?? doors.size
      return {
        label: city,
        value: doors.size / Math.max(1, total),
        detail: `${fmtCount(doors.size)} of ${fmtCount(total)} doors on file`,
        note: `${fmtCount(Math.max(0, total - doors.size))} still to knock`,
      }
    })
    .filter((i) => (cityAddressTotals.value.get(i.label) ?? 0) >= 50)
    .sort((a, b) => b.value - a.value)
})

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

/** Visits, not "attempts" (2026-07-26, user call: "signed by attempt, attempt
 * four plus: does that mean BY attempt four we get 54%, or ON the fourth
 * attempt we have a 54% chance?").
 *
 * It is the second one, and it always was: each bar counts only the knocks
 * that WERE that visit, so the bars are independent rather than cumulative.
 * The old "Attempt 4+" said nothing either way. "4th visit or later" plus a
 * spelled-out sentence in the tooltip says which one it is without anybody
 * having to guess. */
const VISIT_LABELS = ['', '1st visit', '2nd visit', '3rd visit', '4th visit or later']
const visitPhrase = (a: number) =>
  a === 4 ? 'on a 4th or later visit' : `on a door's ${['', '1st', '2nd', '3rd'][a]} visit`

function rateByVisit(
  num: (k: Knock) => boolean,
  den: (k: Knock) => boolean,
  unit: string,
  verb: string,
): BarItem[] {
  const per = new Map<number, { n: number; s: number }>()
  for (const k of filtered.value) {
    if (!den(k)) continue
    const a = Math.min(k.attempt, 4)
    const e = per.get(a) ?? { n: 0, s: 0 }
    e.n++
    if (num(k)) e.s++
    per.set(a, e)
  }
  return [...per.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, e]) => e.n >= 20)
    .map(([a, e]) => {
      const item = rateItem(VISIT_LABELS[a], e.s, e.n, `${unit} ${visitPhrase(a)}`)
      item.detail = `${fmtCount(e.s)} of ${fmtCount(e.n)} ${unit} ${visitPhrase(a)} ${verb}`
      return item
    })
}

const answerByVisit = computed(() =>
  rateByVisit((k) => k.conversed, (k) => k.interacted, 'interactions', 'were answered'),
)
const signByVisit = computed(() =>
  rateByVisit((k) => k.signed, (k) => k.conversed, 'conversations', 'ended in a signature'),
)

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
const heat = computed(() => {
  const n: number[][] = WEEKDAYS.map(() => HOURS.map(() => 0))
  const s: number[][] = WEEKDAYS.map(() => HOURS.map(() => 0))
  for (const k of filtered.value) {
    if (!k.interacted) continue // a skipped door was never tried at any hour
    const c = HOURS.indexOf(Math.min(20, Math.max(10, k.hour)))
    if (c < 0) continue
    n[k.weekday][c]++
    if (k.conversed) s[k.weekday][c]++
  }
  const values = n.map((row, r) => row.map((cnt, c) => (cnt >= 15 ? s[r][c] / cnt : null)))
  return { values, counts: n }
})

/** Still three stages under the two-tier model: the funnel counts DOORS, and
 * at door level "tried" vs "knocked" differ only by doors that were only ever
 * skipped — a step that never loses anybody teaches nothing. The knock-level
 * ladder (interactions → conversations) is the rate tiles' job. */
const funnel = computed<BarItem[]>(() => {
  const f = filtered.value
  const doors = new Set(f.map((k) => k.household)).size
  const talkedDoors = new Set(f.filter((k) => k.conversed).map((k) => k.household)).size
  const signedDoors = new Set(f.filter((k) => k.signed).map((k) => k.household)).size
  const ramp = ordinalRamp(3, palette.dark.value)
  const steps = [
    { label: 'Knocked', value: doors, detail: 'doors visited at least once', of: '' },
    {
      label: 'Talked to somebody',
      value: talkedDoors,
      detail: 'doors where anyone came out',
      of: 'of the doors knocked',
    },
    {
      label: 'Got a signature',
      value: signedDoors,
      detail: 'doors where somebody signed',
      of: 'of the doors that answered',
    },
  ]
  return steps.map(({ of, ...st }, i) => ({
    ...st,
    color: ramp[i],
    note: of ? `${fmtPct(st.value / Math.max(1, steps[i - 1].value), 1)} ${of}` : undefined,
  }))
})

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
const focusSigAvg = computed(() => rollingMean(focusDaily.value.sigsPerDay, 7))
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
  const total =
    f?.kind === 'turf'
      ? turfAddressTotals.value.get(f.label)
      : f?.kind === 'area'
        ? cityAddressTotals.value.get(f.label)
        : undefined
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
    case 'area':
      return [
        { title: 'Turf here', items: rankBy(sub, (k) => k.turf, NO_TURF), open: openTurf },
        { title: 'Canvassers here', items: rankPeople(sub), open: openPerson },
      ]
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
          <div class="chip-row" role="group" aria-label="Time window">
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
          <span class="scope-right muted">
            {{ fmtCount(scopeCount) }} knocks<span v-if="showTapHint">, tap once to read, again to open</span>
          </span>
          <!-- Its own line (flex-basis 100%): the pair needs ~340px, which is
               most of a phone, so letting it flow beside the chips would only
               wrap it there anyway, mid row. -->
          <div v-if="rangeKey === 'custom'" class="custom-range">
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

        <!-- The Areas tab's picker lives IN the tab, not above the page. -->
        <div v-if="tab === 'areas'" class="area-pick" data-help="analytics-areachips">
          <AppSelect v-model="areaPick" :options="areaOptions" small aria-label="Area" />
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

        <!-- ============================== Areas (compare) -->
        <template v-else-if="tab === 'areas'">
          <div class="two-col">
            <ChartCard
              title="Sign rate by area"
              data-help="areas-rate"
              :subtitle="signRateSubtitle"
              :columns="['Area', 'Sign rate', 'Detail']"
              :rows="rateRows(signRateByCity)"
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
                :items="signRateByCity"
                :color="cat[0]"
                percent
                selectable
                measure="Sign rate"
                :ref-value="overallRates.sign"
                ref-label="campaign average"
                :max="pctMax(signRateByCity, overallRates.sign)"
                @select="openArea"
              />
            </ChartCard>

            <ChartCard
              title="Answer rate by area"
              subtitle="share of interactions somebody answered"
              :columns="['Area', 'Answer rate', 'Detail']"
              :rows="rateRows(answerRateByCity)"
            >
              <BarChart
                :items="answerRateByCity"
                :color="cat[0]"
                percent
                selectable
                measure="Answer rate"
                :ref-value="overallRates.answer"
                ref-label="campaign average"
                :max="pctMax(answerRateByCity, overallRates.answer)"
                @select="openArea"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Door coverage by area"
            data-help="areas-coverage"
            subtitle="share of the doors on file knocked at least once"
            :columns="['Area', 'Coverage', 'Detail']"
            :rows="rateRows(coverageByCity)"
          >
            <BarChart
              :items="coverageByCity"
              :color="cat[0]"
              percent
              :max="1"
              selectable
              measure="Door coverage"
              @select="openArea"
            />
          </ChartCard>
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

        <!-- ============================== Odds -->
        <template v-else-if="tab === 'odds'">
          <div class="two-col">
            <ChartCard
              title="Answer rate by visit"
              data-help="odds-attempts"
              subtitle="counts that visit only, not a running total"
              :columns="['Visit', 'Answer rate', 'Detail']"
              :rows="rateRows(answerByVisit)"
            >
              <BarChart
                :items="answerByVisit"
                :color="cat[0]"
                percent
                measure="Answer rate on that visit"
                :ref-value="overallRates.answer"
                ref-label="all visits"
                :max="pctMax(answerByVisit, overallRates.answer)"
              />
            </ChartCard>

            <ChartCard
              title="Sign rate by visit"
              subtitle="counts that visit only, not a running total"
              :columns="['Visit', 'Sign rate', 'Detail']"
              :rows="rateRows(signByVisit)"
            >
              <BarChart
                :items="signByVisit"
                :color="cat[0]"
                percent
                measure="Sign rate on that visit"
                :ref-value="overallRates.sign"
                ref-label="all visits"
                :max="pctMax(signByVisit, overallRates.sign)"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="When doors answer"
            data-help="odds-heatmap"
            subtitle="share of interactions answered, by day and hour"
            :columns="['Weekday', ...HOURS.map((h) => `${h}:00`)]"
            :rows="
              WEEKDAYS.map((w, r) => [
                w,
                ...heat.values[r].map((v) => (v == null ? 'too few' : fmtPct(v))),
              ])
            "
          >
            <Heatmap
              :row-labels="WEEKDAYS"
              :col-labels="HOURS.map((h) => (h <= 12 ? `${h}a` : `${h - 12}p`))"
              :values="heat.values"
              :counts="heat.counts"
              unit="interactions"
              :dark="palette.dark.value"
            />
          </ChartCard>

          <ChartCard
            title="How far doors get"
            data-help="odds-funnel"
            subtitle="doors counted once each"
            :columns="['Stage', 'Doors', 'What it means']"
            :rows="funnel.map((i) => [i.label, i.value, i.note ?? i.detail ?? ''])"
          >
            <BarChart :items="funnel" :color="cat[0]" measure="Doors" />
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

/* The Areas picker. Capped so it doesn't stretch to the full column width on
   a desktop, where a select as wide as a chart reads as a page control
   rather than this tab's scope. */
.area-pick {
  max-width: 22rem;
}

/* "Per interaction / Per door knocked", inside each sign-rate card: the knob
   belongs on the chart it changes, not in a page-level filter bar. */
.base-row {
  margin-bottom: 0.5rem;
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
