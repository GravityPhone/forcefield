<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import CampaignPace from '@/components/CampaignPace.vue'
import { fadeUp } from '@/lib/motion'
import { avatarUrl } from '@/lib/avatars'
import { startOfLocalDayISO } from '@/lib/day'
import { memberColor } from '@/lib/memberColors'
import { OUTCOME_HEX, OUTCOME_SHORT } from '@/lib/outcomes'
import { loadCampaignPace, type LoadedPace } from '@/lib/pace'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
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
  /** The canvasser's profile id — their name and avatar link to /member/:id
   * (2026-07-25, user call: "pull up the other person's profile when we go
   * on the feed and we click someone's name"). */
  whoId: string
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
  /** Person milestones show the canvasser's avatar like event rows do, and
   * link to their profile the same way. */
  avatar?: string | null
  color?: string
  whoId?: string
}

type FeedItem = EventItem | MilestoneItem

/** Stored generously past what a phone will scroll; day-long feeds trim
 * from the old end, milestones and all — it's a live feed, not a report. */
const MAX_ITEMS = 400

const settings = ref<ActivityFeedSettings>({ ...DEFAULT_FEED_SETTINGS })
const items = ref<FeedItem[]>([])
const loading = ref(true)
const loadError = ref(false)
/** Campaign pace above the day's rows. Loaded once per visit, deliberately
 *  not refreshed on live knocks: one more signature never visibly moves a
 *  per-day rate, and the feed is already the busiest realtime screen here. */
const pace = ref<LoadedPace | null>(null)

// --- Feed options (campaign managers, right here on the feed — the knobs
// moved off the dashboard 2026-07-21). Checkbox edits bind straight into
// `settings`, so the show_* toggles preview live; Save persists and replays
// today so milestone lines match the new steps. ---

const auth = useAuthStore()
const canManage =
  auth.profile?.role === 'admin' || auth.profile?.role === 'campaign_manager'
const optionsOpen = ref(false)
const optionsSaving = ref(false)
const optionsSaved = ref(false)
const optionsError = ref('')

/** Whole numbers, 0 or more. ZERO IS MEANINGFUL: it switches that milestone
 * off (2026-07-25 — the DB CHECKs were relaxed to >= 0 to match). */
function cleanStep(n: number): number {
  return Math.max(0, Math.round(Number.isFinite(n) ? n : 0))
}

async function saveOptions() {
  const f = settings.value
  optionsSaving.value = true
  optionsError.value = ''
  const { error } = await supabase
    .from('activity_feed_settings')
    .update({
      show_knocks: f.show_knocks,
      show_signatures: f.show_signatures,
      person_milestones: f.person_milestones,
      person_door_step: cleanStep(f.person_door_step),
      person_knock_step: cleanStep(f.person_knock_step),
      squad_milestones: f.squad_milestones,
      squad_door_step: cleanStep(f.squad_door_step),
      squad_knock_step: cleanStep(f.squad_knock_step),
      squad_signature_step: cleanStep(f.squad_signature_step),
      team_milestones: f.team_milestones,
      team_door_step: cleanStep(f.team_door_step),
      team_signature_step: cleanStep(f.team_signature_step),
      updated_at: new Date().toISOString(),
    })
    .eq('id', true)
  optionsSaving.value = false
  if (error) {
    optionsError.value = 'Could not save. Try again.'
    return
  }
  optionsSaved.value = true
  setTimeout(() => (optionsSaved.value = false), 2000)
  await load()
}

// --- Day counters (module state, reset per load) ---
// Doors are DISTINCT households and signatures DISTINCT signed persons —
// the same semantics as squad progress and the door-status colors (the
// leaderboard's every-log "doors" count is deliberately looser).
const seenIds = new Set<string>()
const personDoors = new Map<string, Set<string>>()
// Attempt tallies (plain counts, not distinct sets) for the knock milestones.
const personKnocks = new Map<string, number>()
const squadKnocks = new Map<string, number>()
const squadDoors = new Map<string, Set<string>>()
const squadSigs = new Map<string, Set<string>>()
const teamDoors = new Set<string>()
const teamSigs = new Set<string>()
const doorsToday = ref(0)
const sigsToday = ref(0)

function resetCounters() {
  seenIds.clear()
  personDoors.clear()
  personKnocks.clear()
  squadKnocks.clear()
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
  // step 0 (or junk) = this milestone is switched off. Guarding here rather
  // than at each call site means a 0 can never reach the `% step` below,
  // where it would be NaN and quietly never fire — or, worse, fire on every
  // single row if the comparison were written the other way round.
  if (step < 1) return { size: set.size, crossed: false }
  return { size: set.size, crossed: set.size > before && set.size % step === 0 }
}

/** Knock milestones count ATTEMPTS, so unlike doors/signatures there's no
 * distinct set to grow — just a tally per key. Same 0-is-off rule. */
