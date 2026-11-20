<script setup lang="ts">
// The site plan (2026-11-19): who is standing where, by day.
//
// Voter registration is mostly done at SITES, not doors: a crew outside a
// grocery store or on a campus for a few hours. So this screen has no map and
// no doors. It is a schedule, and each row opens the tally screen for that
// shift (SiteShiftView).
//
// Managers plan here (add a shift by hand, or import the spreadsheet they
// already keep); everybody reads it, with their own shifts first.
import { computed, ref, watch } from 'vue'
import AppShell from '@/components/AppShell.vue'
import ShiftSheet from '@/components/sites/ShiftSheet.vue'
import ImportSheet from '@/components/sites/ImportSheet.vue'
import SiteSheet from '@/components/sites/SiteSheet.vue'
import { localToday } from '@/lib/day'
import { onPageEnter } from '@/lib/pageState'
import {
  campaignMode,
  fetchShifts,
  fetchSites,
  loadCampaignMode,
  personName,
  shiftTimeLabel,
  type SiteRow,
  type SiteShift,
} from '@/lib/registration'
import { useAuthStore } from '@/stores/auth'

defineOptions({ name: 'SitesView' })

const auth = useAuthStore()

// Two questions, one screen: who is where on a given DAY, and the places
// themselves.
//
// ONE DAY AT A TIME, PICKED FROM A STRIP (2026-11-20). The page first listed
// every upcoming day under its own heading, which the user found too much
// ("I don't think I want the today, tomorrow, yada, yada"); then today only,
// which could not show a plan at all, and a site plan is made days ahead
// (sites need arranging, a market is Saturdays, an imported sheet is next
// week). So: the list is always a single day, it opens on today, and a row of
// days across the top moves it. A day with nothing planned is dimmed. Adding a
// shift plans it for the day on screen, so the form asks no date question.
type Scope = 'shifts' | 'sites'
const scope = ref<Scope>('shifts')
/** Every shift from today on; the list shows `day`'s. */
const allShifts = ref<SiteShift[]>([])
const day = ref(localToday())
const sites = ref<SiteRow[]>([])
const loading = ref(true)
const loadError = ref(false)
const today = ref(localToday())

const canPlan = computed(() => {
  const role = auth.profile?.role
  return role === 'campaign_manager' || role === 'admin'
})

let seq = 0
async function load() {
  const mine = ++seq
  today.value = localToday()
  await loadCampaignMode()
  if (campaignMode.value !== 'registration') {
    loading.value = false
    return
  }
  try {
    if (scope.value === 'sites') {
      const rows = await fetchSites()
      if (mine !== seq) return
      sites.value = rows
    } else {
      const rows = await fetchShifts('upcoming', today.value)
      if (mine !== seq) return
      // Yours first.
      allShifts.value = rows
      // A day that has gone by (the page was cached overnight) is not a day.
      if (day.value < today.value) day.value = today.value
    }
    loadError.value = false
  } catch {
    if (mine === seq) loadError.value = true
  } finally {
    if (mine === seq) loading.value = false
  }
}

onPageEnter(load)
// The mode can change under a cached page (a manager flips it in Settings,
// or you switch campaigns), and the plan belongs to whichever it is now.
watch(campaignMode, () => void load())

function setScope(next: Scope) {
  if (scope.value === next) return
  scope.value = next
  loading.value = true
  void load()
}

function isMine(s: SiteShift): boolean {
  return s.members.some((m) => m.id === auth.profile?.id)
}

/** The picked day's shifts, yours first. */
const shifts = computed(() =>
  allShifts.value
    .filter((s) => s.shift_date === day.value)
    .sort((a, b) => Number(isMine(b)) - Number(isMine(a))),
)

/** The strip: two weeks from today, plus any later day that has a shift. */
const strip = computed(() => {
  const [y, m, d] = today.value.split('-').map(Number)
  const planned = new Map<string, number>()
  for (const s of allShifts.value) planned.set(s.shift_date, (planned.get(s.shift_date) ?? 0) + 1)
  const iso = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  const dates: string[] = []
  // Built from y/m/d parts: a bare YYYY-MM-DD parses as UTC (lib/day.ts).
  for (let i = 0; i < 14; i++) dates.push(iso(new Date(y, m - 1, d + i)))
  for (const date of [...planned.keys()].sort()) if (date > dates[dates.length - 1]) dates.push(date)
  return dates.map((date) => {
    const [yy, mm, dd] = date.split('-').map(Number)
    const dt = new Date(yy, mm - 1, dd)
    return {
      date,
      top: date === today.value ? 'Today' : dt.toLocaleDateString([], { weekday: 'short' }),
      num: dt.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      count: planned.get(date) ?? 0,
    }
  })
})

