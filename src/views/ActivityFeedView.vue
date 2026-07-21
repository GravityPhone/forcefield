<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import { fadeUp } from '@/lib/motion'
import { avatarUrl } from '@/lib/avatars'
import { startOfLocalDayISO } from '@/lib/day'
import { memberColor } from '@/lib/memberColors'
import { OUTCOME_HEX, OUTCOME_LABELS } from '@/lib/outcomes'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { DEFAULT_FEED_SETTINGS } from '@/types'
import type { ActivityFeedSettings, KnockOutcome } from '@/types'

// The whole team's day, newest first: every signature (and knock, if the
// campaign manager left those on) as it lands, plus milestone moments —
// personal door counts, squads heating up, whole-team "way to go"s. All of
// it is DERIVED client-side from today's knock_logs (which carry squad
// stamps); the only server state is the settings singleton.

const SELECT =
  'id, client_id, canvasser_id, household_id, person_id, occurred_at, outcome, squad_id, squad_name, ' +
  'canvasser:profiles(id, username, display_name, avatar, color), ' +
  'person:persons(name), address:addresses(street, city)'

interface FeedRow {
  id: string
  client_id: string
  canvasser_id: string
  household_id: string | null
  person_id: string | null
  occurred_at: string
  outcome: KnockOutcome
  squad_id: string | null
  squad_name: string | null
  canvasser: {
    id: string
    username: string
    display_name: string | null
    avatar: string | null
    color: string | null
  } | null
  person: { name: string } | null
  address: { street: string; city: string } | null
}

interface EventItem {
  kind: 'knock' | 'signature'
  key: string
  at: string
  who: string
  avatar: string | null
  color: string
  outcome: KnockOutcome
  personName: string | null
  street: string | null
}

interface MilestoneItem {
  kind: 'milestone'
  key: string
  at: string
  scope: 'person' | 'squad' | 'team'
  emoji: string
  strong: string
  rest: string
  /** Person milestones show the canvasser's avatar like event rows do. */
  avatar?: string | null
  color?: string
}

type FeedItem = EventItem | MilestoneItem

/** Stored generously past what a phone will scroll; day-long feeds trim
 * from the old end, milestones and all — it's a live feed, not a report. */
const MAX_ITEMS = 400

const settings = ref<ActivityFeedSettings>({ ...DEFAULT_FEED_SETTINGS })
const items = ref<FeedItem[]>([])
const loading = ref(true)
const loadError = ref(false)

// --- Day counters (module state, reset per load) ---
// Doors are DISTINCT households and signatures DISTINCT signed persons —
// the same semantics as squad progress and the door-status colors (the
// leaderboard's every-log "doors" count is deliberately looser).
const seenIds = new Set<string>()
const personDoors = new Map<string, Set<string>>()
const squadDoors = new Map<string, Set<string>>()
const squadSigs = new Map<string, Set<string>>()
const teamDoors = new Set<string>()
const teamSigs = new Set<string>()
const doorsToday = ref(0)
const sigsToday = ref(0)

function resetCounters() {
  seenIds.clear()
  personDoors.clear()
  squadDoors.clear()
  squadSigs.clear()
  teamDoors.clear()
  teamSigs.clear()
  doorsToday.value = 0
  sigsToday.value = 0
}