function tally(map: Map<string, number>, key: string, step: number): { n: number; crossed: boolean } {
  const n = (map.get(key) ?? 0) + 1
  map.set(key, n)
  if (step < 1) return { n, crossed: false }
  return { n, crossed: n % step === 0 }
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
    whoId: row.canvasser_id,
    avatar: row.canvasser?.avatar ?? null,
    color,
    outcome: row.outcome,
    personName: row.person?.name ?? null,
    street: row.address ? prettyStreet(row.address.street) : null,
  })

  // Knock-count milestones run off EVERY row, door or not — that's the point
  // of them (2026-07-25, user call).
  const pk = tally(personKnocks, row.canvasser_id, s.person_knock_step)
  if (s.person_milestones && pk.crossed) {
    out.push({
      kind: 'milestone',
      key: `pk-${row.canvasser_id}-${pk.n}`,
      at: row.occurred_at,
      scope: 'person',
      emoji: '👊',
      strong: who,
      rest: `has knocked ${pk.n} times today`,
      avatar: row.canvasser?.avatar ?? null,
      color,
      whoId: row.canvasser_id,
    })
  }
  if (row.squad_id && row.squad_name) {
    const qk = tally(squadKnocks, row.squad_id, s.squad_knock_step)
    if (s.squad_milestones && qk.crossed) {
      out.push({
        kind: 'milestone',
        key: `qk-${row.squad_id}-${qk.n}`,
        at: row.occurred_at,
        scope: 'squad',
        emoji: '👊',
        strong: row.squad_name,
        rest: `has knocked ${qk.n} times today`,
      })
    }
  }

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
        whoId: row.canvasser_id,
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
          rest: `is cooking, ${q.size} doors today`,
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
  // Its own trip, unawaited — the day's rows are what the page is for and
  // shouldn't wait on the campaign's arithmetic.
  void loadCampaignPace().then((p) => (pace.value = p))
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

/** The profile behind a row, when there is one person behind it — squad and
 * whole-team milestones have none. */