/** Today across every site, the one number worth a glance before the list. */
const todayTotals = computed(() => {
  if (day.value !== today.value || !shifts.value.length) return null
  let registered = 0
  let updated = 0
  for (const s of shifts.value) {
    registered += s.counts.registered
    updated += s.counts.updated
  }
  return { registered, updated }
})

function crewLine(s: SiteShift): string {
  if (!s.members.length) return 'No crew yet'
  return s.members.map(personName).join(', ')
}

const sheetOpen = ref(false)
const importOpen = ref(false)
const presetSite = ref<string | undefined>(undefined)

function addShift(siteName?: string) {
  presetSite.value = siteName
  sheetOpen.value = true
}

/** "+ Add a shift here" comes from INSIDE the site sheet, which is closing as
 * this runs. Two sheets trading places in the same tick leaves the closing
 * one's focus restore and scroll lock release landing on the opening one, so
 * the shift form waits out the site sheet's 0.2s exit first. */
function addShiftAfterSheet(siteName: string) {
  setTimeout(() => addShift(siteName), 260)
}

// The site sheet: null = adding, a row = editing. Tracked by id so the
// refetch after a save re-resolves to the fresh row.
const siteSheetOpen = ref(false)
const siteEditId = ref<string | null>(null)
const siteEditing = computed(() => sites.value.find((s) => s.id === siteEditId.value) ?? null)

function addSite() {
  siteEditId.value = null
  siteSheetOpen.value = true
}

function openSite(s: SiteRow) {
  if (!canPlan.value) return
  siteEditId.value = s.id
  siteSheetOpen.value = true
}

/** A shift planned from a site's sheet lands on the schedule, so go there:
 * staying on the list of places would hide the thing just made. */
function onShiftSaved() {
  if (scope.value === 'sites') {
    scope.value = 'shifts'
    loading.value = true
  }
  void load()
}
</script>

