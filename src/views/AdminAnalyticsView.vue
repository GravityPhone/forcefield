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
import { supabase } from '@/lib/supabase'
import { OUTCOMES } from '@/lib/outcomes'
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
  answered: boolean
  conversation: boolean
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

    const [rows, addrs, profs, turfs] = await Promise.all([
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
    ])

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

const ANSWERED = new Set<KnockOutcome>(['signed', 'didnt_sign', 'maybe', 'hostile'])
const CONVERSATION = new Set<KnockOutcome>(['signed', 'didnt_sign', 'maybe'])

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
        answered: ANSWERED.has(r.outcome),
        conversation: CONVERSATION.has(r.outcome),
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

const rangeDays = ref<number | null>(30) // days back; null = whole campaign
const RANGE_CHIPS: { value: number | null; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
  { value: null, label: 'All time' },
]

const maxTs = computed(() => (knocks.value.length ? knocks.value[knocks.value.length - 1].ts : 0))
const filtered = computed(() => {
  const cutoff = rangeDays.value == null ? -Infinity : maxTs.value - rangeDays.value * 86_400_000
  return knocks.value.filter((k) => k.ts >= cutoff)
})

// ---------------------------------------------------------------- tabs

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'areas', label: 'Areas' },
  { id: 'turfs', label: 'Turfs' },
  { id: 'squads', label: 'Squads' },
  { id: 'odds', label: 'Odds' },
  { id: 'canvassers', label: 'Canvassers' },
] as const
type TabId = (typeof TABS)[number]['id']
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
      return turfFocus.value ? { kind: 'turf', label: turfFocus.value, all: 'All turfs' } : null
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
  () => !focus.value && tab.value !== 'overview' && tab.value !== 'odds',
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

function mixFor(sub: Knock[]): BarItem[] {
  const counts = new Map<KnockOutcome, number>()
  for (const k of sub) counts.set(k.outcome, (counts.get(k.outcome) ?? 0) + 1)
  return OUTCOMES.map((o) => ({
    label: o.label,
    value: counts.get(o.value) ?? 0,
    color: o.hex,
    detail: `${fmtPct((counts.get(o.value) ?? 0) / Math.max(1, sub.length), 1)} of all knocks`,
  }))
}

const fmtAvg = (v: number | null): string => (v == null ? '—' : v.toFixed(1))

interface Tile {
  label: string
  value: string
  hint?: string
}

// ---------------------------------------------------------------- overview

const kpis = computed<Tile[]>(() => {
  const f = filtered.value
  const doors = new Set(f.map((k) => k.household)).size
  const sigs = f.filter((k) => k.signed).length
  const answered = f.filter((k) => k.answered).length
  const conv = f.filter((k) => k.conversation).length
  const people = new Set(f.map((k) => k.canvasser)).size
  return [
    { label: 'Signatures', value: fmtCount(sigs) },
    { label: 'Doors knocked', value: fmtCount(doors) },
    { label: 'Total knocks', value: fmtCount(f.length) },
    { label: 'Answer rate', value: f.length ? fmtPct(answered / f.length, 1) : '—', hint: 'answered ÷ knocks' },
    { label: 'Close rate', value: conv ? fmtPct(sigs / conv, 1) : '—', hint: 'signed ÷ conversations' },
    { label: 'Canvassers active', value: fmtCount(people) },
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
  return OUTCOMES.map((o) => {
    const vals = new Array(axis.length).fill(0)
    for (const k of filtered.value) {
      if (k.outcome !== o.value) continue
      const i = idx.get(k.day)
      if (i != null) vals[i]++
    }
    return { name: o.label, color: o.hex, values: vals }
  })
})

const outcomeMix = computed(() => mixFor(filtered.value))

// ---------------------------------------------------------------- areas

/** Every area that has knocks, busiest first — the Areas tab's chip picker. */
const areaNames = computed(() => {
  const counts = new Map<string, number>()
  for (const k of knocks.value) counts.set(k.city, (counts.get(k.city) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
})

function rateBy(
  key: (k: Knock) => string,
  num: (k: Knock) => boolean,
  den: (k: Knock) => boolean,
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
    .map(([label, e]) => {
      const w = wilson(e.s, e.n)
      return { label, value: w.p, lo: w.lo, hi: w.hi, detail: `${e.s} of ${e.n} · 95% CI ${fmtPct(w.lo)}–${fmtPct(w.hi)}` }
    })
    .sort((a, b) => b.value - a.value)
}

const signRateByCity = computed(() => rateBy((k) => k.city, (k) => k.signed, (k) => k.conversation))
const answerRateByCity = computed(() => rateBy((k) => k.city, (k) => k.answered, () => true, 50))
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
        detail: `${fmtCount(doors.size)} of ${fmtCount(total)} doors`,
      }
    })
    .filter((i) => (cityAddressTotals.value.get(i.label) ?? 0) >= 50)
    .sort((a, b) => b.value - a.value)
})

