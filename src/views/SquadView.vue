<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { fadeUp } from '@/lib/motion'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { loadMaps, mapsAuthError } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import { TurfAreasLayer, dotClusterRenderer } from '@/lib/mapLayers'
import type { DoorPoint } from '@/lib/mapLayers'
import { rangeCovers, walkRanges } from '@/lib/doorPath'
import { geocodeMissing } from '@/lib/geocode'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { telHref } from '@/lib/phone'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import { useTalkStore } from '@/stores/talk'
import type { ChatProfile, KnockLog } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }

// Door-pin colors (fixed hex, like the outcome/Hunt pins — not themed, so
// "done vs to-do" reads the same in every color scheme).
const DOOR_KNOCKED_HEX = '#2e9e5b'
const DOOR_TODO_HEX = '#2f6fed'
/** Below this zoom the house-number chips fall back to plain dots — numbers
 * only mean something when you're close enough to read a street. */
const NUMBERS_MIN_ZOOM = 16

const router = useRouter()
const auth = useAuthStore()
const chat = useChatStore()
const squads = useSquadsStore()
const talk = useTalkStore()

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
  parent_turf_id: string | null
}

interface TurfDoor {
  id: string
  street: string
  unit: string | null
  city: string
  zip: string | null
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

// Splitting the squad's turf among members is a leader's / manager's job —
// but if nobody on the crew outranks a canvasser today, any member can do it
// (matches the DB's can_member_subcut). It happens right here on the squad
// map: pick a member, tap doors, save — a sub-turf assigned to them.
const squadHasRankedMember = computed(() =>
  (mySquad.value?.members ?? []).some((m) => m.role != null && m.role !== 'canvasser'),
)
/** Top-level squad turfs the current user may divide, mirroring the DB's
 * can_lead_subcut / can_member_subcut so the UI offers exactly what the
 * set_turf_segments RPC will accept. */
const assignableParentIds = computed<Set<string>>(() => {
  const role = auth.profile?.role
  const me = auth.profile?.id
  const squadId = mySquad.value?.id
  const out = new Set<string>()
  for (const t of squadTurfs.value) {
    if (t.parent_turf_id) continue
    if (role === 'campaign_manager' || role === 'admin') out.add(t.id)
    else if (role === 'team_lead') {
      if (t.assignee_id === me || (t.squad_id !== null && t.squad_id === squadId)) out.add(t.id)
    } else if (!squadHasRankedMember.value && t.squad_id !== null && t.squad_id === squadId) {
      out.add(t.id)
    }
  }
  return out
})
const canAssign = computed(() => assignableParentIds.value.size > 0)
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

  // Squad turf = dispatched to this squad, or to a member directly — same
  // "your crew's assignment" definition the Hunt map opens framed on.
  // Top-level turf only: sub-turfs ride in via their parent below, so
  // splitting the turf never makes doors disappear from the squad's progress
  // — but yesterday's "<name>'s doors" splits (sub-turfs assigned to members
  // under some OTHER crew's turf) can't follow people into today's squad.
  const { data: turfData } = await supabase
    .from('turfs')
    .select('id, name, color, squad_id, assignee_id, parent_turf_id')
  const all = (turfData ?? []) as TurfLite[]
  const direct = all.filter(
    (t) =>
      !t.parent_turf_id &&
      (t.squad_id === squad.id ||
        (t.assignee_id !== null && memberIds.includes(t.assignee_id))),
  )
  const directIds = new Set(direct.map((t) => t.id))
  const mine = [
    ...direct,
    ...all.filter(
      (t) => t.parent_turf_id !== null && directIds.has(t.parent_turf_id) && !directIds.has(t.id),
    ),
  ]
  const turfIds = mine.map((t) => t.id)