<template>
  <AppShell title="Sites">
    <div class="sites-page">
      <p v-if="loading" class="muted">Loading…</p>

      <template v-else-if="campaignMode !== 'registration'">
        <p class="muted">Sites are off. This campaign is a petition.</p>
        <router-link v-if="canPlan" class="btn" to="/admin/settings">Settings</router-link>
      </template>

      <template v-else>
        <div class="top-row">
          <div class="chip-row" data-help="sites-scope">
            <button class="chip" :class="{ on: scope === 'shifts' }" @click="setScope('shifts')">Shifts</button>
            <button class="chip" :class="{ on: scope === 'sites' }" @click="setScope('sites')">Sites</button>
          </div>
          <div v-if="canPlan" class="plan-btns" data-help="sites-plan">
            <button class="btn btn-sm" @click="importOpen = true">Import</button>
            <button v-if="scope === 'sites'" class="btn btn-sm btn-primary" @click="addSite">+ Add site</button>
            <button v-else class="btn btn-sm btn-primary" @click="addShift()">+ Add shift</button>
          </div>
        </div>

        <div v-if="scope === 'shifts'" class="day-strip" role="group" aria-label="Day" data-help="sites-days">
          <button
            v-for="d in strip"
            :key="d.date"
            type="button"
            class="day-btn"
            :class="{ on: day === d.date, empty: !d.count }"
            @click="day = d.date"
          >
            <span class="day-top">{{ d.top }}</span>
            <span class="day-num">{{ d.num }}</span>
          </button>
        </div>

        <div v-if="scope === 'shifts' && todayTotals" class="card totals" data-help="sites-today">
          <div class="total">
            <span class="total-n">{{ todayTotals.registered }}</span>
            <span class="total-l">Registered today</span>
          </div>
          <div class="total">
            <span class="total-n">{{ todayTotals.updated }}</span>
            <span class="total-l">Updated</span>
          </div>
        </div>

        <p v-if="loadError" class="error-line">Couldn’t load the plan. Try again.</p>

        <template v-else-if="scope === 'sites'">
          <p v-if="!sites.length" class="muted">No sites yet.</p>
          <ul v-else class="shift-list" data-help="sites-directory">
            <li v-for="s in sites" :key="s.id">
              <component
                :is="canPlan ? 'button' : 'div'"
                class="card shift site-row"
                :type="canPlan ? 'button' : undefined"
                @click="openSite(s)"
              >
                <span class="shift-main">
                  <span class="shift-name">{{ s.name }}</span>
                  <span v-if="s.address" class="shift-sub muted">{{ s.address }}</span>
                  <span class="shift-sub">
                    {{ s.shifts }} {{ s.shifts === 1 ? 'shift' : 'shifts' }}
                  </span>
                </span>
                <span class="shift-side">
                  <span class="shift-count">{{ s.counts.registered + s.counts.updated }}</span>
                  <span class="side-lbl muted">registered</span>
                </span>
              </component>
            </li>
          </ul>
        </template>

        <p v-else-if="!shifts.length" class="muted">Nothing planned for this day.</p>

        <ul v-else class="shift-list" data-help="sites-list">
          <li v-for="s in shifts" :key="s.id">
            <router-link class="card shift" :class="{ mine: isMine(s) }" :to="`/sites/${s.id}`">
              <div class="shift-main">
                <span class="shift-name">{{ s.site.name }}</span>
                <span class="shift-sub">
                  <template v-if="shiftTimeLabel(s)">{{ shiftTimeLabel(s) }} · </template>{{ crewLine(s) }}
                </span>
              </div>
              <div class="shift-side">
                <span v-if="isMine(s)" class="mine-tag">You</span>
                <span class="shift-count">
                  {{ s.counts.registered + s.counts.updated }}<template v-if="s.goal != null"> / {{ s.goal }}</template>
                </span>
              </div>
            </router-link>
          </li>
        </ul>
      </template>
    </div>

    <ShiftSheet v-model:open="sheetOpen" :shift="null" :preset-site="presetSite" :day="day" @saved="onShiftSaved" />
    <SiteSheet
      v-model:open="siteSheetOpen"
      :site="siteEditing"
      @saved="load"
      @deleted="load"
      @add-shift="addShiftAfterSheet"
    />
    <ImportSheet v-model:open="importOpen" @imported="load" />
  </AppShell>
</template>

<style scoped>
.sites-page {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.top-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.chip-row,
.plan-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.chip {
  padding: 0.35rem 0.8rem;
  border: 1.5px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

/* The row of days. Its own sideways scroller on purpose: the page never
 * slides, a strip of fourteen days may. */
.day-strip {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 0.1rem;
}

.day-strip::-webkit-scrollbar {
  display: none;
}

.day-btn {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  min-width: 62px;
  padding: 0.4rem 0.55rem;
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.day-btn.empty {
  color: var(--text-muted);
  border-style: dashed;
}

.day-btn.on {
  border-color: var(--accent);
  border-style: solid;
  background: var(--accent);
  color: var(--accent-contrast);
}

.day-top {
  font-size: 0.72rem;
  font-weight: 700;
}

.day-num {
  font-size: 0.9rem;
  font-weight: 800;
  white-space: nowrap;
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.totals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  padding: 0.7rem 0.8rem;
}

.total {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.total-n {
  font-size: 1.6rem;
  font-weight: 800;
  line-height: 1;
}

.total-l {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
}

.error-line {
  color: var(--danger);
  font-weight: 600;
}

.shift-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.shift {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  padding: 0.65rem 0.8rem;
  color: inherit;
  text-decoration: none;
}

/* Your own shift carries the accent down its edge, the same job a "You" tag
 * does in words for anyone who can't see the stripe. */
.shift.mine {
  border-left: 5px solid var(--accent);
}

/* A site row is a <button> for managers: undo the UA centering and nowrap,
 * same lesson as the Squad tiles. */
.site-row {
  width: 100%;
  font: inherit;
  text-align: left;
  white-space: normal;
}

button.site-row {
  cursor: pointer;
}

.side-lbl {
  font-size: 0.72rem;
  font-weight: 600;
}

.shift-main {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  flex: 1 1 auto;
  min-width: 0;
}

.shift-name {
  font-weight: 700;
}

.shift-sub {
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}

.shift-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.2rem;
  flex-shrink: 0;
}

.mine-tag {
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.7rem;
  font-weight: 800;
}

.shift-count {
  font-size: 1.15rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

</style>
