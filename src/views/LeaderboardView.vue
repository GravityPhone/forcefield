<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { localDayRangeISO, localToday } from '@/lib/day'
import { useAuthStore } from '@/stores/auth'
import { METRIC_LABELS } from '@/types'
import type {
  CanvasserLeaderboardRow,
  LeaderboardMetric,
  LeaderboardSettings,
  TeamLeaderboardRow,
} from '@/types'

/** Aggregated client-side: squads are tiny (a day's crews) and a single
 * day's knocks are a cheap filtered query, so no SQL view is needed. */
interface SquadBoardRow {
  squad_id: string
  squad_name: string
  member_count: number
  doors_knocked: number
  signatures: number
  isMine: boolean
}

const auth = useAuthStore()
const myId = auth.profile?.id ?? null
const myTeamId = auth.profile?.team_id ?? null
const today = localToday()

const settings = ref<LeaderboardSettings | null>(null)
const canvassersAllTime = ref<CanvasserLeaderboardRow[]>([])
const teamsAllTime = ref<TeamLeaderboardRow[]>([])
const canvassersForDay = ref<CanvasserLeaderboardRow[]>([])
const teamsForDay = ref<TeamLeaderboardRow[]>([])
const squadRows = ref<SquadBoardRow[]>([])
const loading = ref(true)
const dayLoading = ref(false)
// Spec default: your own team, with an org-wide toggle. Teamless users
// (e.g. the seed admin) start org-wide.
const scope = ref<'team' | 'org'>(myTeamId ? 'team' : 'org')
// null = all-time career totals; a YYYY-MM-DD string = that day's history.
const selectedDate = ref<string | null>(null)

let channel: RealtimeChannel | null = null
let refetchTimer: ReturnType<typeof setTimeout> | null = null

const effectiveDay = computed(() => selectedDate.value ?? today)

/** Career totals, straight off the SQL views. */
async function loadAllTime() {
  const [s, c, t] = await Promise.all([
    supabase.from('leaderboard_settings').select('*').eq('id', true).single(),
    supabase.from('canvasser_leaderboard').select('*'),
    supabase.from('team_leaderboard').select('*'),
  ])
  if (s.data) settings.value = s.data as LeaderboardSettings
  if (c.data) canvassersAllTime.value = c.data as CanvasserLeaderboardRow[]
  if (t.data) teamsAllTime.value = t.data as TeamLeaderboardRow[]
}

/** Team roster size doesn't depend on which day is being viewed — a
 * canvasser's current team assignment stands in for their team on any past
 * day too, same limitation the all-time team board already has. */
const teamMemberCounts = computed(() => {
  const m = new Map<string, number>()
  for (const c of canvassersAllTime.value) {
    if (c.team_id) m.set(c.team_id, (m.get(c.team_id) ?? 0) + 1)
  }
  return m
})

/** One day's standings: that day's squads (squad_date scopes squads to a
 * single workday already) plus canvasser/team totals rebuilt from that
 * day's knocks alone — the "career totals" views have no day dimension. */
