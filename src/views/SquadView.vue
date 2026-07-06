<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { fadeUp } from '@/lib/motion'
import { supabase } from '@/lib/supabase'
import { loadMaps, mapsAuthError } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import { TurfAreasLayer } from '@/lib/mapLayers'
import type { DoorPoint } from '@/lib/mapLayers'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import type { ChatProfile, KnockLog } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }

const auth = useAuthStore()
const chat = useChatStore()
const squads = useSquadsStore()

// --- Which squad is "mine" (you can be in several crews in one day) ---

const selectedSquadId = ref<string | null>(null)
const mySquad = computed<SquadListItem | null>(() => {
  const mine = squads.mySquads
  return mine.find((s) => s.id === selectedSquadId.value) ?? mine[0] ?? null
})

// --- Dashboard data ---

interface TurfLite {
  id: string
  name: string
  color: string
  squad_id: string | null
  assignee_id: string | null
}

interface TurfDoor {
  id: string
  street: string
  lat: number | null
  lng: number | null
  turf_id: string
}

interface RecentDoor {
  addressId: string
  street: string
  lat: number | null
  lng: number | null
  occurredAt: string
}

const squadTurfs = ref<TurfLite[]>([])
const turfDoors = ref<Map<string, TurfDoor>>(new Map())
/** Distinct turf doors with at least one knock (any time, any member). */
const knockedDoors = ref<Set<string>>(new Set())
/** member id -> distinct turf doors that member has knocked. */
const knockedByMember = ref<Map<string, Set<string>>>(new Map())
/** member id -> their latest knocked doors, newest first, deduped, max 5. */
const recentByMember = ref<Map<string, RecentDoor[]>>(new Map())
const selectedMemberId = ref<string | null>(null)
const dashboardLoading = ref(false)

const memberIdSet = computed(() => new Set(mySquad.value?.members.map((m) => m.id) ?? []))
const turfIdSet = computed(() => new Set(squadTurfs.value.map((t) => t.id)))

/** Yourself first, then everyone else alphabetically — your own card is the
 * one you check most. */
const orderedMembers = computed<ChatProfile[]>(() => {
  const me = auth.profile?.id
  const members = [...(mySquad.value?.members ?? [])]
  members.sort((a, b) => {
    if (a.id === me) return -1
    if (b.id === me) return 1
    return (a.display_name || a.username).localeCompare(b.display_name || b.username)
  })
  return members
})

const doorsTotal = computed(() => turfDoors.value.size)
const doorsKnocked = computed(() => knockedDoors.value.size)
const progressPct = computed(() =>
  doorsTotal.value ? Math.round((doorsKnocked.value / doorsTotal.value) * 100) : 0,
)

/** Guards against an older async load landing after a newer one. */
let loadSeq = 0

