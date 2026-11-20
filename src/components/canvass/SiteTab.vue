<script setup lang="ts">
// Site mode (2026-11-20, user call: "Talk, map, and site. The site mode is
// like talk mode, but it doesn't have the next house stuff on there… it's not
// concerned with addresses or notes").
//
// How a site actually works: somebody walks up, you look their name up on the
// voter roll, and what you find decides the rest. On the roll: they are
// already registered, or their details need updating. Not on the roll: you
// register them, or they are not eligible, or they would rather not.
//
// So this is a name search and a handful of buttons. No door, no roster, no
// walk order, no notes. Each log is one row in registration_logs against the
// site (and today's shift there, when there is one). A person found on the
// roll is kept on the row as a pointer (`person_id`); somebody who is not on
// the roll leaves nothing behind but the count, because nothing about the
// form is ever stored.
import { computed, nextTick, ref, watch } from 'vue'
import { supabase } from '@/lib/supabase'
import { localToday, startOfLocalDayISO } from '@/lib/day'
import { hapticTap } from '@/lib/native'
import { useAuthStore } from '@/stores/auth'
import {
  REG_HEX,
  REG_LABELS,
  fetchShifts,
  shiftTimeLabel,
  type RegResult,
  type SiteShift,
} from '@/lib/registration'

const props = defineProps<{ active: boolean }>()

const auth = useAuthStore()

// ------------------------------------------------------------- which site

interface Place {
  /** `shift:<id>` or `site:<id>`: one value for the picker. */
  key: string
  siteId: string
  shiftId: string | null
  label: string
  mine: boolean
}

const places = ref<Place[]>([])
const placeKey = ref('')
const loadingPlaces = ref(true)
const place = computed(() => places.value.find((p) => p.key === placeKey.value) ?? null)

async function loadPlaces() {
  const cid = auth.profile?.campaign_id
  const me = auth.profile?.id
  if (!cid || !me) return
  loadingPlaces.value = true
  try {
    const today = localToday()
    const [shifts, sites] = await Promise.all([
      fetchShifts('upcoming', today).then((all) => all.filter((s) => s.shift_date === today)),
      supabase
        .from('sites')
        .select('id, name')
        .eq('campaign_id', cid)
        .order('name')
        .then(({ data }) => (data ?? []) as { id: string; name: string }[]),
    ])
    const fromShift = (s: SiteShift): Place => ({
      key: `shift:${s.id}`,
      siteId: s.site_id,
      shiftId: s.id,
      label: shiftTimeLabel(s) ? `${s.site.name}, ${shiftTimeLabel(s)}` : s.site.name,
      mine: s.members.some((m) => m.id === me),
    })
    const today_ = shifts.map(fromShift).sort((a, b) => Number(b.mine) - Number(a.mine))
    const scheduled = new Set(shifts.map((s) => s.site_id))
    const rest: Place[] = sites
      .filter((s) => !scheduled.has(s.id))
      .map((s) => ({ key: `site:${s.id}`, siteId: s.id, shiftId: null, label: s.name, mine: false }))
    places.value = [...today_, ...rest]
    // Keep the pick if it is still there; otherwise the shift you are on.
    if (!places.value.some((p) => p.key === placeKey.value)) placeKey.value = places.value[0]?.key ?? ''
  } finally {
    loadingPlaces.value = false
  }
}

// ------------------------------------------------------------ today here

interface Entry {
  id: string
  result: RegResult
  mine: boolean
  name: string | null
  at: string
}
const entries = ref<Entry[]>([])

let entrySeq = 0
async function loadEntries() {
  const p = place.value
  if (!p) {
    entries.value = []
    return
  }
  const mine = ++entrySeq
  const { data } = await supabase
    .from('registration_logs')
    .select('id, result, canvasser_id, occurred_at, person:persons(name)')
    .eq('site_id', p.siteId)
    .gte('occurred_at', startOfLocalDayISO())
    .order('occurred_at', { ascending: false })
    .limit(300)
  if (mine !== entrySeq) return
  entries.value = ((data ?? []) as unknown as {
    id: string
    result: RegResult
    canvasser_id: string
    occurred_at: string
    person: { name: string } | null
  }[]).map((r) => ({
    id: r.id,
    result: r.result,
    mine: r.canvasser_id === auth.profile?.id,
    name: r.person?.name ?? null,
    at: r.occurred_at,
  }))
}

