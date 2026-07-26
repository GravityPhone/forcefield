<script setup lang="ts">
// Appointments (2026-07-26) — every "come back at X" a canvasser promised at
// a door, in one list, grouped by day.
//
// This page is only reachable once a campaign manager switches appointments
// on, and the switch is NOT here — it's tucked into /admin/settings (user
// call, 2026-07-26). That's a deliberate exception to the 2026-07-21 "knobs
// live on the screen they affect" rule: Board options and Feed options
// configure a screen everyone already has, while this one decides whether a
// whole feature exists. A switch can't live on the page it hides.
//
// Whether an appointment was kept is DERIVED, never stored: a knock at that
// door inside the window means somebody went back. Everything else the row
// says comes from the clock. `status` in the DB records only the one thing a
// knock can't imply — that a human called it off.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { hapticTap } from '@/lib/native'
import {
  appointmentSettings,
  dayLabel,
  ensureAppointmentSettings,
  localDateKey,
  windowLabel,
} from '@/lib/appointments'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'
import type { Appointment } from '@/types'

interface ApptRow extends Appointment {
  addresses: { street: string; unit: string | null; city: string } | null
  person: { name: string } | null
  canvasser: { username: string; display_name: string | null } | null
}

/** How far back the list reaches. Older than this is analytics' job, not a
 * dispatch screen's. */
const PAST_DAYS = 14

const auth = useAuthStore()
const talk = useTalkStore()
const router = useRouter()

const rows = ref<ApptRow[]>([])
/** household_id → knock timestamps (ms) since the earliest loaded window —
 * what "kept" is read off. */
const knockTimes = ref<Map<string, number[]>>(new Map())
const loading = ref(true)
const loadError = ref(false)

const canManage = computed(
  () => auth.profile?.role === 'admin' || auth.profile?.role === 'campaign_manager',
)

// --------------------------------------------------------------- loading

async function load() {
  loading.value = true
  loadError.value = false
  const since = new Date()
  since.setDate(since.getDate() - PAST_DAYS)
  since.setHours(0, 0, 0, 0)
  try {
    const data = await fetchAllRows<ApptRow>((from, to) =>
      supabase
        .from('appointments')
        .select(
          '*, addresses(street, unit, city), person:persons(name), canvasser:profiles(username, display_name)',
        )
        .gte('starts_at', since.toISOString())
        .order('starts_at')
        .order('id')
        .range(from, to),
    )
    rows.value = data
    await loadKnocks(data, since)
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

/** Knocks at the doors we're showing, since the oldest window — the evidence
 * a row is "kept". Chunked: `.in()` on a long id list blows the URL length,
 * the same way the Squad page chunks its status fetch. */
async function loadKnocks(appts: ApptRow[], since: Date) {
  const ids = [...new Set(appts.map((a) => a.household_id))]
  const by = new Map<string, number[]>()
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data } = await supabase
      .from('knock_logs')
      .select('household_id, occurred_at')
      .in('household_id', slice)
      .gte('occurred_at', since.toISOString())
    for (const k of data ?? []) {
      const id = k.household_id as string
      const list = by.get(id) ?? []
      list.push(new Date(k.occurred_at as string).getTime())
      by.set(id, list)
    }
  }
  knockTimes.value = by
}

onMounted(async () => {
  await ensureAppointmentSettings()
  // Switched off campaign-wide: nothing to fetch, and the page says so.
  if (!appointmentSettings.value.enabled) {
    loading.value = false
    return
  }
  await load()
})

// --------------------------------------------------------------- status

type ApptState = 'upcoming' | 'now' | 'kept' | 'late' | 'missed' | 'canceled'

/** Tags stay one short word — this column sits beside an address on a phone.
 * "Late" is spelled out in the help ("the return came after the window"). */
const STATE_LABELS: Record<ApptState, string> = {
  upcoming: '',
  now: 'Now',
  kept: 'Kept',
  late: 'Late',
  missed: 'Missed',
  canceled: 'Canceled',
}

