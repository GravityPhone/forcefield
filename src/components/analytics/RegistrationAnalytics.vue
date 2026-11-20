<script setup lang="ts">
// Analytics for a registration campaign (2026-11-20, user call: "the analytics
// in reg mode are sig based").
//
// The petition page is built on knock_logs and counts signatures. A
// registration drive's record is `registration_logs`: one row per person
// talked to, at a site or at a door, scoped to the campaign. So this is its
// own body rather than a relabel of the petition tabs: relabelling would have
// put the petition's signature history on screen under the word
// "Registrations", next to a Campaign card that counts the real ones.
//
// Three tabs: Overview, Sites (which places are worth a crew, the question a
// site plan exists to answer) and People.
//
// REGISTRATIONS ONLY (same day, second user call: "we're not tracking
// conversations… people just go to sites and just kind of randomly try to ask
// people. And then they look up their name"). The log also holds Already
// registered, Not eligible and Declined, but those are whatever happened to
// get written down, not a count of everybody approached, so a rate taken over
// them would be a number about note-taking. This page reads only the two
// results that are forms: Registered (new) and Updated.
import { computed, ref, shallowRef, watch } from 'vue'
import ChartCard from '@/components/charts/ChartCard.vue'
import BarChart from '@/components/charts/BarChart.vue'
import type { BarItem } from '@/components/charts/BarChart.vue'
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue'
import type { TimeSeries } from '@/components/charts/TimeSeriesChart.vue'
import StackedBarChart from '@/components/charts/StackedBarChart.vue'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { onPageEnter } from '@/lib/pageState'
import { useChartPalette, fmtCount, fmtPct } from '@/lib/chartTheme'
import { REG_HEX, type RegResult } from '@/lib/registration'
import { useAuthStore } from '@/stores/auth'

export type RegTab = 'overview' | 'sites' | 'people'

const props = defineProps<{ tab: RegTab }>()
const emit = defineEmits<{ (e: 'update:tab', tab: RegTab): void }>()

const TABS: { id: RegTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'sites', label: 'Sites' },
  { id: 'people', label: 'People' },
]

const auth = useAuthStore()
const palette = useChartPalette()
const cat = computed(() => palette.categorical.value)

// ---------------------------------------------------------------- loading

interface Log {
  ts: number
  day: string // local YYYY-MM-DD
  person: string
  site: string | null
  shift: string | null
  door: boolean
  /** A new registration; false is an update to an existing one. */
  fresh: boolean
}

const loading = ref(true)
const loadError = ref('')
const logs = shallowRef<Log[]>([])
const siteNames = shallowRef<Map<string, string>>(new Map())
const personNames = shallowRef<Map<string, string>>(new Map())

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let seq = 0
async function load() {
  const cid = auth.profile?.campaign_id
  if (!cid) {
    logs.value = []
    loading.value = false
    return
  }
  const mine = ++seq
  try {
    const [rows, sites, profs] = await Promise.all([
      fetchAllRows<{
        canvasser_id: string
        site_id: string | null
        shift_id: string | null
        household_id: string | null
        result: RegResult
        occurred_at: string
      }>((from, to) =>
        supabase
          .from('registration_logs')
          .select('canvasser_id, site_id, shift_id, household_id, result, occurred_at')
          .eq('campaign_id', cid)
          .in('result', ['registered', 'updated'])
          .order('id')
          .range(from, to),
      ),
      supabase
        .from('sites')
        .select('id, name')
        .eq('campaign_id', cid)
        .then(({ data, error }) => {
          if (error) throw new Error(error.message)
          return data ?? []
        }),
      supabase
        .from('profiles')
        .select('id, username, display_name')
        .then(({ data, error }) => {
          if (error) throw new Error(error.message)
          return data ?? []
        }),
    ])
    // A slower answer for a campaign we have since switched away from.
    if (mine !== seq) return
    siteNames.value = new Map(sites.map((s) => [s.id, s.name]))
    personNames.value = new Map(profs.map((p) => [p.id, p.display_name || p.username]))
    logs.value = rows.map((r) => {
      const d = new Date(r.occurred_at)
      return {
        ts: d.getTime(),
        day: isoDay(d),
        person: r.canvasser_id,
        site: r.site_id,
        shift: r.shift_id,
        door: !r.site_id && !!r.household_id,
        fresh: r.result === 'registered',
      }
    })
    loadError.value = ''
  } catch (e) {
    if (mine === seq) loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}

onPageEnter(load, 60_000)
watch(
  () => auth.profile?.campaign_id,
  () => {
    loading.value = true
    void load()
  },
)

// ----------------------------------------------------------------- window

type RangeKey = '1' | '7' | '14' | '30' | 'all'
const RANGE_CHIPS: { value: RangeKey; label: string }[] = [
  { value: '1', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: 'all', label: 'All time' },
]
const rangeKey = ref<RangeKey>('30')

/** Local midnight `daysAgo` days back. Built from y/m/d parts, never by
 * subtracting 86.4M ms, which lands an hour off across a DST change. */
function dayStart(daysAgo: number): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo)
}