const registeredToday = computed(
  () => entries.value.filter((e) => e.result === 'registered' || e.result === 'updated').length,
)
/** The one you can take back: your own most recent. */
const lastMine = computed(() => entries.value.find((e) => e.mine) ?? null)

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// ------------------------------------------------------------ name lookup

interface Hit {
  id: string
  name: string
  city: string | null
}

const query = ref('')
const hits = ref<Hit[]>([])
const searching = ref(false)
/** A person off the roll, or 'new' for somebody who is not on it. */
const picked = ref<Hit | 'new' | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)

let timer: ReturnType<typeof setTimeout> | undefined
watch(query, (raw) => {
  clearTimeout(timer)
  picked.value = null
  const q = raw.trim()
  if (q.length < 2) {
    hits.value = []
    searching.value = false
    return
  }
  searching.value = true
  timer = setTimeout(async () => {
    const { data } = await supabase
      .from('persons')
      .select('id, name, addresses(city)')
      .ilike('name', `%${q}%`)
      .order('name')
      .limit(12)
    // A newer keystroke has taken over.
    if (query.value.trim() !== q) return
    hits.value = ((data ?? []) as unknown as { id: string; name: string; addresses: { city: string } | null }[]).map(
      (p) => ({ id: p.id, name: p.name, city: p.addresses?.city ?? null }),
    )
    searching.value = false
  }, 250)
})

/** What can be logged depends on what the lookup found. */
const choices = computed<RegResult[]>(() =>
  picked.value === 'new'
    ? ['registered', 'not_eligible', 'declined']
    : picked.value
      ? ['already_registered', 'updated', 'declined']
      : [],
)

// ---------------------------------------------------------------- logging

const error = ref('')
const saving = ref(false)

async function log(result: RegResult) {
  const p = place.value
  const who = picked.value
  if (!p || !who || !auth.profile || saving.value) return
  hapticTap('medium')
  saving.value = true
  error.value = ''
  const { data, error: e } = await supabase
    .from('registration_logs')
    .insert({
      canvasser_id: auth.profile.id,
      site_id: p.siteId,
      shift_id: p.shiftId,
      person_id: who === 'new' ? null : who.id,
      result,
    })
    .select('id, occurred_at')
    .single()
  saving.value = false
  if (e || !data) {
    error.value = 'That one didn’t save. Tap it again.'
    return
  }
  entries.value = [
    {
      id: data.id as string,
      result,
      mine: true,
      name: who === 'new' ? null : who.name,
      at: data.occurred_at as string,
    },
    ...entries.value,
  ]
  // Ready for the next person walking up.
  query.value = ''
  picked.value = null
  void nextTick(() => searchEl.value?.focus())
}

async function undo() {
  const last = lastMine.value
  if (!last) return
  hapticTap('light')
  error.value = ''
  const before = entries.value
  entries.value = before.filter((e) => e.id !== last.id)
  const { error: e } = await supabase.from('registration_logs').delete().eq('id', last.id)
  if (e) {
    entries.value = before
    error.value = 'Couldn’t undo. Try again.'
  }
}

// ------------------------------------------------------------------ wiring

// The tab is v-show'd inside a kept-alive page, so "arriving" is the prop
// going true, not a mount.
watch(
  () => [props.active, auth.profile?.campaign_id] as const,
  ([on]) => {
    if (on) void loadPlaces()
  },
  { immediate: true },
)
watch(placeKey, () => void loadEntries())
watch(
  () => props.active,
  (on) => {
    if (on && placeKey.value) void loadEntries()
  },
)
</script>

