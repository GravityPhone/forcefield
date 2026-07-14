<script setup lang="ts">
// Campaign Analytics — the campaign managers' numbers room. Loads the whole
// knock history once (paged, client-side), then every chart and probability
// table runs instantly in the browser: Netlify only ever serves static
// files, so ALL statistics (Wilson CIs, OLS) are computed client-side in
// src/lib/stats.ts. (A logistic-regression "Predictor" tab existed until
// 2026-07-14 — removed as more than managers needed; stats.ts keeps the
// machinery if it ever comes back.)
import { computed, onMounted, ref, shallowRef } from 'vue'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ChartCard from '@/components/charts/ChartCard.vue'
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue'
import StackedBarChart from '@/components/charts/StackedBarChart.vue'
import BarChart from '@/components/charts/BarChart.vue'
import Heatmap from '@/components/charts/Heatmap.vue'
import ScatterChart from '@/components/charts/ScatterChart.vue'
import type { BarItem } from '@/components/charts/BarChart.vue'
import { supabase } from '@/lib/supabase'
import { OUTCOMES, OUTCOME_LABELS } from '@/lib/outcomes'
import { useChartPalette, ordinalRamp, fmtPct, fmtCount } from '@/lib/chartTheme'
import { wilson, linearRegression, rollingMean } from '@/lib/stats'
import type { KnockOutcome } from '@/types'

const palette = useChartPalette()
const cat = computed(() => palette.categorical.value)

// ---------------------------------------------------------------- loading

interface KnockRow {
  outcome: KnockOutcome
  occurred_at: string
  household_id: string | null
  canvasser_id: string
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
  attempt: number
  priorNotHomes: number
  experience: number // canvasser's knocks before this one
  answered: boolean
  conversation: boolean
  signed: boolean
}

const loading = ref(true)
const loadNote = ref('Counting knocks…')
const loadError = ref('')
const knocks = shallowRef<Knock[]>([])
const cityAddressTotals = shallowRef<Map<string, number>>(new Map())
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

    const [rows, addrs, profs] = await Promise.all([
      fetchAllPages<KnockRow>(
        'knock_logs',
        'outcome, occurred_at, household_id, canvasser_id',
        knockCount ?? 0,
        (n) => (loadNote.value = `Loading knocks… ${fmtCount(n)} / ${fmtCount(knockCount ?? 0)}`),
      ),
      fetchAllPages<{ id: string; city: string }>('addresses', 'id, city', addrCount ?? 0, () => {}),
      supabase
        .from('profiles')
        .select('id, username, display_name')
        .then(({ data, error }) => {
          if (error) throw new Error(error.message)
          return data ?? []
        }),
    ])

    const cityOf = new Map(addrs.map((a) => [a.id, a.city]))
    const totals = new Map<string, number>()
    for (const a of addrs) totals.set(a.city, (totals.get(a.city) ?? 0) + 1)
    cityAddressTotals.value = totals
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

// ---------------------------------------------------------------- filters

const rangeDays = ref<number | null>(30) // days back; null = whole campaign
const cityFilter = ref('')

const maxTs = computed(() => (knocks.value.length ? knocks.value[knocks.value.length - 1].ts : 0))
const filtered = computed(() => {
  const cutoff = rangeDays.value == null ? -Infinity : maxTs.value - rangeDays.value * 86_400_000
  return knocks.value.filter((k) => k.ts >= cutoff && (!cityFilter.value || k.city === cityFilter.value))
})

const cityOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const k of knocks.value) counts.set(k.city, (counts.get(k.city) ?? 0) + 1)
  const opts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => ({ value: c, label: c }))
  return [{ value: '', label: 'All areas' }, ...opts]
})

const RANGE_PRESETS = [
  { value: '', label: 'Whole campaign' },
  { value: '30', label: 'Last 30 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '7', label: 'Last 7 days' },
]

// ---------------------------------------------------------------- tabs

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'areas', label: 'Areas' },
  { id: 'probability', label: 'Probability' },
  { id: 'canvassers', label: 'Canvassers' },
] as const
const tab = ref<(typeof TABS)[number]['id']>('overview')