  // Both "whole set" queries page past PostgREST's 1000-row response cap
  // (a plain .limit() above that silently truncates). Best-effort: a failed
  // page just means fewer doors/knocks this refresh, same as before.
  const [doorsData, knocksData, ...recentRes] = await Promise.all([
    turfIds.length
      ? fetchAllRows<TurfDoor>((from, to) =>
          supabase
            .from('addresses')
            .select('id, street, unit, city, zip, lat, lng, turf_id')
            .in('turf_id', turfIds)
            .order('id')
            .range(from, to),
        ).catch(() => [] as TurfDoor[])
      : Promise.resolve([] as TurfDoor[]),
    turfIds.length
      ? fetchAllRows<{ household_id: string; canvasser_id: string }>((from, to) =>
          supabase
            .from('knock_logs')
            .select('household_id, canvasser_id, addresses!inner(turf_id)')
            .in('addresses.turf_id', turfIds)
            .not('household_id', 'is', null)
            .order('id')
            .range(from, to),
        ).catch(() => [] as { household_id: string; canvasser_id: string }[])
      : Promise.resolve([] as { household_id: string; canvasser_id: string }[]),
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
  turfDoors.value = new Map(doorsData.map((d) => [d.id, d]))

  const knocked = new Set<string>()
  const byMember = new Map<string, Set<string>>()
  for (const row of knocksData) {
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
// One house-number pin per geocoded turf door, decluttered by a clusterer
// (a turf can hold thousands of doors). Tapping one opens it in Talk mode.
const markersByDoor = new Map<string, google.maps.marker.AdvancedMarkerElement>()
let doorClusterer: MarkerClusterer | null = null
const mapFailed = ref(false)
/** Tracked so number chips can fall back to dots when zoomed out; only
 * threshold crossings restyle. */
let mapZoom = 13

const turfColorById = computed(() => new Map(squadTurfs.value.map((t) => [t.id, t.color])))
const turfById = computed(() => new Map(squadTurfs.value.map((t) => [t.id, t])))

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
  doorClusterer?.clearMarkers()
  markersByDoor.clear()
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
  doorClusterer = new MarkerClusterer({ map, markers: [], renderer: dotClusterRenderer() })
  mapZoom = map.getZoom() ?? mapZoom
  map.addListener('zoom_changed', () => {
    const wasClose = mapZoom >= NUMBERS_MIN_ZOOM
    mapZoom = map?.getZoom() ?? mapZoom
    if (wasClose !== mapZoom >= NUMBERS_MIN_ZOOM) restyleAllDoors()
  })
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

  applyDoorMarkers()

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

/** House-number chip for one door: green once anyone's knocked it, blue while
 * it's still to-do — the door-level echo of the "X of Y knocked" bar. In
 * assign mode, selected doors wear the member's color instead and doors the
 * viewer can't hand out fade back. */
function styleDoorMarker(marker: google.maps.marker.AdvancedMarkerElement, door: TurfDoor) {
  const el = marker.content as HTMLElement
  const s = el.style
  const knocked = knockedDoors.value.has(door.id)
  const turfColor = turfColorById.value.get(door.turf_id)
  const showNumber = !!el.dataset.house && mapZoom >= NUMBERS_MIN_ZOOM
  el.textContent = showNumber ? el.dataset.house! : ''
  s.boxSizing = 'border-box'
  s.cursor = 'pointer'
  s.display = 'flex'
  s.alignItems = 'center'
  s.justifyContent = 'center'
  s.height = showNumber ? '19px' : '14px'
  s.minWidth = showNumber ? '19px' : '14px'
  s.padding = showNumber ? '0 5px' : '0'
  s.borderRadius = showNumber ? '7px' : '50%'
  s.width = showNumber ? 'auto' : '14px'
  s.fontSize = '11px'
  s.fontWeight = '700'
  s.lineHeight = '1'
  s.color = '#fff'
  s.opacity = '1'
  s.background = knocked ? DOOR_KNOCKED_HEX : DOOR_TODO_HEX
  s.border = '1.5px solid #fff'
  // Thin ring in the turf's own color, so doors from different turfs (yours
  // vs a squadmate's directly-assigned turf) stay tellable apart.
  s.boxShadow = turfColor
    ? `0 0 0 2px ${turfColor}, 0 0 3px rgba(0, 0, 0, 0.45)`
    : '0 0 3px rgba(0, 0, 0, 0.45)'
  const member = assigningMember.value
  s.animation = ''
  if (member) {
    if (assignSelected.value.has(door.id)) {
      s.background = memberColor(member)
      s.boxShadow = '0 0 0 2.5px #fff, 0 0 5px rgba(0, 0, 0, 0.55)'
      // The walk anchor pulses: the next unselected door tapped sweeps the
      // whole walk from here.
      if (door.id === assignAnchorId.value) {
        s.animation = 'squad-anchor-pulse 1.1s ease-in-out infinite'
      }
    } else if (poolParentOf(door) === null) {
      s.opacity = '0.35'
    }
  }
}

/** Sync the door pins with the current turf doors: add new ones, restyle
 * existing ones (knock status changes), drop any no longer in turf. */
function applyDoorMarkers() {
  if (!map || !doorClusterer) return
  const alive = new Set<string>()
  const fresh: google.maps.marker.AdvancedMarkerElement[] = []
  for (const door of turfDoors.value.values()) {
    if (door.lat == null || door.lng == null) continue
    alive.add(door.id)
    let marker = markersByDoor.get(door.id)
    if (!marker) {
      const content = document.createElement('div')
      const num = houseNumber(door.street)
      if (num > 0) content.dataset.house = String(num)
      marker = new google.maps.marker.AdvancedMarkerElement({
        position: { lat: door.lat, lng: door.lng },
        title: door.street,
        content,
        gmpClickable: true,
      })
      marker.addListener('gmp-click', () => onDoorTap(door.id))
      markersByDoor.set(door.id, marker)
      fresh.push(marker)
    }
    styleDoorMarker(marker, door)
  }
  const stale: google.maps.marker.AdvancedMarkerElement[] = []
  for (const [id, marker] of markersByDoor) {
    if (!alive.has(id)) {
      stale.push(marker)
      markersByDoor.delete(id)
    }
  }
  if (stale.length) doorClusterer.removeMarkers(stale)
  if (fresh.length) doorClusterer.addMarkers(fresh)
}

/** Restyle a single door's pin in place (live knock landed on it). */
function restyleDoor(addressId: string) {
  const marker = markersByDoor.get(addressId)
  const door = turfDoors.value.get(addressId)
  if (marker && door) styleDoorMarker(marker, door)
}

/** Door pins do double duty: normally they open the door in Talk mode; in
 * assign mode they toggle the door in and out of the member's pile. */
function onDoorTap(addressId: string) {
  if (assigningMemberId.value) {
    toggleAssignDoor(addressId)
    return
  }
  void openDoor(addressId)
}

/** Tap a door pin: load it into Talk mode and jump to the canvass screen —
 * the squad map as a second way into knock logging. */
async function openDoor(addressId: string) {
  await talk.loadAddress(addressId)
  await router.push({ name: 'canvass' })
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

/** Frame the squad's TURF — that's the assignment, so that's the opening
 * shot. Members' last knocks can be anywhere (a lead checking in from home,
 * yesterday's doors across town), so they only set the frame when there are
 * no mapped turf doors at all. */
function fitToSquad() {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const d of turfDoors.value.values()) {
    if (d.lat != null && d.lng != null) bounds.extend({ lat: d.lat, lng: d.lng })
  }
  if (bounds.isEmpty()) {
    for (const marker of markersByMember.values()) {
      if (marker.position) bounds.extend(marker.position)
    }
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

// --- Geolocate the turf's unpinned doors ---
// Turf doors normally geocode at cut time, but imports and misses leave
// gaps — this pins whatever's still missing so the map shows the whole
// assignment. Batches over 100 get a confirm (one door at a time is slow).

const GEOLOCATE_WARN_AT = 100
const geolocating = ref(false)
const geoProgress = ref('')
let squadUnmounted = false

const missingDoorCount = computed(
  () => [...turfDoors.value.values()].filter((d) => d.lat == null || d.lng == null).length,
)

async function geolocateTurfDoors() {
  if (geolocating.value) return
  const missing = [...turfDoors.value.values()].filter((d) => d.lat == null || d.lng == null)
  if (!missing.length) return
  if (
    missing.length > GEOLOCATE_WARN_AT &&
    !window.confirm(
      `Place pins for ${missing.length} doors? That's a big batch — they geocode one at a time, so it can take several minutes. Continue?`,
    )
  ) {
    return
  }
  geolocating.value = true
  let done = 0
  geoProgress.value = `0/${missing.length}`
  try {
    await geocodeMissing(
      missing,
      (id, loc) => {
        const d = turfDoors.value.get(id)
        if (d) {
          d.lat = loc.lat
          d.lng = loc.lng
        }
        geoProgress.value = `${++done}/${missing.length}`
        applyDoorMarkers()
      },
      () => squadUnmounted,
    )
    if (!squadUnmounted) applyMapData(false)
  } finally {
    geolocating.value = false
    geoProgress.value = ''
  }
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
    restyleDoor(a.id)
  }

  const member = mySquad.value?.members.find((m) => m.id === knock.canvasser_id)
  if (member) updateMemberMarker(member, true)
}

// --- Assign mode: hand doors to a member right on the squad map ---
// Tap "Assign doors" on a member's card, tap doors on the map, save. The
// selection becomes a sub-turf assigned to that member ("<name>'s doors"),
// cut with the same set_turf_segments machinery as the /turf sub-cutter, so
// Hunt, progress bars, and RLS all keep working unchanged.

const assigningMemberId = ref<string | null>(null)
const assignSelected = ref<ReadonlySet<string>>(new Set())
/** The last door selected by tap — the start of a two-tap walk sweep. */
const assignAnchorId = ref<string | null>(null)
const assignSaving = ref(false)
const assignError = ref('')

const assigningMember = computed<ChatProfile | null>(
  () => (mySquad.value?.members ?? []).find((m) => m.id === assigningMemberId.value) ?? null,
)

/** The top-level pool a door would be claimed from (itself for a door still
 * in a parent turf, its parent for a door already in a sub-turf) — or null
 * when the viewer isn't allowed to divide that turf. */
function poolParentOf(door: TurfDoor): string | null {
  const t = turfById.value.get(door.turf_id)
  if (!t) return null
  const pid = t.parent_turf_id ?? t.id
  return assignableParentIds.value.has(pid) ? pid : null
}

function restyleAllDoors() {
  for (const [id, marker] of markersByDoor) {
    const door = turfDoors.value.get(id)
    if (door) styleDoorMarker(marker, door)
  }
}

function startAssign(memberId: string) {
  if (assigningMemberId.value === memberId) {
    mapCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  assignError.value = ''
  assigningMemberId.value = memberId
  // Pre-select what's already theirs, so re-opening a member edits their
  // existing pile instead of starting from scratch.
  const pre = new Set<string>()
  for (const d of turfDoors.value.values()) {
    const t = turfById.value.get(d.turf_id)
    if (
      t?.parent_turf_id &&
      t.assignee_id === memberId &&
      assignableParentIds.value.has(t.parent_turf_id)
    ) {
      pre.add(d.id)
    }
  }
  assignSelected.value = pre
  assignAnchorId.value = null
  restyleAllDoors()
  mapCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function cancelAssign() {
  assigningMemberId.value = null
  assignSelected.value = new Set()
  assignAnchorId.value = null
  assignError.value = ''
  restyleAllDoors()
}

/** Tap an unselected door: it joins the pile and becomes the walk anchor.
 * Tap ANOTHER unselected door while one is anchored: every door along the
 * walk between them joins too (same street = the range between; different
 * streets = up the first street to the corner, then along the second).
 * Tap a selected door: just that door leaves the pile. */
function toggleAssignDoor(addressId: string) {
  const door = turfDoors.value.get(addressId)
  if (!door || poolParentOf(door) === null) return
  const next = new Set(assignSelected.value)

  if (next.has(addressId)) {
    next.delete(addressId)
    assignAnchorId.value = null
    assignSelected.value = next
    const marker = markersByDoor.get(addressId)
    if (marker) styleDoorMarker(marker, door)
    return
  }

  const anchor = assignAnchorId.value ? turfDoors.value.get(assignAnchorId.value) : null
  if (anchor && next.has(anchor.id) && anchor.id !== addressId) {
    const ranges = walkRanges(anchor, door, turfDoors.value.values())
    for (const d of turfDoors.value.values()) {
      if (next.has(d.id) || poolParentOf(d) === null) continue
      if (ranges.some((r) => rangeCovers(r, d))) next.add(d.id)
    }
    next.add(addressId)
    assignAnchorId.value = null
    assignSelected.value = next
    restyleAllDoors()
    return
  }

  next.add(addressId)
  assignAnchorId.value = addressId
  assignSelected.value = next
  restyleAllDoors()
}

interface SegmentDraft {
  street_name: string
  city: string
  range_start: number
  range_end: number
  parity: 'both'
}

/** Compress a door pile into street segments for set_turf_segments. Runs of
 * house numbers merge into one range, but never across a "blocker": a door
 * the RPC could also claim from the same pool (poolDoors) that ISN'T in the
 * pile — a spanning range would swallow it. */
function segmentsFor(doors: TurfDoor[], poolDoors: TurfDoor[]): SegmentDraft[] {
  const keyOf = (d: TurfDoor) => `${streetNameOf(d.street)}|${d.city.toUpperCase()}`
  const chosen = new Set(doors.map((d) => d.id))
  const byStreet = new Map<string, { name: string; city: string; nums: Set<number>; blocked: Set<number> }>()
  for (const d of doors) {
    const key = keyOf(d)
    let g = byStreet.get(key)
    if (!g) byStreet.set(key, (g = { name: streetNameOf(d.street), city: d.city, nums: new Set(), blocked: new Set() }))
    g.nums.add(houseNumber(d.street))
  }
  for (const d of poolDoors) {
    if (chosen.has(d.id)) continue
    const g = byStreet.get(keyOf(d))
    if (!g) continue
    const n = houseNumber(d.street)
    // A left-out unit at a picked house number can't split the range (the
    // RPC claims whole numbers) — it just rides along with its neighbors.
    if (!g.nums.has(n)) g.blocked.add(n)
  }
  const segs: SegmentDraft[] = []
  for (const g of byStreet.values()) {
    const nums = [...g.nums].sort((a, b) => a - b)
    const blocked = [...g.blocked].sort((a, b) => a - b)
    let start = nums[0]
    let prev = nums[0]
    for (let i = 1; i <= nums.length; i++) {
      const n = nums[i]
      if (n === undefined || blocked.some((b) => b > prev && b < n)) {
        segs.push({ street_name: g.name, city: g.city, range_start: start, range_end: prev, parity: 'both' })
        if (n !== undefined) start = n
      }
      if (n !== undefined) prev = n
    }
  }
  return segs
}

async function saveAssignment() {
  const member = assigningMember.value
  if (!member || assignSaving.value) return
  assignSaving.value = true
  assignError.value = ''
  try {
    // Selection grouped by which top-level turf's pool each door sits in
    // (a squad can hold more than one turf; each needs its own sub-turf).
    const byParent = new Map<string, TurfDoor[]>()
    for (const id of assignSelected.value) {
      const d = turfDoors.value.get(id)
      const p = d ? poolParentOf(d) : null
      if (!d || !p) continue
      const list = byParent.get(p)
      if (list) list.push(d)
      else byParent.set(p, [d])
    }
    // The member's existing sub-turfs, so a deselected-to-empty one is
    // deleted (its doors return to the parent via the DB trigger).
    const ownByParent = new Map<string, TurfLite>()
    for (const t of squadTurfs.value) {
      if (
        t.parent_turf_id !== null &&
        t.assignee_id === member.id &&
        assignableParentIds.value.has(t.parent_turf_id)
      ) {
        ownByParent.set(t.parent_turf_id, t)
      }
    }
    const doorsIn = (turfId: string) =>
      [...turfDoors.value.values()].filter((d) => d.turf_id === turfId)

    for (const parentId of new Set([...byParent.keys(), ...ownByParent.keys()])) {
      const sel = byParent.get(parentId) ?? []
      const selIds = new Set(sel.map((d) => d.id))
      const own = ownByParent.get(parentId) ?? null

      // 1. Doors taken over from a squadmate's sub-turf get released first by
      //    re-cutting that sub-turf without them — the RPC only claims doors
      //    from the parent's pool, so a straight cut can't steal them.
      for (const sib of squadTurfs.value) {
        if (sib.parent_turf_id !== parentId || sib.id === own?.id) continue
        const sibDoors = doorsIn(sib.id)
        const keep = sibDoors.filter((d) => !selIds.has(d.id))
        if (keep.length === sibDoors.length) continue
        if (!keep.length) {
          const { error } = await supabase.from('turfs').delete().eq('id', sib.id)
          if (error) throw error
        } else {
          const { error } = await supabase.rpc('set_turf_segments', {
            target_turf_id: sib.id,
            segments: segmentsFor(keep, [...doorsIn(parentId), ...sibDoors]),
          })
          if (error) throw error
        }
      }

      // 2. The member's own sub-turf: create, re-cut, or delete when emptied.
      if (!sel.length) {
        if (own) {
          const { error } = await supabase.from('turfs').delete().eq('id', own.id)
          if (error) throw error
        }
        continue
      }
      let turfId = own?.id ?? null
      if (!turfId) {
        const { data, error } = await supabase
          .from('turfs')
          .insert({
            name: `${memberName(member)}'s doors`,
            color: memberColor(member),
            assignee_id: member.id,
            parent_turf_id: parentId,
            created_by: auth.profile?.id,
          })
          .select('id')
          .single()
        if (error || !data) throw error ?? new Error('insert failed')
        turfId = data.id as string
      }
      const { error } = await supabase.rpc('set_turf_segments', {
        target_turf_id: turfId,
        segments: segmentsFor(sel, [...doorsIn(parentId), ...(own ? doorsIn(own.id) : [])]),
      })
      if (error) throw error
    }
    assigningMemberId.value = null
    assignSelected.value = new Set()
    assignAnchorId.value = null
    await loadDashboard()
  } catch {
    assignError.value = "Couldn't save that assignment — try again."
  } finally {
    assignSaving.value = false
  }
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
  squadUnmounted = true
  squads.unsubscribeFromRosters()
  if (knockFeed) void supabase.removeChannel(knockFeed)
  areasLayer?.dispose()
  for (const marker of markersByMember.values()) marker.map = null
  markersByMember.clear()
  doorClusterer?.clearMarkers()
  markersByDoor.clear()
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
        You're not in a squad yet today — start one, or join a crew that's already out.
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
          No turf assigned to your squad yet today — your campaign manager sends turf out to
          each day's crews. The map still follows everyone's knocks meanwhile.
        </p>
      </div>

      <!-- Map -->
      <div ref="mapCardEl" class="card map-card">
        <div
          v-if="assigningMember"
          class="assign-bar"
          :style="{ '--assign-color': memberColor(assigningMember) }"
        >
          <span class="assign-dot" aria-hidden="true"></span>
          <p class="assign-text">
            Assigning doors to <strong>{{ memberName(assigningMember) }}</strong> — tap doors to
            add or remove them; tap one door, then another, to take the whole walk between them
            (even around a corner). <strong>{{ assignSelected.size }}</strong> selected.
          </p>
          <div class="assign-actions">
            <button class="btn btn-sm btn-primary" :disabled="assignSaving" @click="saveAssignment">
              {{ assignSaving ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn btn-sm btn-ghost" :disabled="assignSaving" @click="cancelAssign">
              Cancel
            </button>
          </div>
          <p v-if="assignError" class="error assign-error">{{ assignError }}</p>
        </div>
        <p v-if="mapsAuthError || mapFailed" class="error map-error">
          Couldn't load Google Maps — check the connection and reload.
        </p>
        <div v-else class="squad-map-wrap">
          <div ref="mapEl" class="squad-map"></div>
          <button
            v-if="missingDoorCount || geolocating"
            type="button"
            class="geolocate-btn"
            :disabled="geolocating"
            title="Place a pin for every turf door that has none yet"
            @click="geolocateTurfDoors"
          >
            {{ geolocating ? geoProgress || 'Placing…' : `Place ${missingDoorCount} pins` }}
          </button>
        </div>
      </div>

      <!-- Member cards -->
      <div class="member-grid">
        <div
          v-for="(m, i) in orderedMembers"
          :key="m.id"
          v-motion="fadeUp(Math.min(i, 8) * 45)"
          class="member-card"
          :class="{ selected: selectedMemberId === m.id, assigning: assigningMemberId === m.id }"
          :style="{
            '--member-color': memberColor(m),
          }"
          role="button"
          tabindex="0"
          @click="selectMember(m.id)"
          @keydown.enter.self.prevent="selectMember(m.id)"
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
          <div v-if="(m.phone && m.id !== auth.profile?.id) || canAssign" class="member-actions">
            <a
              v-if="m.phone && m.id !== auth.profile?.id"
              class="btn btn-sm call-btn"
              :href="telHref(m.phone)"
              :aria-label="`Call ${memberName(m)}`"
              @click.stop
            >
              Call
            </a>
            <button
              v-if="canAssign"
              class="btn btn-sm assign-btn"
              @click.stop="startAssign(m.id)"
            >
              {{ assigningMemberId === m.id ? 'Picking doors…' : 'Assign doors' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <p v-else class="muted">Loading your squad…</p>

    <!-- New squad sheet (no-squad state) -->
    <BottomSheet v-model:open="composing" title="New squad" aria-label="New squad">
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

.intro {
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

.squad-map-wrap {
  position: relative;
}

.squad-map {
  width: 100%;
  height: min(52vh, 420px);
  min-height: 260px;
}

/* Same chrome as the turf cutter's map controls. */
.geolocate-btn {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  min-height: 36px;
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.geolocate-btn:disabled {
  cursor: default;
  color: var(--text-muted);
}

.map-error {
  padding: 1rem;
}

/* --- Assign mode --- */

.assign-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border);
  border-left: 6px solid var(--assign-color);
  background: color-mix(in srgb, var(--assign-color) 8%, var(--surface));
}

.assign-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--assign-color);
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.4);
}

.assign-text {
  margin: 0;
  flex: 1;
  min-width: 12rem;
  font-size: 0.88rem;
}

.assign-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.assign-error {
  width: 100%;
}

.member-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.assign-btn,
.call-btn {
  border: 1.5px solid var(--member-color);
  color: var(--member-color);
  background: transparent;
  font-weight: 700;
}

.call-btn {
  text-decoration: none;
}

.member-card.assigning .assign-btn {
  background: var(--member-color);
  color: #fff;
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

/* Assign mode's walk-anchor pulse — lives on marker content in Google's map
 * pane, outside this component's subtree, so it must be global. */
@keyframes squad-anchor-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.3);
  }
}
</style>