async function loadDayBoard(dateStr: string) {
  dayLoading.value = true
  const { startISO, endISO } = localDayRangeISO(dateStr)
  const [squadsRes, knocksRes] = await Promise.all([
    supabase.from('squads').select('id, name, chat_id, squad_members(user_id)').eq('squad_date', dateStr),
    supabase
      .from('knock_logs')
      .select('canvasser_id, outcome')
      .gte('occurred_at', startISO)
      .lt('occurred_at', endISO),
  ])
  type SquadRow = { id: string; name: string; squad_members: { user_id: string }[] }
  const knocks = (knocksRes.data ?? []) as { canvasser_id: string; outcome: string }[]

  const doorsBy = new Map<string, number>()
  const signaturesBy = new Map<string, number>()
  for (const k of knocks) {
    doorsBy.set(k.canvasser_id, (doorsBy.get(k.canvasser_id) ?? 0) + 1)
    if (k.outcome === 'signed') {
      signaturesBy.set(k.canvasser_id, (signaturesBy.get(k.canvasser_id) ?? 0) + 1)
    }
  }

  squadRows.value = ((squadsRes.data ?? []) as SquadRow[]).map((s) => {
    const memberIds = s.squad_members.map((m) => m.user_id)
    return {
      squad_id: s.id,
      squad_name: s.name,
      member_count: memberIds.length,
      doors_knocked: memberIds.reduce((sum, id) => sum + (doorsBy.get(id) ?? 0), 0),
      signatures: memberIds.reduce((sum, id) => sum + (signaturesBy.get(id) ?? 0), 0),
      isMine: myId != null && memberIds.includes(myId),
    }
  })

  // Only canvassers who actually worked that day — a full roster of zeros
  // isn't a useful "who did best on this day" answer.
  canvassersForDay.value = canvassersAllTime.value
    .filter((c) => doorsBy.has(c.canvasser_id))
    .map((c) => ({
      ...c,
      doors_knocked: doorsBy.get(c.canvasser_id) ?? 0,
      signatures: signaturesBy.get(c.canvasser_id) ?? 0,
    }))

  const teamAgg = new Map<string, { team_name: string; doors_knocked: number; signatures: number }>()
  for (const c of canvassersForDay.value) {
    if (!c.team_id) continue
    const entry = teamAgg.get(c.team_id) ?? { team_name: c.team_name ?? '—', doors_knocked: 0, signatures: 0 }
    entry.doors_knocked += c.doors_knocked
    entry.signatures += c.signatures
    teamAgg.set(c.team_id, entry)
  }
  teamsForDay.value = [...teamAgg.entries()].map(([team_id, v]) => ({
    team_id,
    team_name: v.team_name,
    member_count: teamMemberCounts.value.get(team_id) ?? 0,
    doors_knocked: v.doors_knocked,
    signatures: v.signatures,
  }))
  dayLoading.value = false
}

async function refreshAll() {
  // Sequential: loadDayBoard reads canvassersAllTime for roster/team-name
  // lookups, so it needs the career totals to have already landed.
  await loadAllTime()
  await loadDayBoard(effectiveDay.value)
  loading.value = false
}

watch(selectedDate, () => void loadDayBoard(effectiveDay.value))

function onPickDate(value: string) {
  selectedDate.value = value || null
}

function formatDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const primaryMetric = computed<LeaderboardMetric>(
  () => settings.value?.primary_metric ?? 'signatures',
)

/** The optional second board only makes sense when it isn't already the
 * primary ranking. */
const showDoorsBoard = computed(
  () => !!settings.value?.doors_board_enabled && primaryMetric.value !== 'doors',
)

const canvassers = computed(() => (selectedDate.value ? canvassersForDay.value : canvassersAllTime.value))
const teams = computed(() => (selectedDate.value ? teamsForDay.value : teamsAllTime.value))

const scopedCanvassers = computed(() =>
  scope.value === 'team' && myTeamId
    ? canvassers.value.filter((r) => r.team_id === myTeamId)
    : canvassers.value,
)

const dateSuffix = computed(() => (selectedDate.value ? ` — ${formatDay(selectedDate.value)}` : ''))

const squadsTitle = computed(() =>
  selectedDate.value ? `Squads — ${formatDay(selectedDate.value)}` : 'Squads — today',
)
const squadsEmptyNote = computed(() =>
  selectedDate.value ? 'No squads that day.' : 'No squads yet today.',
)
const squadsFootnote = computed(() =>
  selectedDate.value
    ? `Counts each member's knocks on ${formatDay(selectedDate.value)}.`
    : "Counts each member's knocks since midnight. Squads reset daily.",
)
const canvassersEmptyNote = computed(() =>
  selectedDate.value
    ? `No knocks logged on ${formatDay(selectedDate.value)}.`
    : 'No knocks logged yet — standings will fill in as doors get knocked.',
)
const teamsEmptyNote = computed(() => (selectedDate.value ? 'No team activity that day.' : 'No teams yet.'))

function metricOf(row: { doors_knocked: number; signatures: number }, metric: LeaderboardMetric) {
  return metric === 'doors' ? row.doors_knocked : row.signatures
}