const rateRows = (items: BarItem[]) => items.map((i) => [i.label, fmtPct(i.value, 1), i.detail ?? ''])

/** Campaign-wide rates — the dashed "avg" markers on rate charts. */
const overallRates = computed(() => {
  const f = filtered.value
  const conv = f.filter((k) => k.conversation).length
  const sigs = f.filter((k) => k.signed).length
  const answered = f.filter((k) => k.answered).length
  return { sign: conv ? sigs / conv : 0, answer: f.length ? answered / f.length : 0 }
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
  conv: number
  sigs: number
  answered: number
  days: Set<string>
  closeRate: number
}

function statsBy(key: (k: Knock) => string): GroupStats[] {
  const per = new Map<string, Omit<GroupStats, 'label' | 'closeRate'>>()
  for (const k of filtered.value) {
    let e = per.get(key(k))
    if (!e) {
      e = { knocks: 0, doors: new Set(), conv: 0, sigs: 0, answered: 0, days: new Set() }
      per.set(key(k), e)
    }
    e.knocks++
    e.doors.add(k.household)
    e.days.add(k.day)
    if (k.answered) e.answered++
    if (k.conversation) e.conv++
    if (k.signed) e.sigs++
  }
  return [...per.entries()]
    .map(([label, e]) => ({ label, ...e, closeRate: e.conv ? e.sigs / e.conv : 0 }))
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
    detail: `${fmtCount(t.knocks)} knocks · close rate ${fmtPct(t.closeRate, 1)}`,
  })),
)
const signRateByTurf = computed(() =>
  rateBy((k) => k.turf, (k) => k.signed, (k) => k.conversation && k.turf !== NO_TURF, 10),
)
const coverageByTurf = computed<BarItem[]>(() =>
  chartableTurfs.value
    .filter((t) => (turfAddressTotals.value.get(t.label) ?? 0) > 0)
    .map((t) => {
      const total = turfAddressTotals.value.get(t.label)!
      return {
        label: t.label,
        value: Math.min(1, t.doors.size / total),
        detail: `${fmtCount(t.doors.size)} of ${fmtCount(total)} doors`,
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
    e.conv,
    e.sigs,
    fmtPct(e.closeRate, 1),
    fmtPct(e.knocks ? e.answered / e.knocks : 0, 1),
  ])
const GROUP_COLUMNS = ['', 'Days out', 'Knocks', 'Doors', 'Conversations', 'Signatures', 'Close rate', 'Answer rate']

const signaturesBySquad = computed<BarItem[]>(() =>
  chartableSquads.value.map((s) => ({
    label: s.label,
    value: s.sigs,
    detail: `${s.days.size} day${s.days.size === 1 ? '' : 's'} out · ${fmtCount(s.knocks)} knocks`,
  })),
)
const signRateBySquad = computed(() =>
  rateBy((k) => k.squad, (k) => k.signed, (k) => k.conversation && k.squad !== NO_SQUAD, 10),
)

// ---------------------------------------------------------------- odds

function rateByAttempt(num: (k: Knock) => boolean, den: (k: Knock) => boolean): BarItem[] {
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
      const w = wilson(e.s, e.n)
      return {
        label: a === 4 ? 'Attempt 4+' : `Attempt ${a}`,
        value: w.p,
        lo: w.lo,
        hi: w.hi,
        detail: `${e.s} of ${e.n} · 95% CI ${fmtPct(w.lo)}–${fmtPct(w.hi)}`,
      }
    })
}

