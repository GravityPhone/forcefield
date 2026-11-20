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
//
// BOTH KINDS OF CAMPAIGN HAVE THIS TAB (2026-11-20, user call: "we could put a
// sites mode on the petition side… it almost shows up more like a door, but
// it's its own category in the code"). A petition is worked from a table too.
// There the lookup ends in Signed or Not Interested, and the row is a
// knock_logs row carrying `site_id`: a signature like any other (it counts
// wherever signatures count, and the signer's own door stops being asked), but
// one that says it happened at a site and not on a porch. Only somebody on the
// roll can sign, so a petition has no "Not on the roll" branch.
//
// NOT EVERYBODY IN THE FILE IS REGISTERED (2026-11-20, user call: "make a
// certain percentage of the whole populace not registered"). `persons.
// registered_voter` says which, and in a registration campaign it decides the
// buttons: a registered person is Already registered / Updated / Declined; a
// person who is in the file but NOT registered is the one you are here for,
// Registered / Not eligible / Declined, and the row keeps the pointer to them.
// Somebody registered through this app (a 'registered' row naming them) reads
// as registered from then on; that is derived on lookup, never written back
// to the file. "Not on the roll" stays for a name the file has never heard of.
//
// THE SITE IS NEVER A QUESTION YOU HAVE TO ANSWER FIRST (same call: "it
// automatically associates whatever you're doing with a site"). The tab opens
// already on a site: the shift you are on right now, else a shift of yours
// today, else the site you used last, else the first one. The picker is for
// changing it, and the change is remembered.
import { computed, nextTick, ref, watch } from 'vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { supabase } from '@/lib/supabase'
import { localToday, startOfLocalDayISO } from '@/lib/day'
import { hapticTap } from '@/lib/native'
import { useAuthStore } from '@/stores/auth'
import { OUTCOME_HEX, OUTCOME_LABELS } from '@/lib/outcomes'
import {
  REG_HEX,
  REG_LABELS,
  campaignMode,
  fetchShifts,
  shiftTimeLabel,
  type RegResult,
  type SiteShift,
} from '@/lib/registration'

const props = defineProps<{ active: boolean }>()

const auth = useAuthStore()

/** Registration campaigns log a registration result; petitions log a knock
 * outcome against the site. Everything else about the tab is shared. */
const reg = computed(() => campaignMode.value === 'registration')
type SiteResult = RegResult | 'signed' | 'didnt_sign'
const labelOf = (r: SiteResult) =>
  r === 'signed' || r === 'didnt_sign' ? OUTCOME_LABELS[r] : REG_LABELS[r]
const hexOf = (r: SiteResult) => (r === 'signed' || r === 'didnt_sign' ? OUTCOME_HEX[r] : REG_HEX[r])
const canAddSite = computed(() => auth.profile?.role === 'campaign_manager' || auth.profile?.role === 'admin')

const pickKey = () => `forcefield.site_pick.${auth.profile?.campaign_id ?? ''}`
function rememberedPick(): string {
  try {
    return localStorage.getItem(pickKey()) ?? ''
  } catch {
    return ''
  }
}

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
    // Yours first, and of yours the one happening right now.
    const now = new Date().toTimeString().slice(0, 8)
    const rank = (s: SiteShift) =>
      (s.members.some((m) => m.id === me) ? 2 : 0) +
      ((s.start_time ?? '00:00:00') <= now && now <= (s.end_time ?? '23:59:59') ? 1 : 0)
    const today_ = [...shifts].sort((a, b) => rank(b) - rank(a)).map(fromShift)
    const scheduled = new Set(shifts.map((s) => s.site_id))
    const rest: Place[] = sites
      .filter((s) => !scheduled.has(s.id))
      .map((s) => ({ key: `site:${s.id}`, siteId: s.id, shiftId: null, label: s.name, mine: false }))
    places.value = [...today_, ...rest]
    // Keep the pick if it is still there. Otherwise your own shift today,
    // else the site used last on this phone, else the first one.
    if (!places.value.some((p) => p.key === placeKey.value)) {
      const first = places.value[0]
      const last = places.value.find((p) => p.key === rememberedPick())
      placeKey.value = (first?.mine ? first : (last ?? first))?.key ?? ''
    }
  } finally {
    loadingPlaces.value = false
  }
}

