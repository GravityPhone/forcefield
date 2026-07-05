<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { localToday, startOfLocalDayISO } from '@/lib/day'
import { useAuthStore } from '@/stores/auth'
import { METRIC_LABELS } from '@/types'
import type {
  CanvasserLeaderboardRow,
  LeaderboardMetric,
  LeaderboardSettings,
  TeamLeaderboardRow,
} from '@/types'

/** Aggregated client-side: squads are tiny (a day's crews) and today's
 * knocks are already a filtered query, so no SQL view is needed. */
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

const settings = ref<LeaderboardSettings | null>(null)
const canvassers = ref<CanvasserLeaderboardRow[]>([])
const teams = ref<TeamLeaderboardRow[]>([])
const squadRows = ref<SquadBoardRow[]>([])
const loading = ref(true)
// Spec default: your own team, with an org-wide toggle. Teamless users
// (e.g. the seed admin) start org-wide.
const scope = ref<'team' | 'org'>(myTeamId ? 'team' : 'org')

let channel: RealtimeChannel | null = null
let refetchTimer: ReturnType<typeof setTimeout> | null = null

async function loadAll() {
  const [s, c, t] = await Promise.all([
    supabase.from('leaderboard_settings').select('*').eq('id', true).single(),
    supabase.from('canvasser_leaderboard').select('*'),
    supabase.from('team_leaderboard').select('*'),
    loadSquadBoard(),
  ])
  loading.value = false
  if (s.data) settings.value = s.data as LeaderboardSettings
  if (c.data) canvassers.value = c.data as CanvasserLeaderboardRow[]
  if (t.data) teams.value = t.data as TeamLeaderboardRow[]
}

/** Today's squads ranked by what their members knocked today. Members'
 * knocks count from local midnight (not from when they joined the squad) —
 * a squad is "who you're crewing with today", not a signup timestamp. */
async function loadSquadBoard() {
  const [squadsRes, knocksRes] = await Promise.all([
    supabase
      .from('squads')
      .select('id, name, chat_id, squad_members(user_id)')
      .eq('squad_date', localToday()),
    supabase
      .from('knock_logs')
      .select('canvasser_id, outcome')
      .gte('occurred_at', startOfLocalDayISO()),
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
}

const primaryMetric = computed<LeaderboardMetric>(
  () => settings.value?.primary_metric ?? 'signatures',
)

/** The optional second board only makes sense when it isn't already the
 * primary ranking. */
const showDoorsBoard = computed(
  () => !!settings.value?.doors_board_enabled && primaryMetric.value !== 'doors',
)

const scopedCanvassers = computed(() =>
  scope.value === 'team' && myTeamId
    ? canvassers.value.filter((r) => r.team_id === myTeamId)
    : canvassers.value,
)

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
  void loadAll()
  // New knocks are the only thing that moves standings; debounce so a burst
  // of offline-queue replays becomes one refetch.
  channel = supabase
    .channel('leaderboard-knocks')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'knock_logs' }, () => {
      if (refetchTimer) clearTimeout(refetchTimer)
      refetchTimer = setTimeout(() => void loadAll(), 500)
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
        <div class="card">
          <h3>Canvassers — {{ METRIC_LABELS[primaryMetric] }}</h3>
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
          <p v-if="!scopedCanvassers.length" class="muted empty-note">
            No knocks logged yet — standings will fill in as doors get knocked.
          </p>
        </div>

        <div v-if="showDoorsBoard" class="card">
          <h3>Canvassers — Doors knocked</h3>
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

        <div v-if="squadRows.length" class="card">
          <h3>Squads — today</h3>
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
          <p class="muted empty-note">Counts each member's knocks since midnight. Squads reset daily.</p>
        </div>

        <div class="card">
          <h3>Teams — {{ METRIC_LABELS[primaryMetric] }}</h3>
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
          <p v-if="!teams.length" class="muted empty-note">No teams yet.</p>
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