function ranked<T extends { doors_knocked: number; signatures: number }>(
  rows: T[],
  metric: LeaderboardMetric,
): T[] {
  const other: LeaderboardMetric = metric === 'doors' ? 'signatures' : 'doors'
  return [...rows].sort(
    (a, b) => metricOf(b, metric) - metricOf(a, metric) || metricOf(b, other) - metricOf(a, other),
  )
}

function canvasserName(r: CanvasserLeaderboardRow) {
  return r.display_name || r.username
}

onMounted(() => {
  void refreshAll()
  // New knocks are the only thing that moves standings; debounce so a burst
  // of offline-queue replays becomes one refetch.
  channel = supabase
    .channel('leaderboard-knocks')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'knock_logs' }, () => {
      if (refetchTimer) clearTimeout(refetchTimer)
      refetchTimer = setTimeout(() => void refreshAll(), 500)
    })
    .subscribe()
})

onUnmounted(() => {
  if (refetchTimer) clearTimeout(refetchTimer)
  if (channel) void supabase.removeChannel(channel)
})
</script>

<template>
  <AppShell title="Leaderboard">
    <div class="stack">
      <div class="toolbar" v-if="myTeamId">
        <button
          class="btn btn-sm"
          :class="scope === 'team' ? 'btn-primary' : 'btn-ghost'"
          @click="scope = 'team'"
        >
          My team
        </button>
        <button
          class="btn btn-sm"
          :class="scope === 'org' ? 'btn-primary' : 'btn-ghost'"
          @click="scope = 'org'"
        >
          Org-wide
        </button>
      </div>

      <p v-if="loading" class="muted loading-row">
        <span class="spinner" aria-hidden="true"></span> Loading standings…
      </p>

      <template v-else>
        <!-- History: browse any past day's standings, or jump back to
             career totals / today. -->
        <div class="history-row">
          <div class="history-buttons">
            <button
              class="btn btn-sm"
              :class="selectedDate === null ? 'btn-primary' : 'btn-ghost'"
              @click="selectedDate = null"
            >
              All time
            </button>
            <button
              class="btn btn-sm"
              :class="selectedDate === today ? 'btn-primary' : 'btn-ghost'"
              @click="selectedDate = today"
            >
              Today
            </button>
          </div>
          <input
            type="date"
            class="day-input"
            :max="today"
            :value="selectedDate ?? ''"
            aria-label="View leaderboard for a specific day"
            @change="onPickDate(($event.target as HTMLInputElement).value)"
          />
          <span v-if="dayLoading" class="spinner" aria-hidden="true"></span>
        </div>

        <div class="card">
          <h3>Canvassers — {{ METRIC_LABELS[primaryMetric] }}{{ dateSuffix }}</h3>
          <div class="board-scroll">
          <table class="board">
            <thead>
              <tr>
                <th class="rank">#</th>
                <th>Canvasser</th>
                <th v-if="scope === 'org'">Team</th>
                <th class="num">{{ METRIC_LABELS[primaryMetric] }}</th>
                <th class="num">{{ METRIC_LABELS[primaryMetric === 'doors' ? 'signatures' : 'doors'] }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(r, i) in ranked(scopedCanvassers, primaryMetric)"
                :key="r.canvasser_id"
                :class="{ me: r.canvasser_id === myId }"
              >
                <td class="rank">{{ i + 1 }}</td>
                <td>{{ canvasserName(r) }}{{ r.canvasser_id === myId ? ' (you)' : '' }}</td>
                <td v-if="scope === 'org'" class="muted">{{ r.team_name ?? '—' }}</td>
                <td class="num">{{ metricOf(r, primaryMetric) }}</td>
                <td class="num muted">{{ metricOf(r, primaryMetric === 'doors' ? 'signatures' : 'doors') }}</td>
              </tr>
            </tbody>
          </table>
          </div>
          <p v-if="!scopedCanvassers.length" class="muted empty-note">{{ canvassersEmptyNote }}</p>
        </div>

        <div v-if="showDoorsBoard" class="card">
          <h3>Canvassers — Doors knocked{{ dateSuffix }}</h3>
          <div class="board-scroll">
          <table class="board">
            <thead>
              <tr>
                <th class="rank">#</th>
                <th>Canvasser</th>
                <th v-if="scope === 'org'">Team</th>
                <th class="num">Doors knocked</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(r, i) in ranked(scopedCanvassers, 'doors')"
                :key="r.canvasser_id"
                :class="{ me: r.canvasser_id === myId }"
              >
                <td class="rank">{{ i + 1 }}</td>
                <td>{{ canvasserName(r) }}{{ r.canvasser_id === myId ? ' (you)' : '' }}</td>
                <td v-if="scope === 'org'" class="muted">{{ r.team_name ?? '—' }}</td>
                <td class="num">{{ r.doors_knocked }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <div class="card">
          <h3>{{ squadsTitle }}</h3>
          <template v-if="squadRows.length">
            <div class="board-scroll">
            <table class="board">
              <thead>
                <tr>
                  <th class="rank">#</th>
                  <th>Squad</th>
                  <th class="num">Members</th>
                  <th class="num">{{ METRIC_LABELS[primaryMetric] }}</th>
                  <th class="num">{{ METRIC_LABELS[primaryMetric === 'doors' ? 'signatures' : 'doors'] }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(s, i) in ranked(squadRows, primaryMetric)"
                  :key="s.squad_id"
                  :class="{ me: s.isMine }"
                >
                  <td class="rank">{{ i + 1 }}</td>
                  <td>{{ s.squad_name }}{{ s.isMine ? ' (your squad)' : '' }}</td>
                  <td class="num muted">{{ s.member_count }}</td>
                  <td class="num">{{ metricOf(s, primaryMetric) }}</td>
                  <td class="num muted">{{ metricOf(s, primaryMetric === 'doors' ? 'signatures' : 'doors') }}</td>
                </tr>
              </tbody>
            </table>
            </div>
            <p class="muted empty-note">{{ squadsFootnote }}</p>
          </template>
          <p v-else class="muted empty-note">{{ squadsEmptyNote }}</p>
        </div>

        <div class="card">
          <h3>Teams — {{ METRIC_LABELS[primaryMetric] }}{{ dateSuffix }}</h3>
          <div class="board-scroll">
          <table class="board">
            <thead>
              <tr>
                <th class="rank">#</th>
                <th>Team</th>
                <th class="num">Members</th>
                <th class="num">{{ METRIC_LABELS[primaryMetric] }}</th>
                <th class="num">{{ METRIC_LABELS[primaryMetric === 'doors' ? 'signatures' : 'doors'] }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(t, i) in ranked(teams, primaryMetric)"
                :key="t.team_id"
                :class="{ me: t.team_id === myTeamId }"
              >
                <td class="rank">{{ i + 1 }}</td>
                <td>{{ t.team_name }}{{ t.team_id === myTeamId ? ' (your team)' : '' }}</td>
                <td class="num muted">{{ t.member_count }}</td>
                <td class="num">{{ metricOf(t, primaryMetric) }}</td>
                <td class="num muted">{{ metricOf(t, primaryMetric === 'doors' ? 'signatures' : 'doors') }}</td>
              </tr>
            </tbody>
          </table>
          </div>
          <p v-if="!teams.length" class="muted empty-note">{{ teamsEmptyNote }}</p>
        </div>
      </template>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.toolbar {
  display: flex;
  gap: 0.4rem;
}

.loading-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.history-buttons {
  display: flex;
  gap: 0.4rem;
}

.day-input {
  min-height: 36px;
  padding: 0.3rem 0.6rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.day-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

/* Long names + the org-wide Team column can outgrow a phone screen — scroll
 * the table inside the card rather than the whole page sideways. */
.board-scroll {
  overflow-x: auto;
}

.board {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}

.empty-note {
  margin: 0.6rem 0 0;
  font-size: 0.9rem;
}

.board th {
  text-align: left;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
}

.board td {
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid var(--border);
}

.board tbody tr:last-child td {
  border-bottom: none;
}

.rank {
  width: 2.2rem;
  text-align: right;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

tr.me td {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-weight: 600;
}
</style>
