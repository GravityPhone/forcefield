<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'
import KnockEditSheet, { type EditableKnock } from '@/components/knocks/KnockEditSheet.vue'
import { OUTCOMES, OUTCOME_HEX, OUTCOME_LABELS, outcomeRowTint } from '@/lib/outcomes'
import OutcomeSquare from '@/components/canvass/OutcomeSquare.vue'
import type { KnockOutcome } from '@/types'

/** Your own knock history — the "where did I already look?" page. The roster
 * answers that question about teammates; this one is the self view: newest
 * first, grouped by day, searchable, and each row jumps back into Talk mode
 * for that door (follow up on a Maybe, re-try a Not Home). */

interface VisitRow {
  id: string
  outcome: KnockOutcome
  occurred_at: string
  person_id: string | null
  /** The door (address id) — null on legacy rows; those rows just don't tap. */
  household_id: string | null
  person: { name: string } | null
  addresses: { street: string; unit: string | null; city: string } | null
}

const FETCH_LIMIT = 500

const auth = useAuthStore()
const talk = useTalkStore()
const router = useRouter()

const visits = ref<VisitRow[]>([])
const loading = ref(true)
const query = ref('')

type OutcomeFilter = 'all' | KnockOutcome
const outcomeFilter = ref<OutcomeFilter>('all')

onMounted(async () => {
  const me = auth.profile?.id
  if (!me) return
  const { data } = await supabase
    .from('knock_logs')
    .select('id, outcome, occurred_at, household_id, person_id, person:persons(name), addresses(street, unit, city)')
    .eq('canvasser_id', me)
    .order('occurred_at', { ascending: false })
    .limit(FETCH_LIMIT)
  visits.value = (data ?? []) as unknown as VisitRow[]
  loading.value = false
})

// --- Filtering: outcome chips × free-text search (street, city, person) ---

const outcomeCounts = computed(() => {
  const counts = { all: visits.value.length } as Record<OutcomeFilter, number>
  for (const o of OUTCOMES) counts[o.value] = 0
  for (const v of visits.value) counts[v.outcome]++
  return counts
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return visits.value.filter((v) => {
    if (outcomeFilter.value !== 'all' && v.outcome !== outcomeFilter.value) return false
    if (!q) return true
    const haystack = [
      v.addresses?.street,
      v.addresses?.unit,
      v.addresses?.city,
      v.person?.name,
    ]
    return haystack.some((s) => s?.toLowerCase().includes(q))
  })
})

// --- Day grouping (local days, same convention as squads/leaderboards) ---