const answerByAttempt = computed(() => rateByAttempt((k) => k.answered, () => true))
const signByAttempt = computed(() => rateByAttempt((k) => k.signed, (k) => k.conversation))

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
const heat = computed(() => {
  const n: number[][] = WEEKDAYS.map(() => HOURS.map(() => 0))
  const s: number[][] = WEEKDAYS.map(() => HOURS.map(() => 0))
  for (const k of filtered.value) {
    const c = HOURS.indexOf(Math.min(20, Math.max(10, k.hour)))
    if (c < 0) continue
    n[k.weekday][c]++
    if (k.answered) s[k.weekday][c]++
  }
  const values = n.map((row, r) => row.map((cnt, c) => (cnt >= 15 ? s[r][c] / cnt : null)))
  return { values, counts: n }
})

const funnel = computed<BarItem[]>(() => {
  const f = filtered.value
  const doors = new Set(f.map((k) => k.household)).size
  const answeredDoors = new Set(f.filter((k) => k.answered).map((k) => k.household)).size
  const convDoors = new Set(f.filter((k) => k.conversation).map((k) => k.household)).size
  const signedDoors = new Set(f.filter((k) => k.signed).map((k) => k.household)).size
  const ramp = ordinalRamp(4, palette.dark.value)
  const steps = [
    { label: 'Doors knocked', value: doors },
    { label: 'Door answered', value: answeredDoors },
    { label: 'Conversation', value: convDoors },
    { label: 'Signed', value: signedDoors },
  ]
  return steps.map((st, i) => ({
    ...st,
    color: ramp[i],
    detail: i === 0 ? 'unique doors' : `${fmtPct(st.value / Math.max(1, steps[i - 1].value), 1)} of previous step`,
  }))
})

// ---------------------------------------------------------------- canvassers

const canvasserStats = computed(() => {
  const per = new Map<string, { knocks: number; conv: number; sigs: number; answered: number }>()
  for (const k of filtered.value) {
    const e = per.get(k.canvasser) ?? { knocks: 0, conv: 0, sigs: 0, answered: 0 }
    e.knocks++
    if (k.answered) e.answered++
    if (k.conversation) e.conv++
    if (k.signed) e.sigs++
    per.set(k.canvasser, e)
  }
  return [...per.entries()]
    .map(([id, e]) => ({
      id,
      name: canvasserNames.value.get(id) ?? 'Unknown',
      ...e,
      closeRate: e.conv ? e.sigs / e.conv : 0,
    }))
    .sort((a, b) => b.sigs - a.sigs)
})

const scatterPoints = computed<ScatterPoint[]>(() =>
  canvasserStats.value
    .filter((c) => c.conv >= 20)
    .map((c) => ({ x: c.knocks, y: c.closeRate, label: c.name, id: c.id })),
)
const scatterFit = computed(() => linearRegression(scatterPoints.value.map((p) => ({ x: p.x, y: p.y }))))

/** The signature chart can show the whole roster, not just a leaderboard
 * cut — bars simply grow with the list. Top 12 stays as an option for
 * campaigns with more canvassers than screen. */
const earnersScope = ref<'12' | 'all'>('all')
const signatureEarners = computed<BarItem[]>(() =>
  (earnersScope.value === 'all' ? canvasserStats.value : canvasserStats.value.slice(0, 12)).map(
    (c) => ({
      id: c.id,
      label: c.name,
      value: c.sigs,
      detail: `${fmtCount(c.knocks)} knocks · close rate ${fmtPct(c.closeRate, 1)}`,
    }),
  ),
)

const canvasserRows = computed(() =>
  canvasserStats.value.map((c) => [
    c.name,
    c.knocks,
    c.conv,
    c.sigs,
    fmtPct(c.closeRate, 1),
    fmtPct(c.knocks ? c.answered / c.knocks : 0, 1),
  ]),
)
const CANVASSER_COLUMNS = ['Canvasser', 'Knocks', 'Conversations', 'Signatures', 'Close rate', 'Answer rate']

// ---------------------------------------------------------------- focus panel
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
  const answered = sub.filter((k) => k.answered).length
  const conv = sub.filter((k) => k.conversation).length
  const days = new Set(sub.map((k) => k.day)).size
  const people = new Set(sub.map((k) => k.canvasser)).size
  const tiles: Tile[] = [
    { label: 'Signatures', value: fmtCount(sigs) },
    { label: 'Doors knocked', value: fmtCount(doors) },
    { label: 'Total knocks', value: fmtCount(sub.length) },
    { label: 'Answer rate', value: sub.length ? fmtPct(answered / sub.length, 1) : '—', hint: 'answered ÷ knocks' },
    { label: 'Close rate', value: conv ? fmtPct(sigs / conv, 1) : '—', hint: 'signed ÷ conversations' },
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
      hint: `${fmtCount(doors)} of ${fmtCount(total)} doors`,
    })
  }
  return tiles
})