<template>
  <div class="site-tab">
    <p v-if="loadingPlaces && !places.length" class="muted">Loading…</p>
    <p v-else-if="!places.length" class="card muted">No sites yet.</p>

    <template v-else>
      <div class="card where" data-help="site-pick">
        <label class="where-label" for="site-place">Site</label>
        <select id="site-place" v-model="placeKey" class="where-select">
          <option v-for="p in places" :key="p.key" :value="p.key">{{ p.label }}</option>
        </select>
        <span class="count">
          <span class="count-n">{{ registeredToday }}</span> registered here today
        </span>
      </div>

      <div class="card lookup" data-help="site-search">
        <input
          ref="searchEl"
          v-model="query"
          class="name-search"
          type="search"
          placeholder="Look up a name"
          autocomplete="off"
          aria-label="Look up a name on the voter roll"
        />

        <template v-if="query.trim().length >= 2 && !picked">
          <p v-if="searching && !hits.length" class="muted small">Searching…</p>
          <ul v-else class="hits">
            <li v-for="h in hits" :key="h.id">
              <button class="hit" type="button" @click="picked = h">
                <span class="hit-name">{{ h.name }}</span>
                <span v-if="h.city" class="muted small">{{ h.city }}</span>
              </button>
            </li>
          </ul>
          <button class="btn not-on-roll" type="button" @click="picked = 'new'">Not on the roll</button>
        </template>

        <div v-if="picked" class="picked">
          <div class="picked-head">
            <span class="picked-name">{{ picked === 'new' ? query.trim() : picked.name }}</span>
            <span class="pill" :class="{ off: picked === 'new' }">
              {{ picked === 'new' ? 'Not on the roll' : 'On the roll' }}
            </span>
            <button class="btn btn-sm" type="button" @click="picked = null">Back</button>
          </div>
          <div class="results">
            <button
              v-for="r in choices"
              :key="r"
              class="btn result-btn"
              type="button"
              :disabled="saving"
              :style="{ '--result-color': REG_HEX[r] }"
              @click="log(r)"
            >
              {{ REG_LABELS[r] }}
            </button>
          </div>
        </div>

        <p v-if="error" class="error-line">{{ error }}</p>
      </div>

      <div class="card today" data-help="site-today">
        <div class="today-head">
          <span class="today-title">Today here</span>
          <button class="btn btn-sm" type="button" :disabled="!lastMine" @click="undo">Undo my last</button>
        </div>
        <p v-if="!entries.length" class="muted small">Nothing logged yet.</p>
        <ul v-else class="entries">
          <li v-for="e in entries" :key="e.id" class="entry">
            <span class="dot" :style="{ background: REG_HEX[e.result] }" />
            <span class="entry-main">
              {{ REG_LABELS[e.result] }}<template v-if="e.name">: {{ e.name }}</template>
            </span>
            <span class="muted small">{{ clock(e.at) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.site-tab {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.small {
  font-size: 0.82rem;
}
.where {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.where-label {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text-muted);
}
.where-select {
  width: 100%;
  min-height: 44px;
}
.count {
  font-size: 0.9rem;
  color: var(--text-muted);
}
.count-n {
  font-size: 1.3rem;
  font-weight: 800;
  color: var(--text);
}
.lookup {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.name-search {
  width: 100%;
  min-height: 48px;
}
.hits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.hit {
  appearance: none;
  width: 100%;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
  min-height: 46px;
  padding: 0.5rem 0.2rem;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  text-align: left;
  white-space: normal;
  cursor: pointer;
}
.hit-name {
  font-weight: 700;
}
.not-on-roll {
  min-height: 46px;
  font-weight: 700;
  border-style: dashed;
}
.picked {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.picked-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.picked-name {
  font-size: 1.1rem;
  font-weight: 800;
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.pill {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, #2e9e5b 18%, var(--surface));
  border: 1px solid #2e9e5b;
  white-space: nowrap;
}
.pill.off {
  background: color-mix(in srgb, #e0a02e 18%, var(--surface));
  border-color: #e0a02e;
}
.results {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.45rem;
}
.result-btn {
  min-height: 56px;
  font-size: 1.05rem;
  font-weight: 800;
  border: 2px solid var(--result-color);
  background: color-mix(in srgb, var(--result-color) 20%, var(--surface));
  color: var(--text);
}
.error-line {
  margin: 0;
  color: var(--danger);
  font-size: 0.88rem;
}
.today {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
.today-title {
  font-weight: 800;
}
.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--border);
}
.entry:last-child {
  border-bottom: none;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: 0 0 auto;
}
.entry-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