async function loadDashboard() {
  const squad = mySquad.value
  if (!squad) return
  const seq = ++loadSeq
  dashboardLoading.value = true
  const memberIds = squad.members.map((m) => m.id)

  // Squad turf = assigned to the squad itself, or to any member directly —
  // same "your crew's assignment" definition the Hunt map opens framed on.
  const { data: turfData } = await supabase
    .from('turfs')
    .select('id, name, color, squad_id, assignee_id')
  const mine = ((turfData ?? []) as TurfLite[]).filter(
    (t) => t.squad_id === squad.id || (t.assignee_id !== null && memberIds.includes(t.assignee_id)),
  )
  const turfIds = mine.map((t) => t.id)

  const [doorsRes, knocksRes, ...recentRes] = await Promise.all([
    turfIds.length
      ? supabase
          .from('addresses')
          .select('id, street, lat, lng, turf_id')
          .in('turf_id', turfIds)
          .limit(10000)
      : Promise.resolve({ data: [] as TurfDoor[] }),
    turfIds.length
      ? supabase
          .from('knock_logs')
          .select('household_id, canvasser_id, addresses!inner(turf_id)')
          .in('addresses.turf_id', turfIds)
          .not('household_id', 'is', null)
          .limit(20000)
      : Promise.resolve({ data: [] as { household_id: string; canvasser_id: string }[] }),
    // Last doors each member touched — anywhere, not just in turf, so the
    // card always answers "where are they right now". Overfetch then dedupe
    // (re-knocking the same door shouldn't eat the whole list).
    ...memberIds.map((id) =>
      supabase
        .from('knock_logs')
        .select('occurred_at, addresses!inner(id, street, lat, lng)')
        .eq('canvasser_id', id)
        .order('occurred_at', { ascending: false })
        .limit(15),
    ),
  ])
  if (seq !== loadSeq) return

  squadTurfs.value = mine
  turfDoors.value = new Map(
    ((doorsRes.data ?? []) as TurfDoor[]).map((d) => [d.id, d]),
  )

  const knocked = new Set<string>()
  const byMember = new Map<string, Set<string>>()
  for (const row of (knocksRes.data ?? []) as unknown as {
    household_id: string
    canvasser_id: string
  }[]) {
    knocked.add(row.household_id)
    if (memberIds.includes(row.canvasser_id)) {
      let set = byMember.get(row.canvasser_id)
      if (!set) byMember.set(row.canvasser_id, (set = new Set()))
      set.add(row.household_id)
    }
  }
  knockedDoors.value = knocked
  knockedByMember.value = byMember

  const recents = new Map<string, RecentDoor[]>()
  memberIds.forEach((id, i) => {
    type Row = { occurred_at: string; addresses: { id: string; street: string; lat: number | null; lng: number | null } }
    const rows = ((recentRes[i]?.data ?? []) as unknown as Row[])
    const seen = new Set<string>()
    const list: RecentDoor[] = []
    for (const r of rows) {
      if (seen.has(r.addresses.id)) continue
      seen.add(r.addresses.id)
      list.push({
        addressId: r.addresses.id,
        street: r.addresses.street,
        lat: r.addresses.lat,
        lng: r.addresses.lng,
        occurredAt: r.occurred_at,
      })
      if (list.length === 5) break
    }
    recents.set(id, list)
  })
  recentByMember.value = recents
  dashboardLoading.value = false
  applyMapData(true)
}

// --- Map ---

const mapEl = ref<HTMLElement | null>(null)
const mapCardEl = ref<HTMLElement | null>(null)
let map: google.maps.Map | null = null
let areasLayer: TurfAreasLayer | null = null
const markersByMember = new Map<string, google.maps.marker.AdvancedMarkerElement>()
const mapFailed = ref(false)

let mapInitBusy = false

async function initMap() {
  if (mapInitBusy) return
  mapInitBusy = true
  try {
    await loadMaps()
  } catch {
    mapFailed.value = true
    mapInitBusy = false
    return
  }
  const el = mapEl.value
  // No element (squad state changed while the API loaded) or this element is
  // already live — nothing to do. Leaving and rejoining a squad remounts the
  // div, so "already have a map" isn't enough: it must be THIS div's map.
  if (!el || (map && map.getDiv() === el)) {
    mapInitBusy = false
    return
  }
  areasLayer?.dispose()
  for (const marker of markersByMember.values()) marker.map = null
  markersByMember.clear()
  map = new google.maps.Map(el, {
    center: FALLBACK_CENTER,
    zoom: 13,
    // Vector map — required for AdvancedMarker avatar pins.
    mapId: GOOGLE_MAPS_MAP_ID,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
  })
  areasLayer = new TurfAreasLayer(map)
  applyMapData(true)
}

/** Push current turf + member data onto the map (idempotent — safe to call
 * whenever either the map or the data finishes loading first). */