interface DayGroup {
  key: string
  label: string
  rows: VisitRow[]
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabelOf(d: Date, todayKey: string, yesterdayKey: string): string {
  const key = dayKeyOf(d)
  if (key === todayKey) return 'Today'
  if (key === yesterdayKey) return 'Yesterday'
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

const groups = computed<DayGroup[]>(() => {
  const now = new Date()
  const yest = new Date(now)
  yest.setDate(yest.getDate() - 1)
  const todayKey = dayKeyOf(now)
  const yesterdayKey = dayKeyOf(yest)

  const out: DayGroup[] = []
  for (const v of filtered.value) {
    const d = new Date(v.occurred_at)
    const key = dayKeyOf(d)
    const last = out[out.length - 1]
    if (last && last.key === key) last.rows.push(v)
    else out.push({ key, label: dayLabelOf(d, todayKey, yesterdayKey), rows: [v] })
  }
  return out
})

function doorLine(v: VisitRow): string {
  if (!v.addresses) return 'Unknown address'
  return `${v.addresses.street}${v.addresses.unit ? ' ' + v.addresses.unit : ''}`
}

function visitTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Tap a visit: reopen that door in Talk mode, same as tapping its map pin. */
async function openDoor(v: VisitRow) {
  if (!v.household_id) return
  await talk.loadAddress(v.household_id)
  await router.push({ name: 'canvass' })
}

// --- Fixing a knock you already logged ---
//
// Undo at the door only reaches the knock still under your thumb. These are
// your own rows (the whole page is), and RLS agrees, so a wrong outcome or a
// wrong name an hour later is repairable instead of permanent.

const editing = ref<EditableKnock | null>(null)
const editOpen = ref(false)

function startEdit(v: VisitRow) {
  editing.value = {
    id: v.id,
    outcome: v.outcome,
    occurred_at: v.occurred_at,
    household_id: v.household_id,
    person_id: v.person_id,
    doorLabel: doorLine(v),
  }
  editOpen.value = true
}

function onSaved(next: {
  id: string
  outcome: KnockOutcome
  person_id: string | null
  personName: string | null
}) {
  const row = visits.value.find((v) => v.id === next.id)
  if (!row) return
  row.outcome = next.outcome
  row.person_id = next.person_id
  row.person = next.personName ? { name: next.personName } : null
}

function onDeleted(id: string) {
  visits.value = visits.value.filter((v) => v.id !== id)
}
</script>

<template>
  <AppShell title="My knocks">
    <div class="stack">
      <input
        v-model="query"
        class="knock-search"
        data-help="knocks-search"
        type="search"
        placeholder="Search street or name…"
        aria-label="Search your knock history"
      />

      <div class="filter-chips" role="group" aria-label="Filter by outcome" data-help="knocks-filters">
        <button
          class="chip"
          :class="{ active: outcomeFilter === 'all' }"
          :aria-pressed="outcomeFilter === 'all'"
          @click="outcomeFilter = 'all'"
        >
          All
          <span class="chip-count">{{ outcomeCounts.all }}</span>
        </button>
        <button
          v-for="o in OUTCOMES"
          :key="o.value"
          class="chip"
          :class="{ active: outcomeFilter === o.value }"
          :aria-pressed="outcomeFilter === o.value"
          @click="outcomeFilter = o.value"
        >
          <span class="chip-dot" :style="{ background: o.hex }" aria-hidden="true"></span>
          {{ o.short }}
          <span class="chip-count">{{ outcomeCounts[o.value] }}</span>
        </button>
      </div>

      <p v-if="loading" class="muted empty">Loading your history…</p>
      <p v-else-if="!visits.length" class="muted empty">
        No doors yet — every knock you log will show up here.
      </p>
      <p v-else-if="!filtered.length" class="muted empty">No visits match.</p>

      <template v-else>
        <section v-for="g in groups" :key="g.key" class="day">
          <h3 class="day-head">
            {{ g.label }}
            <span class="muted day-count">
              {{ g.rows.length }} knock{{ g.rows.length === 1 ? '' : 's' }}
            </span>
          </h3>
          <div class="card visit-list" data-help="knocks-list">
            <!-- Row and Fix are siblings, not nested: the row is itself a
                 <button> when the door is tappable, and a button inside a
                 button is invalid markup that browsers silently unnest. -->
            <div v-for="v in g.rows" :key="v.id" class="visit-line">
            <component
              :is="v.household_id ? 'button' : 'div'"
              class="visit-row"
              :class="{ tappable: !!v.household_id }"
              :style="outcomeRowTint(OUTCOME_HEX[v.outcome])"
              @click="openDoor(v)"
            >
              <OutcomeSquare :fill="OUTCOME_HEX[v.outcome]" />
              <span class="visit-main">
                <span class="visit-what">
                  <strong>{{ doorLine(v) }}</strong>
                  <template v-if="v.addresses?.city"> · {{ v.addresses.city }}</template>
                </span>
                <span class="muted visit-meta">
                  {{ OUTCOME_LABELS[v.outcome] }}<template v-if="v.person?.name"> — {{ v.person.name }}</template>
                  · {{ visitTime(v.occurred_at) }}
                </span>
              </span>
              <span v-if="v.household_id" class="chevron" aria-hidden="true">›</span>
            </component>
            <button
              class="fix-btn"
              type="button"
              :aria-label="`Fix this knock at ${doorLine(v)}`"
              @click="startEdit(v)"
            >
              Fix
            </button>
            </div>
          </div>
        </section>

        <p v-if="visits.length >= FETCH_LIMIT" class="muted empty">
          Showing your last {{ FETCH_LIMIT }} knocks.
        </p>
      </template>
    </div>

    <KnockEditSheet
      v-model:open="editOpen"
      :knock="editing"
      @saved="onSaved"
      @deleted="onDeleted"
    />
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 640px;
}

.knock-search {
  width: 100%;
  min-height: 46px;
  padding: 0.6rem 0.9rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}

.knock-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.filter-chips {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.75rem;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.chip:hover {
  background: var(--surface-2);
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast, #fff);
}

/* Outcome identity dot — fixed hex like everywhere else, never themed. */
.chip-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.chip-count {
  font-size: 0.75rem;
  font-weight: 700;
  opacity: 0.75;
}

.day {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.day-head {
  margin: 0.35rem 0 0;
  font-size: 0.95rem;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.day-count {
  font-weight: 500;
  font-size: 0.8rem;
}

.visit-list {
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
}

.visit-row {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  width: 100%;
  padding: 0.55rem 0.6rem;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: var(--row-tint, transparent);
  font: inherit;
  color: inherit;
  text-align: left;
}

.visit-row.tappable {
  cursor: pointer;
  transition: background 0.12s ease;
}

.visit-row.tappable:hover {
  background: var(--row-tint-hover, var(--surface-2));
}

/* The row and its Fix button share a line; the divider moved out to the
   wrapper with them. */
.visit-line {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.visit-line + .visit-line {
  border-top: 1px solid var(--border);
}

.visit-line .visit-row {
  flex: 1;
  min-width: 0;
}

.fix-btn {
  flex-shrink: 0;
  align-self: stretch;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  padding: 0 0.55rem;
  border-radius: calc(var(--radius) - 2px);
  cursor: pointer;
}

.fix-btn:hover {
  background: var(--surface-2);
}

/* The dot became a square and the whole line took the color (2026-07-26,
 * user call) — a row you can read at a glance instead of one you have to
 * squint at. --row-tint comes in inline per row; the fallback keeps the
 * hover and the transparent resting state working as before. */

.visit-main {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
  flex: 1;
}

.visit-what {
  font-size: 0.9rem;
}

.visit-meta {
  font-size: 0.8rem;
}

.chevron {
  color: var(--text-muted);
  font-size: 1.15rem;
  line-height: 1;
  flex-shrink: 0;
  align-self: center;
}

.empty {
  margin: 0;
  font-size: 0.92rem;
}
</style>