function whoIdOf(item: FeedItem): string | null {
  return item.kind === 'milestone' ? (item.whoId ?? null) : item.whoId
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

      <!-- …and how the day sits against the deadline. Renders only once the
           campaign has both a goal and a filing date. Carries its own totals:
           there's no goal bar on this page to read them off. -->
      <div v-if="pace" class="card pace-card">
        <CampaignPace
          compact
          with-totals
          :signatures="pace.signatures"
          :goal="pace.goal"
          :deadline="pace.deadline"
        />
      </div>

      <!-- Manager knobs live on the feed itself, not the dashboard. -->
      <div v-if="canManage" class="card options-card" data-help="feed-options">
        <button class="options-head" :aria-expanded="optionsOpen" @click="optionsOpen = !optionsOpen">
          <span>Feed options</span>
          <span class="options-caret" aria-hidden="true">{{ optionsOpen ? '▴' : '▾' }}</span>
        </button>
        <div v-if="optionsOpen" class="options-body">
          <label class="check">
            <input type="checkbox" v-model="settings.show_signatures" />
            Show each signature as it lands
          </label>
          <label class="check">
            <input type="checkbox" v-model="settings.show_knocks" />
            Show every knock too
          </label>
          <label class="check">
            <input type="checkbox" v-model="settings.person_milestones" />
            Personal milestones
          </label>
          <!-- 0 in any of these boxes switches that milestone off. -->
          <div v-if="settings.person_milestones" class="step-row">
            every <input type="number" min="0" v-model.number="settings.person_door_step" /> doors ·
            <input type="number" min="0" v-model.number="settings.person_knock_step" /> knocks
          </div>
          <label class="check">
            <input type="checkbox" v-model="settings.squad_milestones" />
            Squad milestones
          </label>
          <div v-if="settings.squad_milestones" class="step-row">
            every <input type="number" min="0" v-model.number="settings.squad_door_step" /> doors ·
            <input type="number" min="0" v-model.number="settings.squad_knock_step" /> knocks ·
            <input type="number" min="0" v-model.number="settings.squad_signature_step" /> signatures
          </div>
          <label class="check">
            <input type="checkbox" v-model="settings.team_milestones" />
            Whole-team milestones
          </label>
          <div v-if="settings.team_milestones" class="step-row">
            every <input type="number" min="0" v-model.number="settings.team_door_step" /> doors ·
            <input type="number" min="0" v-model.number="settings.team_signature_step" /> signatures
          </div>
          <div class="options-actions">
            <button class="btn btn-primary btn-sm" :disabled="optionsSaving" @click="saveOptions">
              {{ optionsSaved ? 'Saved ✓' : optionsSaving ? 'Saving…' : 'Save' }}
            </button>
          </div>
          <p v-if="optionsError" class="error options-error">{{ optionsError }}</p>
        </div>
      </div>

      <p v-if="loading" class="muted state">Loading today's activity…</p>
      <p v-else-if="loadError" class="error state">
        Couldn't load the feed. Check the connection and reload.
      </p>
      <p v-else-if="!visible.length" class="muted state">
        Nothing yet today. The first knock lights this up.
      </p>

      <ul v-else class="feed" data-help="feed-list">
        <li
          v-for="(item, i) in visible"
          :key="item.key"
          v-motion="fadeUp(Math.min(i, 6) * 30)"
          class="row"
          :class="item.kind === 'milestone' ? `milestone milestone-${item.scope}` : item.kind"
        >
          <!-- Event rows + personal milestones lead with the canvasser, and
               both the face and the name open their profile. -->
          <component
            :is="whoIdOf(item) ? 'router-link' : 'span'"
            v-if="item.kind !== 'milestone' || item.scope === 'person'"
            :to="whoIdOf(item) ? { name: 'member', params: { id: whoIdOf(item) } } : undefined"
            class="row-avatar"
            :style="{ borderColor: item.color, background: avatarUrl(item.avatar ?? null) ? 'var(--surface)' : item.color }"
          >
            <img v-if="avatarUrl(item.avatar ?? null)" :src="avatarUrl(item.avatar ?? null)" alt="" />
            <template v-else>{{ (item.kind === 'milestone' ? item.strong : item.who).slice(0, 1).toUpperCase() }}</template>
          </component>
          <span v-else class="row-emoji" aria-hidden="true">{{ item.emoji }}</span>

          <span class="row-main">
            <template v-if="item.kind === 'signature'">
              <span class="row-what">
                <router-link class="who-link" :to="{ name: 'member', params: { id: item.whoId } }">{{ item.who }}</router-link>
                got {{ item.personName ? `${item.personName}'s` : 'a' }} signature
              </span>
              <span class="muted row-meta">
                {{ item.street ? item.street + ' · ' : '' }}{{ timeOf(item.at) }}
              </span>
            </template>
            <template v-else-if="item.kind === 'knock'">
              <span class="row-what">
                <router-link class="who-link" :to="{ name: 'member', params: { id: item.whoId } }">{{ item.who }}</router-link>
                <span class="outcome-chip" :style="{ color: OUTCOME_HEX[item.outcome] }">
                  <span class="outcome-dot" :style="{ background: OUTCOME_HEX[item.outcome] }"></span>
                  {{ OUTCOME_SHORT[item.outcome] }}</span
                >{{ item.personName ? ' · ' + item.personName : '' }}
              </span>
              <span class="muted row-meta">
                {{ item.street ? item.street + ' · ' : '' }}{{ timeOf(item.at) }}
              </span>
            </template>
            <template v-else>
              <span class="row-what">
                <span v-if="ms(item).scope === 'person'" class="row-inline-emoji" aria-hidden="true">{{ ms(item).emoji }}</span>
                <router-link
                  v-if="ms(item).whoId"
                  class="who-link"
                  :to="{ name: 'member', params: { id: ms(item).whoId } }"
                  >{{ ms(item).strong }}</router-link
                >
                <strong v-else>{{ ms(item).strong }}</strong> {{ ms(item).rest }}
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
/* The feed scrolls ONE way — down (2026-07-24, user call). Nothing here is
   wide enough to be worth a sideways scroll, and at larger text sizes a
   single long word used to push the whole page off screen. Every row is
   allowed to wrap instead; min-width:0 lets flex children actually shrink,
   which is what makes the wrapping possible. */
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
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
  flex-wrap: wrap;
}

.totals-text {
  font-size: 0.95rem;
}

/* Sits right under the day's two numbers, tighter than a full card — it's a
   line of context, not a section. */
.pace-card {
  padding: 0.6rem 0.9rem;
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

/* --- Feed options (manager-only collapsible card) --- */

.options-card {
  padding: 0;
}

.options-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.7rem 0.9rem;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.options-caret {
  color: var(--text-muted);
}

.options-body {
  padding: 0 0.9rem 0.9rem;
}

.check {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.92rem;
  margin: 0.35rem 0 0.75rem;
}

.check input {
  width: auto;
}

/* Indented "every N doors" rows under their milestone toggle. */
.step-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: -0.45rem 0 0.75rem 1.75rem;
  font-size: 0.88rem;
  color: var(--text-muted);
}

.step-row input {
  width: 4.2em;
  padding: 0.25rem 0.4rem;
  font: inherit;
  font-size: 0.88rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}

.options-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.options-error {
  margin: 0.5rem 0 0;
  font-size: 0.9rem;
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

/* The name is the way to the person (2026-07-25). Styled like the bold text
   it replaced rather than like a link — the whole feed would turn blue. */
.who-link {
  font-weight: 700;
  color: inherit;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
}

.who-link:hover,
.who-link:focus-visible {
  text-decoration: underline;
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
  flex: 1 1 auto;
}

.row-what {
  font-size: 0.94rem;
  overflow-wrap: anywhere;
}

.row-meta {
  font-size: 0.78rem;
  overflow-wrap: anywhere;
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