/** "412 WALNUT ST" → "412 Walnut St". */
function prettyStreet(street: string): string {
  return street.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function whoOf(row: FeedRow): string {
  return row.canvasser?.display_name || row.canvasser?.username || 'Someone'
}

/** Grow `map[key]` by one member and report whether it crossed a multiple
 * of `step` (distinct sets only ever grow by 0 or 1, so exact multiples
 * are always hit). */
function bump(set: Set<string>, member: string, step: number): { size: number; crossed: boolean } {
  const before = set.size
  set.add(member)
  return { size: set.size, crossed: set.size > before && set.size % step === 0 }
}

function setFor(map: Map<string, Set<string>>, key: string): Set<string> {
  let s = map.get(key)
  if (!s) map.set(key, (s = new Set()))
  return s
}

/** Turn one knock row into feed items (the event itself + any milestones it
 * crossed), in chronological order. Counters advance HERE, so replay order
 * matters on load (ascending) and each row must run exactly once. */
function processRow(row: FeedRow): FeedItem[] {
  if (seenIds.has(row.id)) return []
  seenIds.add(row.id)
  const s = settings.value
  const out: FeedItem[] = []
  const isSig = row.outcome === 'signed'
  const who = whoOf(row)
  const color = memberColor({ id: row.canvasser_id, color: row.canvasser?.color })

  out.push({
    kind: isSig ? 'signature' : 'knock',
    key: row.client_id || row.id,
    at: row.occurred_at,
    who,
    avatar: row.canvasser?.avatar ?? null,
    color,
    outcome: row.outcome,
    personName: row.person?.name ?? null,
    street: row.address ? prettyStreet(row.address.street) : null,
  })

  if (row.household_id) {
    const p = bump(setFor(personDoors, row.canvasser_id), row.household_id, s.person_door_step)
    if (s.person_milestones && p.crossed) {
      out.push({
        kind: 'milestone',
        key: `pd-${row.canvasser_id}-${p.size}`,
        at: row.occurred_at,
        scope: 'person',
        emoji: '🔥',
        strong: who,
        rest: `hit ${p.size} doors today`,
        avatar: row.canvasser?.avatar ?? null,
        color,
      })
    }
    if (row.squad_id && row.squad_name) {
      const q = bump(setFor(squadDoors, row.squad_id), row.household_id, s.squad_door_step)
      if (s.squad_milestones && q.crossed) {
        out.push({
          kind: 'milestone',
          key: `qd-${row.squad_id}-${q.size}`,
          at: row.occurred_at,
          scope: 'squad',
          emoji: '🚀',
          strong: row.squad_name,
          rest: `is cooking — ${q.size} doors today`,
        })
      }
    }
    const t = bump(teamDoors, row.household_id, s.team_door_step)
    doorsToday.value = t.size
    if (s.team_milestones && t.crossed) {
      out.push({
        kind: 'milestone',
        key: `td-${t.size}`,
        at: row.occurred_at,
        scope: 'team',
        emoji: '💪',
        strong: 'The whole team',
        rest: `just passed ${t.size} doors today`,
      })
    }
  }

  if (isSig && row.person_id) {
    if (row.squad_id && row.squad_name) {
      const q = bump(setFor(squadSigs, row.squad_id), row.person_id, s.squad_signature_step)
      if (s.squad_milestones && q.crossed) {
        out.push({
          kind: 'milestone',
          key: `qs-${row.squad_id}-${q.size}`,
          at: row.occurred_at,
          scope: 'squad',
          emoji: '✍️',
          strong: row.squad_name,
          rest: `has ${q.size} signatures today`,
        })
      }
    }
    const t = bump(teamSigs, row.person_id, s.team_signature_step)
    sigsToday.value = t.size
    if (s.team_milestones && t.crossed) {
      out.push({
        kind: 'milestone',
        key: `ts-${t.size}`,
        at: row.occurred_at,
        scope: 'team',
        emoji: '🎉',
        strong: 'Way to go, team!',
        rest: `${t.size} signatures today`,
      })
    }
  }

  return out
}

async function load() {
  loading.value = true
  loadError.value = false
  const [settingsRes, rows] = await Promise.all([
    supabase.from('activity_feed_settings').select('*').eq('id', true).maybeSingle(),
    fetchAllRows<FeedRow>(
      (from, to) =>
        supabase
          .from('knock_logs')
          .select(SELECT)
          .gte('occurred_at', startOfLocalDayISO())
          .order('occurred_at', { ascending: true })
          .order('id', { ascending: true })
          // The embedded-resource select string is beyond supabase-js's
          // type-level parser — the rows really are FeedRow-shaped.
          .range(from, to) as unknown as PromiseLike<{
          data: FeedRow[] | null
          error: { message: string } | null
        }>,
    ).catch(() => null),
  ])
  if (settingsRes.data) settings.value = settingsRes.data as ActivityFeedSettings
  if (!rows) {
    loadError.value = true
    loading.value = false
    return
  }
  resetCounters()
  const chrono: FeedItem[] = []
  for (const row of rows) chrono.push(...processRow(row))
  items.value = chrono.reverse().slice(0, MAX_ITEMS)
  loading.value = false
}

// --- Live: new knocks land at the top as squadmates log them ---

let channel: RealtimeChannel | null = null

async function onLiveKnock(raw: { id: string; occurred_at: string }) {
  // A knock syncing in late from an offline queue can predate today.
  if (seenIds.has(raw.id) || raw.occurred_at < startOfLocalDayISO()) return
  const { data } = await supabase
    .from('knock_logs')
    .select(SELECT)
    .eq('id', raw.id)
    .maybeSingle()
  if (!data) return
  const fresh = processRow(data as unknown as FeedRow)
  if (fresh.length) items.value = [...fresh.reverse(), ...items.value].slice(0, MAX_ITEMS)
}

onMounted(() => {
  void load()
  channel = supabase
    .channel('activity-feed')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'knock_logs' },
      (payload) => void onLiveKnock(payload.new as { id: string; occurred_at: string }),
    )
    .subscribe()
})

onUnmounted(() => {
  if (channel) void supabase.removeChannel(channel)
})

// --- Display ---

const visible = computed(() =>
  items.value.filter((i) =>
    i.kind === 'knock'
      ? settings.value.show_knocks
      : i.kind === 'signature'
        ? settings.value.show_signatures
        : true,
  ),
)

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** vue-tsc doesn't narrow the FeedItem union in the template's v-else
 * branch — this cast is only ever called from milestone branches. */