function rankBy(sub: Knock[], key: (k: Knock) => string, exclude?: string): BarItem[] {
  const per = new Map<string, { knocks: number; sigs: number; conv: number }>()
  for (const k of sub) {
    const label = key(k)
    if (label === exclude) continue
    let e = per.get(label)
    if (!e) {
      e = { knocks: 0, sigs: 0, conv: 0 }
      per.set(label, e)
    }
    e.knocks++
    if (k.signed) e.sigs++
    if (k.conversation) e.conv++
  }
  return [...per.entries()]
    .map(([label, e]) => ({
      label,
      value: e.sigs,
      detail: `${fmtCount(e.knocks)} knocks · close rate ${fmtPct(e.conv ? e.sigs / e.conv : 0, 1)}`,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
}

function rankPeople(sub: Knock[]): BarItem[] {
  const per = new Map<string, { knocks: number; sigs: number; conv: number }>()
  for (const k of sub) {
    let e = per.get(k.canvasser)
    if (!e) {
      e = { knocks: 0, sigs: 0, conv: 0 }
      per.set(k.canvasser, e)
    }
    e.knocks++
    if (k.signed) e.sigs++
    if (k.conversation) e.conv++
  }
  return [...per.entries()]
    .map(([id, e]) => ({
      id,
      label: canvasserNames.value.get(id) ?? 'Unknown',
      value: e.sigs,
      detail: `${fmtCount(e.knocks)} knocks · close rate ${fmtPct(e.conv ? e.sigs / e.conv : 0, 1)}`,
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
        { title: 'Turfs here', items: rankBy(sub, (k) => k.turf, NO_TURF), open: openTurf },
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
      <div class="tabs" role="tablist">
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
        <div class="scope">
          <template v-if="focus">
            <button class="chip back-chip" type="button" @click="clearFocus">
              ‹ {{ focus.all }}
            </button>
            <span class="focus-name">{{ focus.label }}</span>
          </template>
          <div class="chip-row" role="group" aria-label="Time window">
            <button
              v-for="r in RANGE_CHIPS"
              :key="r.label"
              type="button"
              class="chip"
              :class="{ on: rangeDays === r.value }"
              @click="rangeDays = r.value"
            >
              {{ r.label }}
            </button>
          </div>
          <span class="scope-right muted">
            {{ fmtCount(scopeCount) }} knocks<span v-if="showTapHint"> · tap to explore</span>
          </span>
        </div>

        <!-- The Areas tab's picker lives IN the tab, not above the page. -->
        <div v-if="tab === 'areas'" class="chip-row" role="group" aria-label="Area">
          <button type="button" class="chip" :class="{ on: !areaFocus }" @click="areaFocus = ''">
            All areas
          </button>
          <button
            v-for="a in areaNames"
            :key="a"
            type="button"
            class="chip"
            :class="{ on: areaFocus === a }"
            @click="areaFocus = a"
          >
            {{ a }}
          </button>
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
            :columns="['Day', 'Signatures', '7-day avg']"
            :rows="focusTrendRows"
          >
            <TimeSeriesChart :labels="focusDaily.axis.map(dayLabel)" :series="focusTrend" />
          </ChartCard>

          <div class="two-col">
            <ChartCard
              v-for="r in focusRanks"
              :key="r.title"
              :title="r.title"
              subtitle="by signatures"
              :columns="[r.title, 'Signatures', 'Detail']"
              :rows="r.items.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="r.items" :color="cat[0]" selectable @select="r.open" />
            </ChartCard>
          </div>

          <ChartCard
            title="Outcome totals"
            :columns="['Outcome', 'Knocks', 'Share']"
            :rows="focusMix.map((i) => [i.label, i.value, i.detail ?? ''])"
          >
            <BarChart :items="focusMix" :color="cat[0]" />
          </ChartCard>
        </template>

        <!-- ============================== Overview -->
        <template v-else-if="tab === 'overview'">
          <div class="tiles">
            <div v-for="k in kpis" :key="k.label" class="tile">
              <span class="tile-label muted">{{ k.label }}</span>
              <span class="tile-value">{{ k.value }}</span>
              <span v-if="k.hint" class="tile-hint muted">{{ k.hint }}</span>
            </div>
          </div>

          <div class="two-col">
            <ChartCard
              title="Signatures per day"
              :columns="['Day', 'Signatures', '7-day avg']"
              :rows="sigRows"
            >
              <TimeSeriesChart :labels="overviewDaily.axis.map(dayLabel)" :series="sigSeries" />
            </ChartCard>

            <ChartCard
              title="Knocks per day"
              :columns="['Day', 'Knocks', '7-day avg']"
              :rows="knockRows"
            >
              <TimeSeriesChart :labels="overviewDaily.axis.map(dayLabel)" :series="knockSeries" />
            </ChartCard>
          </div>

          <div class="two-col">
            <ChartCard
              title="What happened at doors"
              subtitle="per day"
              :columns="['Day', ...OUTCOMES.map((o) => o.label)]"
              :rows="overviewDaily.axis.map((d, i) => [d, ...outcomeStack.map((s) => s.values[i])])"
            >
              <StackedBarChart :labels="overviewDaily.axis.map(dayLabel)" :series="outcomeStack" :height="230" />
            </ChartCard>

            <ChartCard
              title="Outcome totals"
              :columns="['Outcome', 'Knocks', 'Share']"
              :rows="outcomeMix.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="outcomeMix" :color="cat[0]" />
            </ChartCard>
          </div>
        </template>

        <!-- ============================== Areas (compare) -->
        <template v-else-if="tab === 'areas'">
          <div class="two-col">
            <ChartCard
              title="Sign rate by area"
              subtitle="signed ÷ conversations"
              :columns="['Area', 'Sign rate', 'Detail']"
              :rows="rateRows(signRateByCity)"
            >
              <BarChart
                :items="signRateByCity"
                :color="cat[0]"
                percent
                selectable
                :ref-value="overallRates.sign"
                :max="pctMax(signRateByCity, overallRates.sign)"
                @select="openArea"
              />
            </ChartCard>

            <ChartCard
              title="Answer rate by area"
              subtitle="answered ÷ knocks"
              :columns="['Area', 'Answer rate', 'Detail']"
              :rows="rateRows(answerRateByCity)"
            >
              <BarChart
                :items="answerRateByCity"
                :color="cat[0]"
                percent
                selectable
                :ref-value="overallRates.answer"
                :max="pctMax(answerRateByCity, overallRates.answer)"
                @select="openArea"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Door coverage by area"
            subtitle="knocked ÷ on file"
            :columns="['Area', 'Coverage', 'Detail']"
            :rows="rateRows(coverageByCity)"
          >
            <BarChart :items="coverageByCity" :color="cat[0]" percent :max="1" selectable @select="openArea" />
          </ChartCard>
        </template>

        <!-- ============================== Turfs (compare) -->
        <template v-else-if="tab === 'turfs'">
          <div class="two-col">
            <ChartCard
              title="Signatures by turf"
              :columns="['Turf', 'Signatures', 'Detail']"
              :rows="signaturesByTurf.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="signaturesByTurf" :color="cat[0]" selectable @select="openTurf" />
            </ChartCard>

            <ChartCard
              title="Sign rate by turf"
              subtitle="signed ÷ conversations"
              :columns="['Turf', 'Sign rate', 'Detail']"
              :rows="rateRows(signRateByTurf)"
            >
              <BarChart
                :items="signRateByTurf"
                :color="cat[0]"
                percent
                selectable
                :ref-value="overallRates.sign"
                :max="pctMax(signRateByTurf, overallRates.sign)"
                @select="openTurf"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Turf coverage"
            subtitle="knocked ÷ doors in turf"
            :columns="['Turf', 'Coverage', 'Detail']"
            :rows="rateRows(coverageByTurf)"
          >
            <BarChart :items="coverageByTurf" :color="cat[0]" percent :max="1" selectable @select="openTurf" />
          </ChartCard>

          <ChartCard
            title="All turf, by the numbers"
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
              :columns="['Squad', 'Signatures', 'Detail']"
              :rows="signaturesBySquad.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="signaturesBySquad" :color="cat[0]" selectable @select="openSquad" />
            </ChartCard>

            <ChartCard
              title="Sign rate by squad"
              subtitle="signed ÷ conversations"
              :columns="['Squad', 'Sign rate', 'Detail']"
              :rows="rateRows(signRateBySquad)"
            >
              <BarChart
                :items="signRateBySquad"
                :color="cat[0]"
                percent
                selectable
                :ref-value="overallRates.sign"
                :max="pctMax(signRateBySquad, overallRates.sign)"
                @select="openSquad"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="All squads, by the numbers"
            :columns="['Squad', ...GROUP_COLUMNS.slice(1)]"
            :rows="groupRows(squadStats)"
            table-only
            selectable-rows
            @select-row="openSquadRow"
          />
        </template>

        <!-- ============================== Odds -->
        <template v-else-if="tab === 'odds'">
          <div class="two-col">
            <ChartCard
              title="Answers by attempt"
              subtitle="answered ÷ knocks"
              :columns="['Attempt', 'Answer rate', 'Detail']"
              :rows="rateRows(answerByAttempt)"
            >
              <BarChart
                :items="answerByAttempt"
                :color="cat[0]"
                percent
                :ref-value="overallRates.answer"
                :max="pctMax(answerByAttempt, overallRates.answer)"
              />
            </ChartCard>

            <ChartCard
              title="Signs by attempt"
              subtitle="signed ÷ conversations"
              :columns="['Attempt', 'Sign rate', 'Detail']"
              :rows="rateRows(signByAttempt)"
            >
              <BarChart
                :items="signByAttempt"
                :color="cat[0]"
                percent
                :ref-value="overallRates.sign"
                :max="pctMax(signByAttempt, overallRates.sign)"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="When doors answer"
            subtitle="answer rate"
            :columns="['Weekday', ...HOURS.map((h) => `${h}:00`)]"
            :rows="WEEKDAYS.map((w, r) => [w, ...heat.values[r].map((v) => (v == null ? '—' : fmtPct(v)))])"
          >
            <Heatmap
              :row-labels="WEEKDAYS"
              :col-labels="HOURS.map((h) => (h <= 12 ? `${h}a` : `${h - 12}p`))"
              :values="heat.values"
              :counts="heat.counts"
              :dark="palette.dark.value"
            />
          </ChartCard>

          <ChartCard
            title="The funnel"
            subtitle="unique doors"
            :columns="['Stage', 'Doors', 'Conversion']"
            :rows="funnel.map((i) => [i.label, i.value, i.detail ?? ''])"
          >
            <BarChart :items="funnel" :color="cat[0]" />
          </ChartCard>
        </template>

        <!-- ============================== Canvassers (compare) -->
        <template v-else>
          <div class="two-col">
            <ChartCard
              title="Volume vs. close rate"
              subtitle="one dot per canvasser"
              :columns="CANVASSER_COLUMNS"
              :rows="canvasserRows"
            >
              <ScatterChart
                :points="scatterPoints"
                :color="cat[0]"
                :fit="scatterFit"
                x-label="knocks"
                y-label="close rate"
                y-percent
                selectable
                @select="openPerson"
              />
            </ChartCard>

            <ChartCard
              title="Signature earners"
              :columns="['Canvasser', 'Signatures']"
              :rows="signatureEarners.map((i) => [i.label, i.value])"
            >
              <div class="chip-row earners">
                <button
                  type="button"
                  class="chip"
                  :class="{ on: earnersScope === 'all' }"
                  @click="earnersScope = 'all'"
                >
                  Everyone ({{ canvasserStats.length }})
                </button>
                <button
                  type="button"
                  class="chip"
                  :class="{ on: earnersScope === '12' }"
                  @click="earnersScope = '12'"
                >
                  Top 12
                </button>
              </div>
              <BarChart :items="signatureEarners" :color="cat[0]" selectable @select="openPerson" />
            </ChartCard>
          </div>

          <ChartCard
            title="Everyone, by the numbers"
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

.tabs {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.9rem;
  padding: 0.45rem 0.7rem;
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

/* Everyone / Top 12 chips inside the signature-earners card. */
.earners {
  justify-content: flex-end;
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