// ------------------------------------------------------------ today here

interface Entry {
  id: string
  result: SiteResult
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
    .from(reg.value ? 'registration_logs' : 'knock_logs')
    .select(
      reg.value
        ? 'id, result, canvasser_id, occurred_at, person:persons(name)'
        : 'id, result:outcome, canvasser_id, occurred_at, person:persons(name)',
    )
    .eq('site_id', p.siteId)
    .gte('occurred_at', startOfLocalDayISO())
    .order('occurred_at', { ascending: false })
    .limit(300)
  if (mine !== entrySeq) return
  entries.value = ((data ?? []) as unknown as {
    id: string
    result: SiteResult
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
  () =>
    entries.value.filter((e) => e.result === 'registered' || e.result === 'updated' || e.result === 'signed')
      .length,
)
/** The one you can take back: your own most recent. */
const lastMine = computed(() => entries.value.find((e) => e.mine) ?? null)

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// ------------------------------------------------------------ name lookup

interface Hit {
  id: string
  name: string
  city: string | null
  /** Their registered household: where a petition signature is filed. */
  householdId: string | null
  /** Registered to vote: the file says so, or this app registered them. */
  registered: boolean
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
      .select('id, name, household_id, registered_voter, addresses(city)')
      .ilike('name', `%${q}%`)
      .order('name')
      .limit(12)
    // A newer keystroke has taken over.
    if (query.value.trim() !== q) return
    const found: Hit[] = ((data ?? []) as unknown as {
      id: string
      name: string
      household_id: string | null
      registered_voter: boolean
      addresses: { city: string } | null
    }[]).map((p) => ({
      id: p.id,
      name: p.name,
      city: p.addresses?.city ?? null,
      householdId: p.household_id,
      registered: p.registered_voter,
    }))
    // Anyone the file calls unregistered may have been registered since,
    // through this app. One small read for the handful on screen.
    const open = found.filter((h) => !h.registered).map((h) => h.id)
    if (reg.value && open.length) {
      const { data: done } = await supabase
        .from('registration_logs')
        .select('person_id')
        .eq('result', 'registered')
        .in('person_id', open)
      const since = new Set(((done ?? []) as { person_id: string }[]).map((r) => r.person_id))
      for (const h of found) if (since.has(h.id)) h.registered = true
    }
    if (query.value.trim() !== q) return
    hits.value = found
    searching.value = false
  }, 250)
})

/** What can be logged depends on what the lookup found. */
const choices = computed<SiteResult[]>(() => {
  if (!picked.value) return []
  if (!reg.value) return picked.value === 'new' ? [] : ['signed', 'didnt_sign']
  return picked.value === 'new' || !picked.value.registered
    ? ['registered', 'not_eligible', 'declined']
    : ['already_registered', 'updated', 'declined']
})

// ---------------------------------------------------------------- logging

const error = ref('')
const saving = ref(false)

async function log(result: SiteResult) {
  const p = place.value
  const who = picked.value
  if (!p || !who || !auth.profile || saving.value) return
  hapticTap('medium')
  saving.value = true
  error.value = ''
  const { data, error: e } =
    result === 'signed' || result === 'didnt_sign'
      ? await supabase
          .from('knock_logs')
          .insert({
            client_id: crypto.randomUUID(),
            canvasser_id: auth.profile.id,
            site_id: p.siteId,
            person_id: who === 'new' ? null : who.id,
            household_id: who === 'new' ? null : who.householdId,
            outcome: result,
          })
          .select('id, occurred_at')
          .single()
      : await supabase
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
  const petition = last.result === 'signed' || last.result === 'didnt_sign'
  const { error: e } = await supabase
    .from(petition ? 'knock_logs' : 'registration_logs')
    .delete()
    .eq('id', last.id)
  if (e) {
    entries.value = before
    error.value = 'Couldn’t undo. Try again.'
  }
}