// ---------------------------------------------------------------- overview

const kpis = computed(() => {
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
    { label: 'Answer rate', value: f.length ? fmtPct(answered / f.length, 1) : '—' },
    { label: 'Close rate', value: conv ? fmtPct(sigs / conv, 1) : '—', hint: 'signed ÷ conversations' },
    { label: 'Canvassers active', value: fmtCount(people) },
  ]
})

/** Continuous local-day axis over the filtered window. */
const dayAxis = computed(() => {
  const f = filtered.value
  if (!f.length) return [] as string[]
  const first = new Date(f[0].ts)
  first.setHours(0, 0, 0, 0)
  const last = new Date(f[f.length - 1].ts)
  const days: string[] = []
  for (let t = first.getTime(); t <= last.getTime(); t += 86_400_000) {
    const d = new Date(t)
    days.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  }
  return days
})
const dayLabel = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

const daily = computed(() => {
  const idx = new Map(dayAxis.value.map((d, i) => [d, i]))
  const knocksPerDay = new Array(dayAxis.value.length).fill(0)
  const sigsPerDay = new Array(dayAxis.value.length).fill(0)
  for (const k of filtered.value) {
    const i = idx.get(k.day)
    if (i == null) continue
    knocksPerDay[i]++
    if (k.signed) sigsPerDay[i]++
  }
  return { knocksPerDay, sigsPerDay }
})

const activitySeries = computed(() => [
  { name: 'Knocks', color: cat.value[0], values: daily.value.knocksPerDay as (number | null)[], area: true },
  { name: 'Signatures', color: cat.value[1], values: daily.value.sigsPerDay as (number | null)[], area: true },
  { name: '7-day avg signatures', color: cat.value[2], values: rollingMean(daily.value.sigsPerDay, 7) },
])
const activityRows = computed(() =>
  dayAxis.value.map((d, i) => [d, daily.value.knocksPerDay[i], daily.value.sigsPerDay[i]]),
)

const outcomeStack = computed(() =>
  OUTCOMES.map((o) => {
    const idx = new Map(dayAxis.value.map((d, i) => [d, i]))
    const vals = new Array(dayAxis.value.length).fill(0)
    for (const k of filtered.value) {
      if (k.outcome !== o.value) continue
      const i = idx.get(k.day)
      if (i != null) vals[i]++
    }
    return { name: o.label, color: o.hex, values: vals }
  }),
)

const outcomeMix = computed<BarItem[]>(() => {
  const counts = new Map<KnockOutcome, number>()
  for (const k of filtered.value) counts.set(k.outcome, (counts.get(k.outcome) ?? 0) + 1)
  return OUTCOMES.map((o) => ({
    label: o.label,
    value: counts.get(o.value) ?? 0,
    color: o.hex,
    detail: `${fmtPct((counts.get(o.value) ?? 0) / Math.max(1, filtered.value.length), 1)} of all knocks`,
  }))
})

// ---------------------------------------------------------------- areas

function rateByCity(num: (k: Knock) => boolean, den: (k: Knock) => boolean, minDen = 25): BarItem[] {
  const per = new Map<string, { n: number; s: number }>()
  for (const k of filtered.value) {
    if (!den(k)) continue
    const e = per.get(k.city) ?? { n: 0, s: 0 }
    e.n++
    if (num(k)) e.s++
    per.set(k.city, e)
  }
  return [...per.entries()]
    .filter(([, e]) => e.n >= minDen)
    .map(([city, e]) => {
      const w = wilson(e.s, e.n)
      return { label: city, value: w.p, lo: w.lo, hi: w.hi, detail: `${e.s} of ${e.n} · 95% CI ${fmtPct(w.lo)}–${fmtPct(w.hi)}` }
    })
    .sort((a, b) => b.value - a.value)
}