function ms(item: FeedItem): MilestoneItem {
  return item as MilestoneItem
}
</script>

<template>
  <AppShell title="Team feed">
    <div class="stack">
      <!-- Today-so-far strip: the two numbers everyone actually asks about. -->
      <div class="card totals">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="totals-text">
          Today so far: <strong>{{ doorsToday }}</strong> door{{ doorsToday === 1 ? '' : 's' }} ·
          <strong>{{ sigsToday }}</strong> signature{{ sigsToday === 1 ? '' : 's' }}
        </span>
      </div>

      <p v-if="loading" class="muted state">Loading today's activity…</p>
      <p v-else-if="loadError" class="error state">
        Couldn't load the feed — check the connection and reload.
      </p>
      <p v-else-if="!visible.length" class="muted state">
        Nothing yet today — the first knock lights this up.
      </p>

      <ul v-else class="feed">
        <li
          v-for="(item, i) in visible"
          :key="item.key"
          v-motion="fadeUp(Math.min(i, 6) * 30)"
          class="row"
          :class="item.kind === 'milestone' ? `milestone milestone-${item.scope}` : item.kind"
        >
          <!-- Event rows + personal milestones lead with the canvasser. -->
          <span
            v-if="item.kind !== 'milestone' || item.scope === 'person'"
            class="row-avatar"
            :style="{ borderColor: item.color, background: avatarUrl(item.avatar ?? null) ? 'var(--surface)' : item.color }"
          >
            <img v-if="avatarUrl(item.avatar ?? null)" :src="avatarUrl(item.avatar ?? null)" alt="" />
            <template v-else>{{ (item.kind === 'milestone' ? item.strong : item.who).slice(0, 1).toUpperCase() }}</template>
          </span>
          <span v-else class="row-emoji" aria-hidden="true">{{ item.emoji }}</span>

          <span class="row-main">
            <template v-if="item.kind === 'signature'">
              <span class="row-what">
                <strong>{{ item.who }}</strong>
                got {{ item.personName ? `${item.personName}'s` : 'a' }} signature
              </span>
              <span class="muted row-meta">
                {{ item.street ? item.street + ' · ' : '' }}{{ timeOf(item.at) }}
              </span>
            </template>
            <template v-else-if="item.kind === 'knock'">
              <span class="row-what">
                <strong>{{ item.who }}</strong>
                <span class="outcome-chip" :style="{ color: OUTCOME_HEX[item.outcome] }">
                  <span class="outcome-dot" :style="{ background: OUTCOME_HEX[item.outcome] }"></span>
                  {{ OUTCOME_LABELS[item.outcome] }}</span
                >{{ item.personName ? ' — ' + item.personName : '' }}
              </span>
              <span class="muted row-meta">
                {{ item.street ? item.street + ' · ' : '' }}{{ timeOf(item.at) }}
              </span>
            </template>
            <template v-else>
              <span class="row-what">
                <span v-if="ms(item).scope === 'person'" class="row-inline-emoji" aria-hidden="true">{{ ms(item).emoji }}</span>
                <strong>{{ ms(item).strong }}</strong> {{ ms(item).rest }}
              </span>
              <span class="muted row-meta">{{ timeOf(item.at) }}</span>
            </template>
          </span>
        </li>
      </ul>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.state {
  margin: 0;
  font-size: 0.92rem;
}

.error {
  color: var(--danger, #c0392b);
}

/* --- Totals strip --- */

.totals {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 0.9rem;
}

.totals-text {
  font-size: 0.95rem;
}

.live-dot {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #2fbf71;
  box-shadow: 0 0 0 0 rgba(47, 191, 113, 0.55);
  animation: feed-live-pulse 2s ease-out infinite;
}

@keyframes feed-live-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(47, 191, 113, 0.55);
  }
  70% {
    box-shadow: 0 0 0 9px rgba(47, 191, 113, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(47, 191, 113, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot {
    animation: none;
  }
}

/* --- Feed rows --- */

.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-left: 4px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.row.signature {
  border-left-color: #2e9e5b;
  background: color-mix(in srgb, #2e9e5b 7%, var(--surface));
}

.row.milestone {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}

/* Whole-team moments shout a little louder. */
.row.milestone-team {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  font-size: 1.02rem;
}

.row-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2.5px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #fff;
  font-weight: 800;
  font-size: 0.9rem;
}

.row-avatar img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 2px;
}

.row-emoji {
  flex-shrink: 0;
  width: 32px;
  text-align: center;
  font-size: 1.35rem;
  line-height: 1;
}

.row-inline-emoji {
  margin-right: 0.15rem;
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.row-what {
  font-size: 0.94rem;
  overflow-wrap: anywhere;
}

.row-meta {
  font-size: 0.78rem;
}

.outcome-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-left: 0.4rem;
  font-weight: 700;
  font-size: 0.88rem;
}

.outcome-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
}
</style>