function applyMapData(refit = false) {
  if (!map || !areasLayer) return

  const doorsByTurf = new Map<string, DoorPoint[]>()
  for (const d of turfDoors.value.values()) {
    if (d.lat == null || d.lng == null) continue
    const list = doorsByTurf.get(d.turf_id)
    const door = { lat: d.lat, lng: d.lng, street: d.street }
    if (list) list.push(door)
    else doorsByTurf.set(d.turf_id, [door])
  }
  void areasLayer.setTurfs(
    squadTurfs.value
      .filter((t) => doorsByTurf.has(t.id))
      .map((t) => ({ id: t.id, color: t.color, doors: doorsByTurf.get(t.id)!, emphasis: true })),
  )

  // One avatar marker per member, sitting on their last geocoded knock.
  const members = mySquad.value?.members ?? []
  const alive = new Set(members.map((m) => m.id))
  for (const [id, marker] of markersByMember) {
    if (!alive.has(id)) {
      marker.map = null
      markersByMember.delete(id)
    }
  }
  for (const m of members) updateMemberMarker(m)

  if (refit) fitToSquad()
}

function latestGeo(memberId: string): RecentDoor | null {
  for (const r of recentByMember.value.get(memberId) ?? []) {
    if (r.lat != null && r.lng != null) return r
  }
  return null
}

function updateMemberMarker(member: ChatProfile, plink = false) {
  if (!map) return
  const spot = latestGeo(member.id)
  const existing = markersByMember.get(member.id)
  if (!spot) {
    if (existing) {
      existing.map = null
      markersByMember.delete(member.id)
    }
    return
  }
  if (existing) {
    existing.position = { lat: spot.lat!, lng: spot.lng! }
  } else {
    const el = document.createElement('div')
    el.className = 'member-marker'
    const color = memberColor(member)
    el.style.border = `3px solid ${color}`
    const url = avatarUrl(member.avatar)
    if (url) {
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      el.appendChild(img)
    } else {
      el.style.background = color
      el.textContent = (member.display_name || member.username).slice(0, 1).toUpperCase()
    }
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: spot.lat!, lng: spot.lng! },
      title: member.display_name || member.username,
      content: el,
      gmpClickable: true,
      zIndex: 500,
    })
    marker.addListener('gmp-click', () => selectMember(member.id, false))
    markersByMember.set(member.id, marker)
  }
  const marker = markersByMember.get(member.id)!
  const el = marker.content as HTMLElement
  el.classList.toggle('selected', selectedMemberId.value === member.id)
  marker.zIndex = selectedMemberId.value === member.id ? 1000 : 500
  if (plink) {
    el.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }],
      { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
  }
}

/** Frame the whole assignment: every turf door plus every member marker. */
function fitToSquad() {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const d of turfDoors.value.values()) {
    if (d.lat != null && d.lng != null) bounds.extend({ lat: d.lat, lng: d.lng })
  }
  for (const marker of markersByMember.values()) {
    if (marker.position) bounds.extend(marker.position)
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
}

/** Tap a member (card or marker): zoom the map to the last door they
 * knocked. From a card we also bring the map into view — that's the point. */