function stateOf(a: ApptRow, now: number): ApptState {
  if (a.status === 'canceled') return 'canceled'
  const start = new Date(a.starts_at).getTime()
  const end = new Date(a.ends_at).getTime()
  const knocks = knockTimes.value.get(a.household_id) ?? []
  if (knocks.some((t) => t >= start && t <= end)) return 'kept'
  if (now < start) return 'upcoming'
  if (now <= end) return 'now'
  if (knocks.some((t) => t > end)) return 'late'
  return 'missed'
}

/** Resolved once per render pass rather than three times per row in the
 * template — and off ONE clock reading, so a row can't be "still to come" in
 * its color and "missed" in its tag for straddling a second boundary. */
const stateById = computed(() => {
  const now = Date.now()
  return new Map(rows.value.map((a) => [a.id, stateOf(a, now)]))
})
const stateFor = (a: ApptRow): ApptState => stateById.value.get(a.id) ?? 'upcoming'

// --------------------------------------------------------------- scope

type Scope = 'upcoming' | 'today' | 'past'
const scope = ref<Scope>('upcoming')
const SCOPES: { value: Scope; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'today', label: 'Today' },
  { value: 'past', label: 'Past' },
]
const mineOnly = ref(false)

const visible = computed(() => {
  const now = Date.now()
  const today = localDateKey(new Date())
  const me = auth.profile?.id
  return rows.value.filter((a) => {
    if (mineOnly.value && a.canvasser_id !== me) return false
    const end = new Date(a.ends_at).getTime()
    if (scope.value === 'today') return localDateKey(new Date(a.starts_at)) === today
    if (scope.value === 'upcoming') return end >= now && a.status !== 'canceled'
    return end < now || a.status === 'canceled'
  })
})

interface DayGroup {
  key: string
  label: string
  items: ApptRow[]
}

/** Grouped by local day. Upcoming reads forward, Past reads backward — the
 * nearest thing in either direction is what you came here for. */
const groups = computed<DayGroup[]>(() => {
  const list = [...visible.value]
  if (scope.value === 'past') list.reverse()
  const out: DayGroup[] = []
  for (const a of list) {
    const d = new Date(a.starts_at)
    const key = localDateKey(d)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(a)
    else out.push({ key, label: dayLabel(d), items: [a] })
  }
  return out
})

/** Honors "Mine only" — a count in the same row as the switch that ignored it
 * would just look like the list was hiding rows. */
const upcomingCount = computed(() => {
  const now = Date.now()
  const me = auth.profile?.id
  return rows.value.filter(
    (a) =>
      a.status === 'scheduled' &&
      new Date(a.ends_at).getTime() >= now &&
      (!mineOnly.value || a.canvasser_id === me),
  ).length
})

// --------------------------------------------------------------- row actions

function doorLine(a: ApptRow): string {
  if (!a.addresses) return 'Unknown address'
  return `${a.addresses.street}${a.addresses.unit ? ' ' + a.addresses.unit : ''}`
}

function bookedBy(a: ApptRow): string {
  return a.canvasser ? a.canvasser.display_name || a.canvasser.username : 'unknown'
}

/** Tap a row: open that door in Talk, same handoff as a map pin or a knock
 * in your history. Coming back IS the point of the list. */
async function openDoor(a: ApptRow) {
  hapticTap('light')
  await talk.loadAddress(a.household_id, a.person_id ?? undefined)
  await router.push({ name: 'canvass' })
}

const canCancel = (a: ApptRow) =>
  a.status === 'scheduled' && (canManage.value || a.canvasser_id === auth.profile?.id)

const canceling = ref('')

async function cancel(a: ApptRow) {
  canceling.value = a.id
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('id', a.id)
  canceling.value = ''
  if (!error) a.status = 'canceled'
}

</script>

