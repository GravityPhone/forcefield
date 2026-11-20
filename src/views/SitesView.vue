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
import { avatarUrl } from '@/lib/avatars'
import { localToday } from '@/lib/day'
import { onPageEnter } from '@/lib/pageState'
import {
  campaignMode,
  conversations,
  fetchShifts,
  fetchSites,
  loadCampaignMode,
  personName,
  shiftDayLabel,
  shiftTimeLabel,
  type SiteRow,
  type SiteShift,
} from '@/lib/registration'
import { useAuthStore } from '@/stores/auth'

defineOptions({ name: 'SitesView' })

const auth = useAuthStore()

// Two questions, one screen: WHEN (the schedule, upcoming or past) and WHERE
// (the places themselves, with what each has produced). 'sites' is the where.
type Scope = 'upcoming' | 'past' | 'sites'
const scope = ref<Scope>('upcoming')
const shifts = ref<SiteShift[]>([])
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
      const rows = await fetchShifts(scope.value, today.value)
      if (mine !== seq) return
      shifts.value = rows
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

/** Shifts by day, in the order they arrived; within a day, yours first. */
const days = computed(() => {
  const groups: { date: string; label: string; shifts: SiteShift[] }[] = []
  for (const s of shifts.value) {
    let g = groups[groups.length - 1]
    if (!g || g.date !== s.shift_date) {
      g = { date: s.shift_date, label: shiftDayLabel(s.shift_date, today.value), shifts: [] }
      groups.push(g)
    }
    g.shifts.push(s)
  }
  for (const g of groups) {
    g.shifts.sort((a, b) => Number(isMine(b)) - Number(isMine(a)))
  }
  return groups
})

/** Today across every site, the one number worth a glance before the list. */
const todayTotals = computed(() => {
  let registered = 0
  let updated = 0
  let talked = 0
  let any = false
  for (const s of shifts.value) {
    if (s.shift_date !== today.value) continue
    any = true
    registered += s.counts.registered
    updated += s.counts.updated
    talked += conversations(s.counts)
  }
  return any ? { registered, updated, talked } : null
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
    scope.value = 'upcoming'
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
            <button class="chip" :class="{ on: scope === 'upcoming' }" @click="setScope('upcoming')">Upcoming</button>
            <button class="chip" :class="{ on: scope === 'past' }" @click="setScope('past')">Past</button>
            <button class="chip" :class="{ on: scope === 'sites' }" @click="setScope('sites')">Sites</button>
          </div>
          <div v-if="canPlan" class="plan-btns" data-help="sites-plan">
            <button class="btn btn-sm" @click="importOpen = true">Import</button>
            <button v-if="scope === 'sites'" class="btn btn-sm btn-primary" @click="addSite">+ Add site</button>
            <button v-else class="btn btn-sm btn-primary" @click="addShift()">+ Add shift</button>
          </div>
        </div>

        <div v-if="scope === 'upcoming' && todayTotals" class="card totals" data-help="sites-today">
          <div class="total">
            <span class="total-n">{{ todayTotals.registered }}</span>
            <span class="total-l">Registered today</span>
          </div>
          <div class="total">
            <span class="total-n">{{ todayTotals.updated }}</span>
            <span class="total-l">Updated</span>
          </div>
          <div class="total">
            <span class="total-n">{{ todayTotals.talked }}</span>
            <span class="total-l">Conversations</span>
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
                    {{ s.shifts }} {{ s.shifts === 1 ? 'shift' : 'shifts' }} · {{ conversations(s.counts) }} conversations
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

        <p v-else-if="!days.length" class="muted">
          {{ scope === 'upcoming' ? 'No shifts planned.' : 'No past shifts.' }}
        </p>

        <section v-for="g in scope === 'sites' ? [] : days" :key="g.date" class="day">
          <h2 class="day-head">{{ g.label }}</h2>
          <ul class="shift-list" data-help="sites-list">
            <li v-for="s in g.shifts" :key="s.id">
              <router-link class="card shift" :class="{ mine: isMine(s) }" :to="`/sites/${s.id}`">
                <div class="shift-main">
                  <span class="shift-name">{{ s.site.name }}</span>
                  <span v-if="s.site.address" class="shift-sub muted">{{ s.site.address }}</span>
                  <span class="shift-sub">
                    <template v-if="shiftTimeLabel(s)">{{ shiftTimeLabel(s) }} · </template>{{ crewLine(s) }}
                  </span>
                </div>
                <div class="shift-side">
                  <span v-if="isMine(s)" class="mine-tag">You</span>
                  <span class="shift-count">
                    {{ s.counts.registered + s.counts.updated }}<template v-if="s.goal != null"> / {{ s.goal }}</template>
                  </span>
                  <span class="faces">
                    <img
                      v-for="m in s.members.filter((p) => p.avatar).slice(0, 4)"
                      :key="m.id"
                      class="face"
                      :src="avatarUrl(m.avatar)"
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </span>
                </div>
              </router-link>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <ShiftSheet v-model:open="sheetOpen" :shift="null" :preset-site="presetSite" @saved="onShiftSaved" />
    <SiteSheet
      v-model:open="siteSheetOpen"
      :site="siteEditing"
      @saved="load"
      @deleted="load"
      @add-shift="addShift"
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

.chip.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
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

.day {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.day-head {
  margin: 0.3rem 0 0;
  font-size: 0.95rem;
  font-weight: 800;
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

.faces {
  display: flex;
}

.face {
  width: 22px;
  height: 22px;
  margin-left: -5px;
}
</style>