/** Windows count back from today and include it, as on the petition page. */
const windowStart = computed(() =>
  rangeKey.value === 'all' ? -Infinity : dayStart(Number(rangeKey.value) - 1).getTime(),
)
const shown = computed(() => logs.value.filter((l) => l.ts >= windowStart.value))

/** Every calendar day in the window, oldest first. All time starts at the
 * first day anything was logged. */
const axis = computed<string[]>(() => {
  let first: Date
  if (rangeKey.value === 'all') {
    let min = Infinity
    for (const l of logs.value) if (l.ts < min) min = l.ts
    if (!Number.isFinite(min)) return [isoDay(new Date())]
    const d = new Date(min)
    first = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  } else {
    first = dayStart(Number(rangeKey.value) - 1)
  }
  const out: string[] = []
  const end = dayStart(0).getTime()
  for (let d = first; d.getTime() <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(isoDay(d))
  }
  return out
})

function dayLabel(s: string): string {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// --------------------------------------------------------------- overview

const tiles = computed(() => {
  const f = shown.value
  const fresh = f.filter((l) => l.fresh).length
  const days = new Set(f.map((l) => l.day)).size
  return [
    { label: 'Registrations', value: fmtCount(f.length), hint: 'new and updated' },
    { label: 'New', value: fmtCount(fresh), hint: 'registered for the first time' },
    { label: 'Updated', value: fmtCount(f.length - fresh), hint: 'name or address changed' },
    {
      label: 'Registrations a day',
      value: days ? (f.length / days).toFixed(1) : '0',
      hint: days ? `over ${days} ${days === 1 ? 'day' : 'days'} worked` : undefined,
    },
    { label: 'At sites', value: fmtCount(f.filter((l) => l.site).length) },
    { label: 'At doors', value: fmtCount(f.filter((l) => l.door).length) },
  ]
})

/** Registrations per calendar day over EVERYTHING loaded, so the 7-day
 * average can reach back past the window (the petition page's rule: a day's
 * average is a fact about that day, not about which chip is selected). */
const madeByDay = computed(() => {
  const m = new Map<string, number>()
  for (const l of logs.value) m.set(l.day, (m.get(l.day) ?? 0) + 1)
  return m
})
const firstDay = computed(() => {
  let min = ''
  for (const l of logs.value) if (!min || l.day < min) min = l.day
  return min
})

const perDay = computed(() => axis.value.map((d) => madeByDay.value.get(d) ?? 0))
const avg7 = computed<(number | null)[]>(() =>
  axis.value.map((day) => {
    const [y, m, d] = day.split('-').map(Number)
    const oldest = isoDay(new Date(y, m - 1, d - 6))
    // No seven days behind it yet: the data ran out, not the window.
    if (!firstDay.value || oldest < firstDay.value) return null
    let sum = 0
    for (let i = 0; i < 7; i++) sum += madeByDay.value.get(isoDay(new Date(y, m - 1, d - i))) ?? 0
    return sum / 7
  }),
)
const trend = computed<TimeSeries[]>(() => [
  { name: 'Registrations', color: cat.value[0], values: perDay.value, area: true },
  { name: 'Average of the last 7 days', color: cat.value[1], values: avg7.value, width: 3, dash: true },
])
const trendRows = computed(() =>
  axis.value.map((d, i) => [d, perDay.value[i], avg7.value[i] == null ? '' : avg7.value[i]!.toFixed(1)]),
)

/** New against updated, each day. */
const kindStack = computed(() => {
  const idx = new Map(axis.value.map((d, i) => [d, i]))
  const fresh = new Array<number>(axis.value.length).fill(0)
  const updated = new Array<number>(axis.value.length).fill(0)
  for (const l of shown.value) {
    const i = idx.get(l.day)
    if (i != null) (l.fresh ? fresh : updated)[i]++
  }
  return [
    { name: 'New', color: REG_HEX.registered, values: fresh },
    { name: 'Updated', color: REG_HEX.updated, values: updated },
  ]
})

// ------------------------------------------------------------------ groups

interface Group {
  key: string
  label: string
  total: number
  fresh: number
  shifts: Set<string>
  days: Set<string>
}

function groupBy(list: Log[], keyOf: (l: Log) => string | null, nameOf: (k: string) => string): Group[] {
  const m = new Map<string, Group>()
  for (const l of list) {
    const k = keyOf(l)
    if (!k) continue
    let g = m.get(k)
    if (!g) {
      g = { key: k, label: nameOf(k), total: 0, fresh: 0, shifts: new Set(), days: new Set() }
      m.set(k, g)
    }
    g.total++
    if (l.fresh) g.fresh++
    if (l.shift) g.shifts.add(l.shift)
    g.days.add(l.day)
  }
  return [...m.values()].sort((a, b) => b.total - a.total)
}

const countItems = (groups: Group[]): BarItem[] =>
  groups.map((g) => ({
    label: g.label,
    value: g.total,
    detail: `${fmtCount(g.fresh)} new, ${fmtCount(g.total - g.fresh)} updated`,
  }))

// ------------------------------------------------------------------- sites

const siteGroups = computed(() =>
  groupBy(
    shown.value,
    (l) => l.site,
    (k) => siteNames.value.get(k) ?? 'Removed site',
  ),
)
const bySite = computed(() => countItems(siteGroups.value))
const perShift = computed<BarItem[]>(() =>
  siteGroups.value
    .filter((g) => g.shifts.size)
    .map((g) => ({
      label: g.label,
      value: g.total / g.shifts.size,
      detail: `${fmtCount(g.total)} over ${g.shifts.size} ${g.shifts.size === 1 ? 'shift' : 'shifts'}`,
    }))
    .sort((a, b) => b.value - a.value),
)
const SITE_COLUMNS = ['Site', 'Shifts', 'New', 'Updated', 'Total', 'Per shift']
const siteRows = computed(() =>
  siteGroups.value.map((g) => [
    g.label,
    g.shifts.size,
    g.fresh,
    g.total - g.fresh,
    g.total,
    g.shifts.size ? (g.total / g.shifts.size).toFixed(1) : '',
  ]),
)

// ------------------------------------------------------------------ people

const peopleGroups = computed(() =>
  groupBy(
    shown.value,
    (l) => l.person,
    (k) => personNames.value.get(k) ?? 'Someone',
  ),
)
const byPerson = computed(() => countItems(peopleGroups.value))
const perDayOut = computed<BarItem[]>(() =>
  peopleGroups.value
    .map((g) => ({
      label: g.label,
      value: g.total / g.days.size,
      detail: `${fmtCount(g.total)} over ${g.days.size} ${g.days.size === 1 ? 'day' : 'days'} out`,
    }))
    .sort((a, b) => b.value - a.value),
)
const PEOPLE_COLUMNS = ['Person', 'Days out', 'New', 'Updated', 'Total']
const peopleRows = computed(() =>
  peopleGroups.value.map((g) => [g.label, g.days.size, g.fresh, g.total - g.fresh, g.total]),
)
</script>

<template>
  <div v-if="loading" class="card center">
    <p class="muted">Loading registrations…</p>
  </div>
  <div v-else-if="loadError" class="card center">
    <p class="error">Couldn't load registrations: {{ loadError }}</p>
  </div>

  <template v-else>
    <div class="tabs" role="tablist" data-help="analytics-tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="tab"
        role="tab"
        :aria-selected="props.tab === t.id"
        :class="{ active: props.tab === t.id }"
        @click="emit('update:tab', t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <section class="stack">
      <div class="scope" data-help="analytics-scope">
        <div class="chip-row" role="group" aria-label="Time window">
          <button
            v-for="r in RANGE_CHIPS"
            :key="r.value"
            type="button"
            class="chip"
            :class="{ on: rangeKey === r.value }"
            @click="rangeKey = r.value"
          >
            {{ r.label }}
          </button>
        </div>
        <span class="scope-right muted">
          {{ fmtCount(shown.length) }} {{ shown.length === 1 ? 'registration' : 'registrations' }}
        </span>
      </div>

      <!-- ============================== Overview -->
      <template v-if="props.tab === 'overview'">
        <div class="tiles" data-help="analytics-tiles">
          <div v-for="t in tiles" :key="t.label" class="tile">
            <span class="tile-label muted">{{ t.label }}</span>
            <span class="tile-value">{{ t.value }}</span>
            <span v-if="t.hint" class="tile-hint muted">{{ t.hint }}</span>
          </div>
        </div>

        <ChartCard
          title="Registrations per day"
          data-help="reg-trend"
          :columns="['Day', 'Registrations', 'Average of the last 7 days']"
          :rows="trendRows"
        >
          <TimeSeriesChart :labels="axis.map(dayLabel)" :series="trend" />
        </ChartCard>

        <ChartCard
          title="New and updated"
          subtitle="registrations each day"
          :columns="['Day', 'New', 'Updated']"
          :rows="axis.map((d, i) => [d, kindStack[0].values[i], kindStack[1].values[i]])"
        >
          <StackedBarChart :labels="axis.map(dayLabel)" :series="kindStack" :height="230" />
        </ChartCard>
      </template>

      <!-- ============================== Sites -->
      <template v-else-if="props.tab === 'sites'">
        <p v-if="!siteGroups.length" class="card center muted">No site registrations in this window.</p>
        <template v-else>
          <div class="two-col">
            <ChartCard
              title="Registrations by site"
              data-help="reg-by-site"
              :columns="['Site', 'Registrations', 'Detail']"
              :rows="bySite.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="bySite" :color="cat[0]" measure="Registrations" />
            </ChartCard>

            <ChartCard
              title="Registrations per shift"
              data-help="reg-per-shift"
              subtitle="registrations ÷ shifts worked"
              :columns="['Site', 'Per shift', 'Detail']"
              :rows="perShift.map((i) => [i.label, i.value.toFixed(1), i.detail ?? ''])"
            >
              <BarChart :items="perShift" :color="cat[0]" measure="Registrations per shift" />
            </ChartCard>
          </div>

          <ChartCard title="Every site" table-only :columns="SITE_COLUMNS" :rows="siteRows" />
        </template>
      </template>

      <!-- ============================== People -->
      <template v-else>
        <p v-if="!peopleGroups.length" class="card center muted">No registrations in this window.</p>
        <template v-else>
          <div class="two-col">
            <ChartCard
              title="Registrations by person"
              data-help="reg-by-person"
              :columns="['Person', 'Registrations', 'Detail']"
              :rows="byPerson.map((i) => [i.label, i.value, i.detail ?? ''])"
            >
              <BarChart :items="byPerson" :color="cat[0]" measure="Registrations" />
            </ChartCard>

            <ChartCard
              title="Registrations per day out"
              subtitle="registrations ÷ days worked"
              :columns="['Person', 'Per day out', 'Detail']"
              :rows="perDayOut.map((i) => [i.label, i.value.toFixed(1), i.detail ?? ''])"
            >
              <BarChart :items="perDayOut" :color="cat[0]" measure="Registrations per day out" />
            </ChartCard>
          </div>

          <ChartCard title="Everyone" table-only :columns="PEOPLE_COLUMNS" :rows="peopleRows" />
        </template>
      </template>
    </section>
  </template>
</template>

<style scoped>
/* The petition Analytics page's own chrome, so the two modes look like one
   page with different numbers on it. */
.center {
  text-align: center;
  padding: 3rem 1rem;
}
.error {
  color: var(--danger);
}
.tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: 1.1rem;
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
  font-size: calc(0.9rem * var(--ui-scale));
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
.scope-right {
  font-size: 0.82rem;
  margin-left: auto;
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