const signRateByCity = computed(() => rateByCity((k) => k.signed, (k) => k.conversation))
const answerRateByCity = computed(() => rateByCity((k) => k.answered, () => true, 50))
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

// ---------------------------------------------------------------- probability

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

const scatterPoints = computed(() =>
  canvasserStats.value
    .filter((c) => c.conv >= 20)
    .map((c) => ({ x: c.knocks, y: c.closeRate, label: c.name })),
)
const scatterFit = computed(() => linearRegression(scatterPoints.value.map((p) => ({ x: p.x, y: p.y }))))

/** The signature chart can show the whole roster, not just a leaderboard
 * cut — bars simply grow with the list. Top 12 stays as an option for
 * campaigns with more canvassers than screen. */
const earnersScope = ref<'12' | 'all'>('all')
const earnersOptions = computed(() => [
  { value: 'all', label: `Everyone (${canvasserStats.value.length})` },
  { value: '12', label: 'Top 12' },
])
const signatureEarners = computed<BarItem[]>(() =>
  (earnersScope.value === 'all' ? canvasserStats.value : canvasserStats.value.slice(0, 12)).map(
    (c) => ({
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

</script>

<template>
  <AppShell title="Analytics">
    <div v-if="loading" class="card center">
      <p class="muted">{{ loadNote }}</p>
    </div>
    <div v-else-if="loadError" class="card center">
      <p class="error">Couldn't load knock data: {{ loadError }}</p>
    </div>

    <template v-else>
      <!-- one filter row scoping everything below -->
      <div class="filters">
        <AppSelect
          :model-value="rangeDays == null ? '' : String(rangeDays)"
          :options="RANGE_PRESETS"
          aria-label="Date range"
          @update:model-value="rangeDays = $event === '' ? null : Number($event)"
        />
        <AppSelect
          :model-value="cityFilter"
          :options="cityOptions"
          aria-label="Area"
          @update:model-value="cityFilter = String($event)"
        />
        <span class="muted scope-note">{{ fmtCount(filtered.length) }} knocks in view</span>
      </div>

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

      <!-- ============================== Overview -->
      <section v-if="tab === 'overview'" class="stack">
        <div class="tiles">
          <div v-for="k in kpis" :key="k.label" class="tile">
            <span class="tile-label muted">{{ k.label }}</span>
            <span class="tile-value">{{ k.value }}</span>
            <span v-if="k.hint" class="tile-hint muted">{{ k.hint }}</span>
          </div>
        </div>

        <ChartCard
          title="Daily activity"
          subtitle="Knocks and signatures per day, with a 7-day signature average"
          :columns="['Day', 'Knocks', 'Signatures']"
          :rows="activityRows"
        >
          <TimeSeriesChart :labels="dayAxis.map(dayLabel)" :series="activitySeries" />
        </ChartCard>

        <div class="two-col">
          <ChartCard
            title="What happened at doors"
            subtitle="Outcome mix per day"
            :columns="['Day', ...OUTCOMES.map((o) => o.label)]"
            :rows="dayAxis.map((d, i) => [d, ...outcomeStack.map((s) => s.values[i])])"
          >
            <StackedBarChart :labels="dayAxis.map(dayLabel)" :series="outcomeStack" :height="230" />
          </ChartCard>

          <ChartCard
            title="Outcome totals"
            :columns="['Outcome', 'Knocks', 'Share']"
            :rows="outcomeMix.map((i) => [i.label, i.value, i.detail ?? ''])"
          >
            <BarChart :items="outcomeMix" :color="cat[0]" />
          </ChartCard>
        </div>
      </section>

      <!-- ============================== Areas -->
      <section v-else-if="tab === 'areas'" class="stack">
        <div class="two-col">
          <ChartCard
            title="Sign rate by area"
            subtitle="Signatures per conversation, with 95% confidence whiskers"
            :columns="['Area', 'Sign rate', 'Detail']"
            :rows="rateRows(signRateByCity)"
          >
            <BarChart :items="signRateByCity" :color="cat[0]" percent :max="Math.min(1, Math.max(...signRateByCity.map((i) => i.hi ?? i.value), 0.1) * 1.15)" />
          </ChartCard>

          <ChartCard
            title="Answer rate by area"
            subtitle="Share of knocks where someone came to the door"
            :columns="['Area', 'Answer rate', 'Detail']"
            :rows="rateRows(answerRateByCity)"
          >
            <BarChart :items="answerRateByCity" :color="cat[0]" percent :max="Math.min(1, Math.max(...answerRateByCity.map((i) => i.hi ?? i.value), 0.1) * 1.15)" />
          </ChartCard>
        </div>

        <ChartCard
          title="Door coverage by area"
          subtitle="Unique doors knocked as a share of all addresses on file"
          :columns="['Area', 'Coverage', 'Detail']"
          :rows="rateRows(coverageByCity)"
        >
          <BarChart :items="coverageByCity" :color="cat[0]" percent :max="1" />
        </ChartCard>
      </section>

      <!-- ============================== Probability -->
      <section v-else-if="tab === 'probability'" class="stack">
        <div class="two-col">
          <ChartCard
            title="P(door answers) by attempt"
            subtitle="Persistence pays: repeat visits reach the hard-to-catch"
            :columns="['Attempt', 'Answer rate', 'Detail']"
            :rows="rateRows(answerByAttempt)"
          >
            <BarChart :items="answerByAttempt" :color="cat[0]" percent :max="Math.min(1, Math.max(...answerByAttempt.map((i) => i.hi ?? i.value), 0.1) * 1.2)" />
          </ChartCard>

          <ChartCard
            title="P(signs) by attempt"
            subtitle="Sign rate per conversation, by which visit it took"
            :columns="['Attempt', 'Sign rate', 'Detail']"
            :rows="rateRows(signByAttempt)"
          >
            <BarChart :items="signByAttempt" :color="cat[0]" percent :max="Math.min(1, Math.max(...signByAttempt.map((i) => i.hi ?? i.value), 0.1) * 1.2)" />
          </ChartCard>
        </div>

        <ChartCard
          title="When doors answer"
          subtitle="Answer rate by weekday and hour (cells under 15 knocks hidden)"
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
          subtitle="Unique doors at each stage of the pipeline"
          :columns="['Stage', 'Doors', 'Conversion']"
          :rows="funnel.map((i) => [i.label, i.value, i.detail ?? ''])"
        >
          <BarChart :items="funnel" :color="cat[0]" />
        </ChartCard>
      </section>

      <!-- ============================== Canvassers -->
      <section v-else class="stack">
        <div class="two-col">
          <ChartCard
            title="Volume vs. close rate"
            subtitle="Each dot is a canvasser (20+ conversations) — does knocking more trade off against closing?"
            :columns="['Canvasser', 'Knocks', 'Conversations', 'Signatures', 'Close rate', 'Answer rate']"
            :rows="canvasserRows"
          >
            <ScatterChart
              :points="scatterPoints"
              :color="cat[0]"
              :fit="scatterFit"
              x-label="knocks"
              y-label="close rate"
              y-percent
            />
          </ChartCard>

          <ChartCard
            title="Signature earners"
            subtitle="Signatures per canvasser in the current view"
            :columns="['Canvasser', 'Signatures']"
            :rows="signatureEarners.map((i) => [i.label, i.value])"
          >
            <div class="earners-scope">
              <AppSelect
                :model-value="earnersScope"
                :options="earnersOptions"
                aria-label="How many canvassers to show"
                @update:model-value="earnersScope = $event as '12' | 'all'"
              />
            </div>
            <BarChart :items="signatureEarners" :color="cat[0]" />
          </ChartCard>
        </div>
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

.filters {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 0.8rem;
}
.scope-note {
  font-size: 0.82rem;
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

/* Everyone / Top 12 picker inside the signature-earners card. */
.earners-scope {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.5rem;
}
</style>