function selectMember(memberId: string, scroll = true) {
  selectedMemberId.value = memberId
  for (const m of mySquad.value?.members ?? []) updateMemberMarker(m)
  const spot = latestGeo(memberId)
  if (map && spot) {
    map.panTo({ lat: spot.lat!, lng: spot.lng! })
    map.setZoom(17)
  }
  if (scroll) mapCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function focusTurf(turfId: string) {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const d of turfDoors.value.values()) {
    if (d.turf_id === turfId && d.lat != null && d.lng != null) {
      bounds.extend({ lat: d.lat, lng: d.lng })
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

// --- Live knocks: squadmates' doors land on the page as they happen ---

let knockFeed: RealtimeChannel | null = null

function subscribeToKnocks() {
  knockFeed = supabase
    .channel('squad-knock-feed')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'knock_logs' },
      (payload) => void onLiveKnock(payload.new as KnockLog),
    )
    .subscribe()
}

async function onLiveKnock(knock: KnockLog) {
  if (!knock.household_id || !memberIdSet.value.has(knock.canvasser_id)) return
  const { data: a } = await supabase
    .from('addresses')
    .select('id, street, lat, lng, turf_id')
    .eq('id', knock.household_id)
    .maybeSingle()
  if (!a) return

  const list = recentByMember.value.get(knock.canvasser_id) ?? []
  recentByMember.value.set(knock.canvasser_id, [
    { addressId: a.id, street: a.street, lat: a.lat, lng: a.lng, occurredAt: knock.occurred_at },
    ...list.filter((r) => r.addressId !== a.id),
  ].slice(0, 5))

  if (a.turf_id && turfIdSet.value.has(a.turf_id)) {
    knockedDoors.value.add(a.id)
    let set = knockedByMember.value.get(knock.canvasser_id)
    if (!set) knockedByMember.value.set(knock.canvasser_id, (set = new Set()))
    set.add(a.id)
  }

  const member = mySquad.value?.members.find((m) => m.id === knock.canvasser_id)
  if (member) updateMemberMarker(member, true)
}

// --- No-squad state: form or join today's crew right here ---

const composing = ref(false)
const squadName = ref('')
const picked = ref<ChatProfile[]>([])
const creating = ref(false)

function openComposer() {
  composing.value = true
  squadName.value = ''
  picked.value = []
}

async function createSquad() {
  const name = squadName.value.trim()
  if (creating.value || !name) return
  creating.value = true
  const squad = await squads.createSquad(
    name,
    picked.value.map((p) => p.id),
  )
  creating.value = false
  if (squad) {
    composing.value = false
    selectedSquadId.value = squad.id
  }
}

function openSquadChat() {
  if (mySquad.value?.chat_id) chat.openDrawer(mySquad.value.chat_id)
}

async function leaveSquad() {
  const squad = mySquad.value
  if (!squad) return
  await squads.leaveSquad(squad.id)
  selectedSquadId.value = null
}

// --- Display helpers ---

/** "412 WALNUT ST" → "412 Walnut St" — small text has no room to shout. */
function prettyStreet(street: string): string {
  return street.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function knockTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function memberName(m: ChatProfile): string {
  return m.display_name || m.username
}

function knockedCount(memberId: string): number {
  return knockedByMember.value.get(memberId)?.size ?? 0
}

// --- Lifecycle ---

onMounted(async () => {
  squads.subscribeToRosters()
  await squads.loadToday()
  subscribeToKnocks()
})

// The map div only exists while you're IN a squad (the no-squad branch has
// no map), so init keys off the element appearing — not off mount. Firing
// again after leave/rejoin is fine: initMap re-inits only for a fresh div.
watch(mapEl, (el) => {
  if (el) void initMap()
}, { flush: 'post' })

onUnmounted(() => {
  squads.unsubscribeFromRosters()
  if (knockFeed) void supabase.removeChannel(knockFeed)
  areasLayer?.dispose()
  for (const marker of markersByMember.values()) marker.map = null
  markersByMember.clear()
})

// Load once the squad appears and reload whenever the squad or its roster
// changes (the store keeps the roster live via its squad_members
// subscription). Immediate: the store may already hold today's squads from
// an earlier visit this session.
watch(
  () => (mySquad.value ? `${mySquad.value.id}:${mySquad.value.members.length}` : ''),
  (key) => {
    if (key) void loadDashboard()
  },
  { immediate: true },
)
</script>

<template>
  <AppShell title="Squad">
    <!-- ============ No squad today ============ -->
    <div v-if="!squads.loading && !mySquad" class="stack">
      <p class="muted intro">
        You're not in a squad yet today. Squads are today's door-knocking crews — everyone in
        one shares a chat, this squad page, and turf. They reset at midnight.
      </p>
      <button class="btn btn-primary big-btn" @click="openComposer">+ Start today's squad</button>
      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <p v-if="squads.squads.length" class="muted join-heading">…or join one that's out already:</p>
      <div v-for="(s, i) in squads.squads" :key="s.id" v-motion="fadeUp(Math.min(i, 8) * 45)" class="card join-card">
        <div class="join-info">
          <span class="join-name">👥 {{ s.name }}</span>
          <span class="muted join-members">
            {{ s.members.length }} member{{ s.members.length === 1 ? '' : 's' }} —
            {{ s.members.map(memberName).join(', ') }}
          </span>
        </div>
        <button class="btn btn-sm btn-primary" @click="squads.joinSquad(s.id)">Join</button>
      </div>
    </div>

    <!-- ============ Your squad ============ -->
    <div v-else-if="mySquad" class="stack">
      <div class="squad-header">
        <div class="squad-title">
          <h2>👥 {{ mySquad.name }}</h2>
          <span class="muted">{{ mySquad.members.length }} member{{ mySquad.members.length === 1 ? '' : 's' }} today</span>
        </div>
        <div class="squad-actions">
          <select
            v-if="squads.mySquads.length > 1"
            class="squad-switch"
            :value="mySquad.id"
            aria-label="Switch squad"
            @change="selectedSquadId = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="s in squads.mySquads" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <button v-if="mySquad.chat_id" class="btn btn-sm btn-primary" @click="openSquadChat">Chat</button>
          <button class="btn btn-sm btn-ghost" @click="leaveSquad">Leave</button>
        </div>
      </div>

      <!-- Turf progress -->
      <div class="card progress-card">
        <template v-if="squadTurfs.length">
          <div class="progress-row">
            <strong>Our turf</strong>
            <span class="progress-count">
              <strong>{{ doorsKnocked }}</strong> of {{ doorsTotal }} doors knocked
              <span class="muted">({{ progressPct }}%)</span>
            </span>
          </div>
          <div class="progress-track" role="progressbar" :aria-valuenow="doorsKnocked" :aria-valuemin="0" :aria-valuemax="doorsTotal">
            <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
          </div>
          <div class="turf-chips">
            <button v-for="t in squadTurfs" :key="t.id" class="turf-chip" @click="focusTurf(t.id)">
              <span class="turf-dot" :style="{ background: t.color }"></span>{{ t.name }}
            </button>
          </div>
        </template>
        <p v-else-if="!dashboardLoading" class="muted no-turf">
          No turf assigned to your squad yet — your campaign manager cuts and assigns turf.
          The map still follows everyone's knocks meanwhile.
        </p>
      </div>

      <!-- Map -->
      <div ref="mapCardEl" class="card map-card">
        <p v-if="mapsAuthError || mapFailed" class="error map-error">
          Couldn't load Google Maps — check the connection and reload.
        </p>
        <div v-else ref="mapEl" class="squad-map"></div>
      </div>

      <!-- Member cards -->
      <div class="member-grid">
        <button
          v-for="(m, i) in orderedMembers"
          :key="m.id"
          v-motion="fadeUp(Math.min(i, 8) * 45)"
          class="member-card"
          :class="{ selected: selectedMemberId === m.id }"
          :style="{
            '--member-color': memberColor(m),
          }"
          @click="selectMember(m.id)"
        >
          <div class="member-top">
            <span class="member-avatar" :style="!avatarUrl(m.avatar) ? { background: memberColor(m) } : {}">
              <img v-if="avatarUrl(m.avatar)" :src="avatarUrl(m.avatar)" alt="" />
              <template v-else>{{ memberName(m).slice(0, 1).toUpperCase() }}</template>
            </span>
            <span class="member-name">
              {{ memberName(m) }}
              <span v-if="m.id === auth.profile?.id" class="muted you-tag">(you)</span>
            </span>
            <span v-if="squadTurfs.length" class="member-count" :title="'Turf doors knocked'">
              {{ knockedCount(m.id) }}
            </span>
          </div>
          <ul v-if="recentByMember.get(m.id)?.length" class="recent-list">
            <li v-for="r in recentByMember.get(m.id)" :key="r.addressId">
              <span class="recent-street">{{ prettyStreet(r.street) }}</span>
              <span class="recent-time muted">{{ knockTime(r.occurredAt) }}</span>
            </li>
          </ul>
          <p v-else class="muted no-knocks">No doors knocked yet.</p>
        </button>
      </div>
      <p class="muted color-tip">
        Tap a squadmate to zoom the map to the last door they knocked. Pick your card color and
        avatar under Appearance.
      </p>
    </div>

    <p v-else class="muted">Loading your squad…</p>

    <!-- New squad sheet (no-squad state) -->
    <BottomSheet v-model:open="composing" title="New squad" aria-label="New squad">
      <p class="muted hint">
        Name today's crew and optionally add people now — anyone can also join on their own.
        A squad chat is created automatically.
      </p>
      <div class="field">
        <label for="squad-name">Squad name</label>
        <input id="squad-name" v-model="squadName" placeholder="e.g. Richwood crew" />
      </div>
      <UserPicker v-model="picked" />
      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <button
        class="btn btn-primary btn-block big-btn"
        :disabled="creating || !squadName.trim()"
        @click="createSquad"
      >
        {{ creating ? 'Creating…' : 'Create squad' }}
      </button>
    </BottomSheet>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.intro,
.hint {
  margin: 0;
  font-size: 0.92rem;
}

.big-btn {
  min-height: 56px;
  font-size: 1.05rem;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0;
  font-size: 0.9rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

/* --- No-squad join list --- */

.join-heading {
  margin: 0.4rem 0 0;
  font-size: 0.92rem;
}

.join-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.join-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.join-name {
  font-weight: 700;
}

.join-members {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- Header --- */

.squad-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.squad-title h2 {
  margin: 0;
  font-size: 1.25rem;
}

.squad-title .muted {
  font-size: 0.85rem;
}

.squad-actions {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-shrink: 0;
}

.squad-switch {
  max-width: 150px;
}

/* --- Progress --- */

.progress-card {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.progress-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.progress-count {
  font-size: 0.95rem;
}

.progress-track {
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.4s ease;
}

.turf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.turf-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font: inherit;
  font-size: 0.82rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.turf-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.no-turf {
  margin: 0;
  font-size: 0.9rem;
}

/* --- Map --- */

.map-card {
  padding: 0;
  overflow: hidden;
}

.squad-map {
  width: 100%;
  height: min(52vh, 420px);
  min-height: 260px;
}

.map-error {
  padding: 1rem;
}

/* --- Member cards --- */

.member-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 0.75rem;
}

.member-card {
  font: inherit;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--member-color) 7%, var(--surface));
  border: 2px solid color-mix(in srgb, var(--member-color) 45%, var(--border));
  border-left: 6px solid var(--member-color);
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.member-card:hover {
  transform: translateY(-1px);
}

.member-card.selected {
  border-color: var(--member-color);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--member-color) 35%, transparent);
}

.member-top {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
}

.member-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2.5px solid var(--member-color);
  background: var(--surface);
  color: #fff;
  font-weight: 800;
  overflow: hidden;
}

.member-avatar img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 2px;
}

.member-name {
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.you-tag {
  font-weight: 500;
  font-size: 0.8rem;
}

.member-count {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 2em;
  text-align: center;
  font-weight: 800;
  font-size: 0.95rem;
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  background: var(--member-color);
  color: #fff;
}

.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.recent-list li {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.8rem;
  line-height: 1.35;
}

.recent-street {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.no-knocks {
  margin: 0;
  font-size: 0.8rem;
}

.color-tip {
  margin: 0;
  font-size: 0.82rem;
}
</style>

<style>
/* Marker content lives outside this component's scope (Google injects it
 * into the map pane), so its styles are global. */
.member-marker {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}

.member-marker img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 2px;
  background: #fff;
}

.member-marker.selected {
  transform: scale(1.25);
}
</style>