<template>
  <AppShell title="Appointments">
    <!-- Deep-linked with the feature switched off. Managers get pointed at
         the switch; nobody else has anything to do here. -->
    <p v-if="!appointmentSettings.enabled" class="muted state">
      Appointments are off.<template v-if="canManage">
        Turn them on under <router-link to="/admin/settings">Settings</router-link>.</template>
    </p>

    <div v-else class="stack">
      <div class="scope" data-help="appt-scope">
        <div class="chip-row" role="group" aria-label="Which appointments">
          <button
            v-for="s in SCOPES"
            :key="s.value"
            type="button"
            class="chip"
            :class="{ on: scope === s.value }"
            @click="scope = s.value"
          >
            {{ s.label }}
          </button>
        </div>
        <button
          type="button"
          class="chip mine"
          :class="{ on: mineOnly }"
          role="switch"
          :aria-checked="mineOnly"
          @click="mineOnly = !mineOnly"
        >
          Mine only
        </button>
        <span class="scope-right muted">{{ upcomingCount }} coming up</span>
      </div>

      <p v-if="loading" class="muted state">Loading…</p>
      <p v-else-if="loadError" class="error state">Couldn’t load appointments.</p>
      <p v-else-if="!groups.length" class="muted state">Nothing here.</p>

      <section v-for="g in groups" :key="g.key" class="day" data-help="appt-list">
        <h3 class="day-head">{{ g.label }}</h3>
        <ul class="appt-list">
          <li v-for="a in g.items" :key="a.id" class="appt-row" :class="stateFor(a)">
            <!-- Left rail is the visit — when, and how it went. The address
                 and the people get the rest of the width; on a phone that is
                 the difference between a readable street name and two words
                 a line. -->
            <button class="appt-main" @click="openDoor(a)">
              <span class="appt-when">
                <span class="appt-time">{{ windowLabel(new Date(a.starts_at), new Date(a.ends_at)) }}</span>
                <span v-if="STATE_LABELS[stateFor(a)]" class="appt-state">{{ STATE_LABELS[stateFor(a)] }}</span>
              </span>
              <span class="appt-body">
                <span class="appt-door">{{ doorLine(a) }}</span>
                <span class="muted appt-meta">
                  <template v-if="a.person?.name">{{ a.person.name }} · </template>{{ bookedBy(a) }}
                </span>
              </span>
            </button>
            <button
              v-if="canCancel(a)"
              class="appt-cancel"
              :disabled="canceling === a.id"
              :aria-label="`Cancel ${doorLine(a)}`"
              title="Cancel"
              @click="cancel(a)"
            >
              ✕
            </button>
          </li>
        </ul>
      </section>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.state {
  margin: 0;
  font-size: 0.92rem;
}

.error {
  color: var(--danger, #c0392b);
  font-size: 0.9rem;
}

/* --- Scope row --- */

.scope {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.32rem 0.75rem;
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

/* On a phone the chips fill the row and this count wraps below them; pushed
 * right it reads as a stranded scrap, so let it sit under the chips instead. */
@media (max-width: 460px) {
  .scope-right {
    margin-left: 0;
  }
}

/* --- The list --- */

.day-head {
  margin: 0 0 0.4rem;
  font-size: 0.92rem;
}

.appt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.appt-row {
  display: flex;
  align-items: stretch;
  gap: 0.4rem;
  border: 1px solid var(--border);
  border-left: 4px solid #e0a02e;
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

/* The left edge carries the state, so a long list reads as a column of
 * colors before it reads as words. */
.appt-row.kept {
  border-left-color: #2e9e5b;
}

.appt-row.missed {
  border-left-color: #d64545;
}

.appt-row.late,
.appt-row.canceled {
  border-left-color: #8a90a5;
}

.appt-row.canceled .appt-main {
  opacity: 0.6;
}

.appt-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.6rem 0.75rem;
  border: none;
  background: transparent;
  font: inherit;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.appt-main:hover {
  background: var(--surface-2);
}

.appt-when {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
}

.appt-time {
  font-weight: 800;
  font-size: 0.88rem;
  white-space: nowrap;
}

.appt-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
}

.appt-door {
  font-weight: 700;
  font-size: 0.95rem;
  overflow-wrap: anywhere;
}

.appt-meta {
  font-size: 0.82rem;
}

.appt-state {
  font-size: 0.72rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: var(--text-muted);
}

.appt-cancel {
  flex-shrink: 0;
  width: 40px;
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.9rem;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.appt-cancel:hover {
  color: var(--danger, #c0392b);
  background: var(--surface-2);
}
</style>
