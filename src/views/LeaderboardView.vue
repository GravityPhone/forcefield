<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { METRIC_LABELS } from '@/types'
import type {
  CanvasserLeaderboardRow,
  LeaderboardMetric,
  LeaderboardSettings,
  TeamLeaderboardRow,
} from '@/types'

const auth = useAuthStore()
const myId = auth.profile?.id ?? null
const myTeamId = auth.profile?.team_id ?? null

const settings = ref<LeaderboardSettings | null>(null)
const canvassers = ref<CanvasserLeaderboardRow[]>([])
const teams = ref<TeamLeaderboardRow[]>([])
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
  ])
  loading.value = false
  if (s.data) settings.value = s.data as LeaderboardSettings
  if (c.data) canvassers.value = c.data as CanvasserLeaderboardRow[]
  if (t.data) teams.value = t.data as TeamLeaderboardRow[]
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

      <p v-if="loading" class="muted">Loading standings…</p>

      <template v-else>
        <div class="card">
          <h3>Canvassers — {{ METRIC_LABELS[primaryMetric] }}</h3>
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

        <div v-if="showDoorsBoard" class="card">
          <h3>Canvassers — Doors knocked</h3>
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

        <div class="card">
          <h3>Teams — {{ METRIC_LABELS[primaryMetric] }}</h3>
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
          <p v-if="!teams.length" class="muted">No teams yet.</p>
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

.board {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
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