// ------------------------------------------------------------ a new site
//
// Managers only (RLS agrees). A petition has no Sites page to make one on,
// and at a table the place you are standing is sometimes not on the list yet.

const adding = ref(false)
const newSite = ref('')
async function addSite() {
  const name = newSite.value.trim()
  const cid = auth.profile?.campaign_id
  if (!name || !cid || saving.value) return
  saving.value = true
  error.value = ''
  const { data, error: e } = await supabase
    .from('sites')
    .insert({ campaign_id: cid, name, created_by: auth.profile?.id })
    .select('id')
    .single()
  saving.value = false
  if (e || !data) {
    error.value = 'Couldn’t add that site.'
    return
  }
  adding.value = false
  newSite.value = ''
  await loadPlaces()
  placeKey.value = `site:${data.id as string}`
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
watch(placeKey, (key) => {
  if (key) {
    try {
      localStorage.setItem(pickKey(), key)
    } catch {
      /* private window: the pick just is not remembered */
    }
  }
  void loadEntries()
})
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
    <div v-else-if="!places.length" class="card where field">
      <p class="muted">No sites yet.</p>
      <template v-if="canAddSite">
        <input v-model="newSite" type="text" placeholder="Site name" aria-label="Site name" @keyup.enter="addSite" />
        <button class="btn btn-primary" type="button" :disabled="!newSite.trim() || saving" @click="addSite">
          Add site
        </button>
      </template>
      <p v-if="error" class="error-line">{{ error }}</p>
    </div>

    <template v-else>
      <div class="card where" data-help="site-pick">
        <div class="where-row">
          <AppSelect v-model="placeKey" :options="places.map((p) => ({ value: p.key, label: p.label }))" />
          <button v-if="canAddSite" class="btn btn-sm" type="button" @click="adding = !adding">
            {{ adding ? 'Cancel' : 'New site' }}
          </button>
        </div>
        <div v-if="adding" class="where-row field">
          <input v-model="newSite" type="text" placeholder="Site name" aria-label="Site name" @keyup.enter="addSite" />
          <button class="btn btn-primary btn-sm" type="button" :disabled="!newSite.trim() || saving" @click="addSite">
            Add
          </button>
        </div>
        <span class="count">
          <span class="count-n">{{ registeredToday }}</span> {{ reg ? 'registered' : 'signed' }} here today
        </span>
      </div>

      <div class="card lookup field" data-help="site-search">
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
                <span class="hit-side">
                  <span v-if="reg && !h.registered" class="pill off">Not registered</span>
                  <span v-if="h.city" class="muted small">{{ h.city }}</span>
                </span>
              </button>
            </li>
          </ul>
          <button v-if="reg" class="btn not-on-roll" type="button" @click="picked = 'new'">Not on the roll</button>
          <p v-else-if="!searching && !hits.length" class="muted small">Not on the roll.</p>
        </template>

        <div v-if="picked" class="picked">
          <div class="picked-head">
            <span class="picked-name">{{ picked === 'new' ? query.trim() : picked.name }}</span>
            <span class="pill" :class="{ off: picked === 'new' || (reg && !picked.registered) }">
              {{ picked === 'new' ? 'Not on the roll' : !reg ? 'On the roll' : picked.registered ? 'Registered' : 'Not registered' }}
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
              :style="{ '--result-color': hexOf(r) }"
              @click="log(r)"
            >
              {{ labelOf(r) }}
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
            <span class="dot" :style="{ background: hexOf(e.result) }" />
            <span class="entry-main">
              {{ labelOf(e.result) }}<template v-if="e.name">: {{ e.name }}</template>
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
.where-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.where-row > :first-child {
  flex: 1 1 auto;
  min-width: 0;
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
.hit-side {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
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
