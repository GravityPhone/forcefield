<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { Geolocation } from '@capacitor/geolocation'
import { loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  CityLimitsLayer,
  readMapPref,
  readPinMode,
  readTurfShadeMode,
  writeMapPref,
  writePinMode,
  writeTurfShadeMode,
} from '@/lib/mapLayers'
import type { DoorPoint, PinMode, TurfShadeMode } from '@/lib/mapLayers'
import { DoorCanvasLayer, PINS_MIN_ZOOM } from '@/lib/doorCanvas'
import type { DoorPaintState } from '@/lib/doorCanvas'
import { geocodeAndCache } from '@/lib/geocode'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { localToday, startOfLocalDayISO } from '@/lib/day'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'
import {
  OUTCOME_HEX,
  PIN_DEFAULT_HEX,
  doorPartlySigned,
  doorStatusOutcome,
  knockButtonHex,
} from '@/lib/outcomes'
import { inkOn } from '@/lib/memberColors'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import OutcomeIndicatorGrid from './OutcomeIndicatorGrid.vue'
import { fadeUp } from '@/lib/motion'
import type { Address, HouseholdKnockSummary, HouseholdLatestKnock, KnockLog, KnockOutcome, Person } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }
const NEARBY_CAP = 50
const DEFAULT_ZOOM = 14
// Zoom thresholds (PINS_MIN_ZOOM / NUMBERS_MIN_ZOOM) and the tap radius are
// shared with Squad and the turf cutter — see src/lib/doorCanvas.ts. Below
// PINS_MIN_ZOOM every door paints as a tiny dot; door taps don't land there
// either (at town zoom a 22px tap circle covers half a street).

/** `persons(count)` is a PostgREST aggregate embed — one row per address
 * with a single { count } entry, giving household roster size in the same
 * query as the address itself (no extra round trip). */
type RosterCount = { persons: { count: number }[] }
type AddressWithRoster = Address & Partial<RosterCount>

interface PersonHit extends Person {
  addresses: (Pick<Address, 'id' | 'street' | 'unit' | 'city'> & Partial<RosterCount>) | null
}

const talk = useTalkStore()
const auth = useAuthStore()

const mapWrapEl = ref<HTMLElement | null>(null)
const mapEl = ref<HTMLElement | null>(null)
const isFullscreen = ref(false)
const listQuery = ref('')
const searchResults = ref<{ persons: PersonHit[]; addresses: AddressWithRoster[] }>({
  persons: [],
  addresses: [],
})
const searching = ref(false)
const locating = ref(false)
const pinsLoading = ref(false)
// Whether pins draw as colored dots or as labeled house-number chips. Persisted
// so a canvasser's choice survives reloads/navigation. Scout defaults to dots
// (the county-wide view is mostly read at a glance); Squad and the cutter
// default to numbers.
const pinMode = ref<PinMode>(readPinMode('hunt-pin-mode', 'dots'))
const locatedAddressId = ref<string | null>(null)

function setPinMode(mode: PinMode) {
  if (pinMode.value === mode) return
  pinMode.value = mode
  writePinMode('hunt-pin-mode', mode)
  doorLayer?.requestRepaint()
}

// The turf layer, as door RINGS — area shading is gone (2026-07-24, user
// call; the Squad map lost it the same day). The shaded polygons could
// visibly overlap where two turfs met, because turfAreaFor() padded each
// door by 14m into a ~44m grid and bridged cells along street runs, so
// facing turfs both claimed the cells between them. A door belongs to
// exactly one turf (addresses.turf_id is one column), so painting membership
// on the doors makes overlap impossible to draw.
//
// Still for EVERYONE — a canvasser with no assignment gets to see how the
// ground is cut. Tri-state: "My turf" rings only yours, "All turf" rings
// every turf in its own color, tapping the active one leaves plain status
// pins. Key unchanged; the legacy `map-show-areas` boolean still seeds the
// default so an old "off" choice sticks.
const turfShade = ref<TurfShadeMode>(
  readTurfShadeMode('map-turf-shading', readMapPref('map-show-areas', true) ? 'all' : 'off'),
)
const showCity = ref(readMapPref('map-show-city', false))

function setTurfShade(mode: 'mine' | 'all') {
  turfShade.value = turfShade.value === mode ? 'off' : mode
  writeTurfShadeMode('map-turf-shading', turfShade.value)
  // Switching ON "My turf" also takes you there — this button replaced the
  // old "Zoom to my turf" chip. Turning it off doesn't move the map; you're
  // looking at something.
  if (turfShade.value === 'mine') focusMyTurf()
}

function toggleCity() {
  showCity.value = !showCity.value
  writeMapPref('map-show-city', showCity.value)
  void cityLayer?.setVisible(showCity.value)
}
const locatedAddress = ref<AddressWithRoster | null>(null)
const statusByHousehold = ref<Map<string, HouseholdLatestKnock>>(new Map())
const summaryByHousehold = ref<Map<string, HouseholdKnockSummary>>(new Map())
/** Doors anyone in the org knocked since local midnight — the "someone was
 * already here today" signal on pins and result rows, so crews working the
 * same turf don't double-knock. Kept live via the realtime feed below. */
const knockedToday = ref<Set<string>>(new Set())
/** Every turf — yours (assigned directly or via a squad you're in today)
 * get a colored ring on member pins and a jump-to chip. */
interface TurfLite {
  id: string
  name: string
  color: string
  squad_id: string | null
  assignee_id: string | null
  parent_turf_id: string | null
}
const allTurfs = ref<TurfLite[]>([])
const myTurfIds = ref<Set<string>>(new Set())
const myTurfs = computed(() => allTurfs.value.filter((t) => myTurfIds.value.has(t.id)))
/** Everyone in a squad I'm in today — their live knocks plink harder than
 * the rest of the org's, so watching the map reads as "us working". */
const squadmateIds = ref<Set<string>>(new Set())
const turfByAddress = ref<Map<string, string>>(new Map())
const doorInfoByAddress = new Map<string, DoorPoint>()
const loadError = ref('')

let map: google.maps.Map | null = null
/** Every geocoded door we know about — the row data behind the pins the
 * canvas layer paints (it holds only id/lat/lng/house itself). */
const addressById = new Map<string, AddressWithRoster>()
let cityLayer: CityLimitsLayer | null = null
/** Every door paints on ONE canvas (see src/lib/doorCanvas.ts) — the same
 * renderer the turf cutter and the Squad map use. There are no marker
 * elements, so there's no pin cap, no viewport-scoped marker churn, and no
 * density-dot decluttering: those all existed to keep the DOM marker count
 * survivable and none of it is needed here. */
let doorLayer: DoorCanvasLayer | null = null
let initStarted = false
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** Set once the canvasser pans/zooms themselves — the opening frame lands
 * asynchronously (map-first startup), and it must never yank a map someone
 * is already reading. */
let userMovedMap = false

watch(
  () => talk.activeTab,
  (tab) => {
    if (tab !== 'hunt') return
    if (!initStarted) {
      initStarted = true
      void initialize() // syncFromTalk runs at its tail, once the map exists
    } else {
      void refreshStatuses()
      void syncFromTalk()
    }
  },
  { immediate: true },
)

/** Ties page scroll position to intent, so getting to the top doesn't mean
 * hunting for a strip of bare background to grab: typing a search means you
 * want the results below, so jump there; tapping the map background means
 * you want the map, so jump back up. Tapping a pin (locateAddress) doesn't
 * scroll at all — the located-address bubble sits right above the map, so
 * it's already in view without moving the page. */
function scrollHuntToBottom() {
  const el = document.scrollingElement ?? document.documentElement
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

function scrollHuntToTop() {
  const el = document.scrollingElement ?? document.documentElement
  el.scrollTo({ top: 0, behavior: 'smooth' })
}

/** Only geocoded addresses get pins — a growing-over-time set (Talk mode,
 * Hunt's "locate", and turf cutting all geocode on demand). Now ~10k doors
 * and climbing, so every query here pages past PostgREST's 1000-row cap. */
async function fetchMapData() {
  const [addresses, statusRows, summaryRows, todayRes] = await Promise.all([
    fetchAllRows<AddressWithRoster>((from, to) =>
      supabase
        .from('addresses')
        .select('*, persons(count)')
        .not('lat', 'is', null)
        .order('id')
        .range(from, to),
    ),
    fetchAllRows<HouseholdLatestKnock>((from, to) =>
      supabase.from('household_latest_knock').select('*').order('household_id').range(from, to),
    ),
    fetchAllRows<HouseholdKnockSummary>((from, to) =>
      supabase.from('household_knock_summary').select('*').order('household_id').range(from, to),
    ),
    fetchKnockedToday(),
  ])
  applyStatusAndSummary(statusRows, summaryRows, todayRes)
  return addresses
}

/** All turfs (for the door rings), plus which of them are mine — dispatched
 * to me directly or to a squad I'm in today. A sub-turf of mine (my slice of
 * a crew's split) counts only while its parent is still pointed at one of my
 * today-squads — or at a person, which is durable. Turf left pointing at a
 * past day's squad is nobody's until the campaign manager re-dispatches it. */
async function fetchTurfs() {
  if (!auth.profile) return
  const me = auth.profile.id
  const [smRes, turfRes] = await Promise.all([
    supabase
      .from('squad_members')
      .select('squad_id, squads!inner(squad_date)')
      .eq('user_id', me)
      .eq('squads.squad_date', localToday()),
    supabase.from('turfs').select('id, name, color, squad_id, assignee_id, parent_turf_id'),
  ])
  const mySquadIds = new Set((smRes.data ?? []).map((r) => r.squad_id as string))
  const all = (turfRes.data ?? []) as TurfLite[]
  allTurfs.value = all
  const byId = new Map(all.map((t) => [t.id, t]))
  const topMine = (t: TurfLite) =>
    t.parent_turf_id == null &&
    (t.assignee_id === me || (t.squad_id != null && mySquadIds.has(t.squad_id)))
  myTurfIds.value = new Set(
    all
      .filter((t) => {
        if (topMine(t)) return true
        if (t.parent_turf_id == null || t.assignee_id !== me) return false
        const parent = byId.get(t.parent_turf_id)
        return !!parent && (parent.squad_id == null || mySquadIds.has(parent.squad_id))
      })
      .map((t) => t.id),
  )
  if (mySquadIds.size) {
    const { data } = await supabase
      .from('squad_members')
      .select('user_id')
      .in('squad_id', [...mySquadIds])
    squadmateIds.value = new Set((data ?? []).map((r) => r.user_id as string))
  } else {
    squadmateIds.value = new Set()
  }
}

const myTurfColorById = computed(() => new Map(myTurfs.value.map((t) => [t.id, t.color])))
/** Every turf's color, not just yours — "All turf" rings other crews' doors
 * in their own colors. No extra fetch: fetchTurfs already pulls every row. */
const allTurfColorById = computed(() => new Map(allTurfs.value.map((t) => [t.id, t.color])))

async function fetchKnockedToday(): Promise<Set<string>> {
  const rows = await fetchAllRows<{ household_id: string }>((from, to) =>
    supabase
      .from('knock_logs')
      .select('household_id')
      .gte('occurred_at', startOfLocalDayISO())
      .not('household_id', 'is', null)
      .order('id')
      .range(from, to),
  )
  return new Set(rows.map((r) => r.household_id))
}

function applyStatusAndSummary(
  statusData: HouseholdLatestKnock[] | null,
  summaryData: HouseholdKnockSummary[] | null,
  todayData?: Set<string>,
) {
  statusByHousehold.value = new Map((statusData ?? []).map((s) => [s.household_id, s]))
  summaryByHousehold.value = new Map((summaryData ?? []).map((s) => [s.household_id, s]))
  if (todayData) knockedToday.value = todayData
}

/** Paint state for one door on the shared canvas layer. Scout has TWO
 * readings and the turf layer button is the switch between them:
 *
 * TURF LAYER OFF — the progress reading. fill = the door's effective knock
 *   status (doorStatusOutcome, blue when nobody's been yet), plus the
 *   partly-signed green-with-a-yellow-band so "one of the three signed"
 *   doesn't look like a door where nobody has signed at all.
 *
 * TURF LAYER ON — the ground reading. Every door in a turf the layer covers
 *   goes SOLID in that turf's color, inside and ring, so a turf reads as one
 *   block of color and you can see where it ends at a glance. Status colors
 *   step aside for as long as the layer is on and come straight back when
 *   it's off — that's the whole point of it being a toggle. Doors the layer
 *   doesn't cover (someone else's turf in "My turf" mode, unassigned ground
 *   in either) keep their status colors, which is what makes your own turf
 *   pop out of the map.
 *
 * Both readings keep the two navigation bands, because they answer "where am
 * I" rather than "how is it going":
 *   halo = somebody in the org already knocked here TODAY (don't
 *          double-knock) — the one band that survives at tiny-dot zooms.
 *   ring = near-black on the LOCATED door: whatever you just tapped has to
 *          be unmistakable against a screen of many.
 *
 * Never returns null: unlike the turf cutter (which paints only the street
 * being worked), Scout shows every geocoded door, so every door is also
 * tappable. */
function paintForDoor(id: string): DoorPaintState {
  const isLocated = id === locatedAddressId.value
  const halo = knockedToday.value.has(id) ? TODAY_HALO : null
  const turfColor = turfColorFor(id)
  if (turfColor) {
    return {
      fill: turfColor,
      ring: isLocated ? LOCATED_RING : turfColor,
      halo,
      // Palette hues run light (#eab308) to dark (#7c3aed), so the house
      // number has to pick its own contrast.
      ink: inkOn(turfColor),
      emphasis: isLocated,
    }
  }
  const row = statusByHousehold.value.get(id)
  const outcome = doorOutcomeFor(id)
  const partly = doorPartlySigned(row?.outcome, row?.signed_count, row?.person_count)
  return {
    fill: partly ? OUTCOME_HEX.signed : outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX,
    innerRing: partly ? OUTCOME_HEX.maybe : null,
    ring: isLocated ? LOCATED_RING : null,
    halo,
    emphasis: isLocated,
  }
}

/** The turf color this door should wear, or null to leave it on status
 * colors: your own turf's color in "My turf", every turf's own color in
 * "All turf", nothing when the layer is off. Scout already loads every
 * address (with its turf_id) and every turf row, so "All turf" needs no
 * extra fetch — it's the same repaint, different colors. */
function turfColorFor(addressId: string): string | null {
  if (turfShade.value === 'off') return null
  const turfId = turfByAddress.value.get(addressId)
  if (!turfId) return null
  if (turfShade.value === 'mine') return myTurfColorById.value.get(turfId) ?? null
  return allTurfColorById.value.get(turfId) ?? null
}

/** Near-black rings: the door you just tapped, and the "already knocked
 * today" band. Deliberately not themed — like the outcome colors, these
 * have to read the same in every scheme and in direct sun. */
const LOCATED_RING = '#111111'
const TODAY_HALO = '#111111'

// Any state the paint function reads repaints the one canvas (rAF-coalesced
// inside the layer). This replaces what used to be a loop restyling every
// marker's ~18 inline style properties.
//
// Deliberately NOT a deep watch: these refs hold Maps/Sets of ~15k entries
// and a deep traverse on every trigger costs more than the repaint does.
// Whole-set refreshes REPLACE the Map (new reference, so this fires); the
// only in-place mutations are in the realtime feed below, which repaints
// explicitly.
watch(
  [statusByHousehold, knockedToday, myTurfColorById, allTurfColorById, locatedAddressId, turfShade],
  () => doorLayer?.requestRepaint(),
)

function canvasDoorOf(a: AddressWithRoster) {
  const n = houseNumber(a.street)
  return { id: a.id, lat: a.lat!, lng: a.lng!, house: n > 0 ? String(n) : '' }
}

/** Register a door: its row data, its turf membership (for shading), and its
 * point on the canvas layer. Everything that learns about a door at runtime
 * — locate, the street backfill, a geocode landing — goes through here, so
 * the canvas never misses one. */
function registerDoor(a: AddressWithRoster) {
  if (a.turf_id) turfByAddress.value.set(a.id, a.turf_id)
  else turfByAddress.value.delete(a.id)
  if (a.lat == null || a.lng == null) return
  addressById.set(a.id, a)
  doorInfoByAddress.set(a.id, { lat: a.lat, lng: a.lng, street: a.street })
  doorLayer?.upsertDoor(canvasDoorOf(a))
}

function addDoor(a: AddressWithRoster) {
  registerDoor(a)
  doorLayer?.requestRepaint()
}

/** Map taps: a door if one is under the finger (and we're zoomed in enough
 * for that to mean a specific door — at town zoom a 22px tap circle covers
 * half a street), otherwise "let me see the map", which scrolls the page up
 * to it. Pins have no elements of their own now, so this one listener
 * handles both cases. */
function onMapClick(e: google.maps.MapMouseEvent) {
  const zoomedIn = (map?.getZoom() ?? 0) >= PINS_MIN_ZOOM
  const id = zoomedIn && e.latLng ? doorLayer?.doorAt(e.latLng) : null
  const address = id ? addressById.get(id) : null
  if (address) {
    void locateAddress(address)
    return
  }
  scrollHuntToTop()
}

/** Where the map should open: the door this canvasser most recently knocked
 * — they're usually still working that same street when the app reloads.
 * Null when they've never knocked anywhere geocoded. */
async function lastKnockCenter(): Promise<{ lat: number; lng: number } | null> {
  if (!auth.profile) return null
  const { data } = await supabase
    .from('knock_logs')
    .select('occurred_at, addresses!inner(lat, lng)')
    .eq('canvasser_id', auth.profile.id)
    .not('addresses.lat', 'is', null)
    .not('addresses.lng', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(1)
  const loc = (data?.[0] as { addresses: { lat: number; lng: number } } | undefined)?.addresses
  return loc ? { lat: loc.lat, lng: loc.lng } : null
}

// MAP-FIRST STARTUP (2026-07-24, ported from the turf cutter): initialize
// awaits ONLY the Maps API, so the basemap is on screen in well under a
// second. The ~10k addresses and the two ~15k-row knock views used to be
// awaited BEFORE the map was even constructed — the whole "Scout takes
// forever to load" feeling. They now stream in behind a live map and the
// opening frame applies when they land (unless the canvasser already moved
// the map themselves, in which case they're reading it and we leave it be).

async function initialize() {
  pinsLoading.value = true
  try {
    await loadMaps()
  } catch {
    loadError.value = 'Could not load the map. Check your connection.'
    initStarted = false
    pinsLoading.value = false
    return
  }
  if (!mapEl.value) {
    pinsLoading.value = false
    return
  }

  map = new google.maps.Map(mapEl.value, {
    center: FALLBACK_CENTER,
    zoom: DEFAULT_ZOOM,
    // mapId is still required — the member/you-are-here AdvancedMarkers and
    // the cloud style both need it, even though doors are canvas now.
    mapId: GOOGLE_MAPS_MAP_ID,
    renderingType: MAP_RENDERING_TYPE,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    // Default "cooperative" handling requires two fingers to pan (one finger
    // scrolls the page instead) — with our own tap-to-scroll behavior above,
    // one-finger panning is what canvassers actually want here.
    gestureHandling: 'greedy',
  })
  map.addListener('click', (e: google.maps.MapMouseEvent) => onMapClick(e))
  map.addListener('dragstart', () => {
    userMovedMap = true
  })

  doorLayer = new DoorCanvasLayer(map, {
    pinMode: () => pinMode.value,
    paintFor: paintForDoor,
  })
  // Settled pan/zoom: the canvas repaints only if the view outgrew its
  // painted box or landed on a new zoom. Mid-animation it just stretches via
  // its CSS transform — there is nothing per-frame to do here.
  map.addListener('idle', () => doorLayer?.checkView())

  cityLayer = new CityLimitsLayer(map)
  if (showCity.value) void cityLayer.setVisible(true)

  void loadMapData()
}

/** Everything the map needs that isn't the map — fetched behind a basemap
 * that's already interactive. */
async function loadMapData() {
  let mapAddresses: AddressWithRoster[] = []
  let lastCenter: { lat: number; lng: number } | null = null
  try {
    ;[mapAddresses, lastCenter] = await Promise.all([
      fetchMapData(),
      lastKnockCenter(),
      fetchTurfs(),
    ])
  } catch {
    loadError.value = 'Could not load the address data. Check your connection.'
    pinsLoading.value = false
    return
  }
  if (!map) {
    pinsLoading.value = false
    return
  }

  const bounds = new google.maps.LatLngBounds()
  let haveMyTurf = false
  for (const a of mapAddresses) {
    if (a.lat == null || a.lng == null) continue
    registerDoor(a)
    bounds.extend({ lat: a.lat, lng: a.lng })
    if (a.turf_id && myTurfIds.value.has(a.turf_id)) haveMyTurf = true
  }
  doorLayer?.requestRepaint()
  // Opening frame, best anchor first: your (and your today-squad's) turf —
  // the biggest connected patch of it, same best-fit the "My turf" button
  // uses — then your last knocked door, then every pin. (Fitting all ~10k
  // county-wide pins zooms way out and looks like the map "doesn't know
  // where to start".)
  if (!userMovedMap) {
    if (haveMyTurf) focusMyTurf()
    else if (lastCenter) {
      map.setCenter(lastCenter)
      map.setZoom(16)
    } else if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
  }
  pinsLoading.value = false
  // Entering Scout with a door already loaded in Talk: land on that door
  // (locate wins over the turf frame above — you're mid-walk, not arriving).
  void syncFromTalk()
}

/** Re-pull statuses/summaries and recolor existing pins. Called whenever
 * Hunt is revisited after logging knocks. On a failed refresh (flaky field
 * signal) keep the colors we already have rather than blanking them. */
async function refreshStatuses() {
  try {
    const [statusRows, summaryRows, todayRes] = await Promise.all([
      fetchAllRows<HouseholdLatestKnock>((from, to) =>
        supabase.from('household_latest_knock').select('*').order('household_id').range(from, to),
      ),
      fetchAllRows<HouseholdKnockSummary>((from, to) =>
        supabase.from('household_knock_summary').select('*').order('household_id').range(from, to),
      ),
      fetchKnockedToday(),
      fetchTurfs(),
    ])
    applyStatusAndSummary(statusRows, summaryRows, todayRes)
  } catch {
    return
  }
  doorLayer?.requestRepaint()
}

// --- Framing your turf ---
// Turning on "My turf" also flies you there, which is why there's no
// "Zoom to my turf" chip above the map anymore (2026-07-24) — the toggle
// that colors your ground is also the one that takes you to it.
//
// Fitting EVERY door of yours is wrong when your assignment is in pieces:
// two streets in Richwood plus one in Marysville would frame 20km of empty
// county and read as "the map doesn't know where to start". So the doors get
// clustered first and only the biggest cluster is framed.

/** Cell edge for clustering, degrees latitude (~1.1km). Doors in the same or
 * a touching cell count as the same patch of ground; a gap wider than that
 * means genuinely separate parts of an assignment. */
const CLUSTER_CELL_DEG = 0.01

/** Every door of mine, grouped into connected patches, biggest first. */
function myTurfClusters(): { lat: number; lng: number }[][] {
  const cells = new Map<string, { lat: number; lng: number }[]>()
  for (const [addressId, door] of doorInfoByAddress) {
    const turfId = turfByAddress.value.get(addressId)
    if (!turfId || !myTurfIds.value.has(turfId)) continue
    // Longitude cells are widened by 1/cos(lat) so they stay roughly square
    // on the ground rather than skinny this far north.
    const key = `${Math.floor(door.lat / CLUSTER_CELL_DEG)}:${Math.floor(
      (door.lng * Math.cos((door.lat * Math.PI) / 180)) / CLUSTER_CELL_DEG,
    )}`
    const list = cells.get(key)
    if (list) list.push(door)
    else cells.set(key, [door])
  }
  // Flood-fill touching cells (8-neighbour) into clusters.
  const seen = new Set<string>()
  const clusters: { lat: number; lng: number }[][] = []
  for (const key of cells.keys()) {
    if (seen.has(key)) continue
    const doors: { lat: number; lng: number }[] = []
    const stack = [key]
    seen.add(key)
    while (stack.length) {
      const k = stack.pop()!
      doors.push(...(cells.get(k) ?? []))
      const [cx, cy] = k.split(':').map(Number)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = `${cx + dx}:${cy + dy}`
          if (cells.has(n) && !seen.has(n)) {
            seen.add(n)
            stack.push(n)
          }
        }
      }
    }
    clusters.push(doors)
  }
  return clusters.sort((a, b) => b.length - a.length)
}

/** Frame your turf: all of it when it's one patch of ground, otherwise the
 * biggest patch — a best fit beats a useless county-wide zoom. */
function focusMyTurf() {
  if (!map) return
  const clusters = myTurfClusters()
  if (!clusters.length) return
  const bounds = new google.maps.LatLngBounds()
  for (const d of clusters[0]) bounds.extend(d)
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

// --- Live teammate knocks: when anyone on the campaign logs a door, its pin
// recolors and picks up the today-halo immediately — a squad working the
// same neighborhood sees each other's progress without reloading. Undo/redo
// (DELETE/UPDATE on knock_logs) is rarer and self-corrects on the next
// refreshStatuses, so only INSERTs are streamed. ---

let knockFeed: RealtimeChannel | null = null

function subscribeToKnockFeed() {
  knockFeed = supabase
    .channel('hunt-knock-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'knock_logs' }, (payload) => {
      const knock = payload.new as KnockLog
      if (!knock.household_id) return
      // Live-update the status row. signed_count is approximate here (we
      // can't tell a repeat signer from a new one without a refetch —
      // refreshStatuses corrects it on the next visit); person_count falls
      // back to the address's roster embed for a door's first-ever knock.
      const prev = statusByHousehold.value.get(knock.household_id)
      statusByHousehold.value.set(knock.household_id, {
        household_id: knock.household_id,
        outcome: knock.outcome,
        occurred_at: knock.occurred_at,
        signed_count: (prev?.signed_count ?? 0) + (knock.outcome === 'signed' ? 1 : 0),
        person_count: prev?.person_count ?? householdSize(addressById.get(knock.household_id)) ?? 0,
      })
      if (new Date(knock.occurred_at) >= new Date(startOfLocalDayISO())) {
        knockedToday.value.add(knock.household_id)
      }
      // Both writes above are in-place, so repaint explicitly (the watcher
      // above only sees whole-Map replacements). The "plink" is the one-shot
      // pop that makes live progress watchable — bigger for a squadmate than
      // for the rest of the org — and drives its own short animation loop.
      doorLayer?.requestRepaint()
      const mine = squadmateIds.value.has(knock.canvasser_id)
      doorLayer?.plink(knock.household_id, mine ? 2.6 : 1.8, mine ? 750 : 550)
    })
    .subscribe()
}

// --- Search (people + addresses, like Talk's search) ---

function onListInput(value: string) {
  listQuery.value = value
  clearTimeout(searchTimer)
  const q = value.trim()
  if (q.length < 2) {
    searchResults.value = { persons: [], addresses: [] }
    searching.value = false
    return
  }
  searching.value = true
  searchTimer = setTimeout(async () => {
    const pattern = `%${q}%`
    const [personsRes, addressesRes] = await Promise.all([
      supabase
        .from('persons')
        .select('*, addresses(id, street, unit, city, persons(count))')
        .ilike('name', pattern)
        .limit(20),
      // 100 addresses so a whole street fits in one search (scrolling a
      // street top to bottom is the point of the Talk→Scout handoff below).
      supabase.from('addresses').select('*, persons(count)').ilike('street', pattern).limit(100),
    ])
    if (listQuery.value.trim() !== q) return
    // Street order, then house-number order — a street search reads as a
    // walkable list instead of DB insertion order.
    const rows = (addressesRes.data ?? []) as AddressWithRoster[]
    rows.sort(
      (a, b) =>
        streetNameOf(a.street).localeCompare(streetNameOf(b.street)) ||
        houseNumber(a.street) - houseNumber(b.street),
    )
    searchResults.value = {
      persons: (personsRes.data ?? []) as PersonHit[],
      addresses: rows,
    }
    searching.value = false
  }, 250)
}

function summaryFor(addressId: string | null | undefined): HouseholdKnockSummary | null {
  if (!addressId) return null
  return summaryByHousehold.value.get(addressId) ?? null
}

/** Household roster size, straight off the `persons(count)` embed — lets the
 * ratio next to the indicator grid read "out of everyone who lives here"
 * rather than "out of however many times someone's been knocked", so it's
 * meaningful even when nobody's home yet. */
function householdSize(address: Partial<RosterCount> | null | undefined): number | null {
  return address?.persons?.[0]?.count ?? null
}

/** Effective status outcome for a door — latest knock re-read through the
 * all/partly-signed rules (green only when the whole roster signed, yellow
 * while partly signed; see doorStatusOutcome). Drives pins AND the knock
 * button so every surface tells the same story. */
function doorOutcomeFor(addressId: string): KnockOutcome | null {
  const row = statusByHousehold.value.get(addressId)
  if (!row) return null
  return doorStatusOutcome(row.outcome, row.signed_count, row.person_count)
}

/** Knock button color reflects the door's effective status — same data
 * already driving the map pins (household_latest_knock), just re-bucketed
 * into 4 colors instead of the pins' 6. */
function knockColorFor(addressId: string | null | undefined): string {
  if (!addressId) return knockButtonHex(null)
  return knockButtonHex(doorOutcomeFor(addressId))
}

function wasKnockedToday(addressId: string | null | undefined): boolean {
  return !!addressId && knockedToday.value.has(addressId)
}

const locatedStatusClass = computed(() => {
  const s = summaryFor(locatedAddress.value?.id)
  if (!s || s.total_knocks === 0) return 'card-not-knocked'
  return s.reached ? 'card-reached' : 'card-not-reached'
})

// --- Locate: pan/zoom the map, highlight the pin, fill in every house on
// the same street (capped at 50 — geocoding only happens on this explicit
// tap, never on page load, so API cost stays bounded and predictable). ---

function flatDistance(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return (a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2
}

async function locateAddress(address: AddressWithRoster) {
  if (locating.value) return
  locating.value = true
  try {
    if (address.lat == null || address.lng == null) {
      const loc = await geocodeAndCache(address)
      if (loc) Object.assign(address, loc)
    }
    // The previously-located door shrinks back on its own — the whole canvas
    // repaints off locatedAddressId, so there's nothing per-pin to undo.
    locatedAddressId.value = address.id
    locatedAddress.value = address
    addDoor(address)

    if (address.lat != null && address.lng != null && map) {
      map.panTo({ lat: address.lat, lng: address.lng })
      map.setZoom(Math.max(map.getZoom() ?? 14, 17))
    }

    const targetName = streetNameOf(address.street)
    const { data } = await supabase
      .from('addresses')
      .select('*, persons(count)')
      .ilike('street', `%${targetName}`)
    const rows = ((data ?? []) as AddressWithRoster[]).filter(
      (a) => streetNameOf(a.street) === targetName,
    )
    const geocoded = rows.filter((a) => a.lat != null && a.lng != null)
    const missing = rows.filter((a) => a.lat == null || a.lng == null)

    if (address.lat != null && address.lng != null) {
      const origin = { lat: address.lat, lng: address.lng }
      geocoded.sort(
        (a, b) => flatDistance({ lat: a.lat!, lng: a.lng! }, origin) - flatDistance({ lat: b.lat!, lng: b.lng! }, origin),
      )
    }
    missing.sort((a, b) => Math.abs(houseNumber(a.street) - houseNumber(address.street)) -
      Math.abs(houseNumber(b.street) - houseNumber(address.street)))

    for (const a of missing) {
      if (geocoded.length >= NEARBY_CAP) break
      const loc = await geocodeAndCache(a)
      if (loc) {
        Object.assign(a, loc)
        geocoded.push(a)
      }
    }

    for (const a of geocoded.slice(0, NEARBY_CAP)) registerDoor(a)
    doorLayer?.requestRepaint()
  } finally {
    locating.value = false
  }
}

/** Arrive on Scout already oriented on whatever door Talk mode is working:
 * the search box fills with that door's street as though typed (so the list
 * below it is the street's houses, scrollable in walk order) and the map
 * locates the door itself — zoomed in, pin highlighted. Runs once per Talk
 * address, so flipping back after poking around Scout doesn't clobber a
 * manual search or map position on every tab switch. */
let syncedFromTalkId: string | null = null
async function syncFromTalk() {
  const current = talk.selectedAddress
  if (!current || current.id === syncedFromTalkId) return
  syncedFromTalkId = current.id
  const street = streetNameOf(current.street)
  // Title-case for the visible input — matching is case-insensitive anyway.
  onListInput(street.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()))
  await locateAddress(addressById.get(current.id) ?? { ...current })
}

function knock(addressId: string, personId?: string) {
  void talk.loadAddress(addressId, personId)
}

// --- "Where am I": drop/refresh a blue you-are-here dot and pan to it.
// Goes through @capacitor/geolocation so the same call works in a browser
// (falls back to navigator.geolocation) and in the native shells (real OS
// permission prompt instead of the webview's). ---

const locatingMe = ref(false)
const locateError = ref('')
let myPosMarker: google.maps.marker.AdvancedMarkerElement | null = null

async function locateMe() {
  if (!map || locatingMe.value) return
  locatingMe.value = true
  locateError.value = ''
  try {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
    const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
    if (!myPosMarker) {
      const dot = document.createElement('div')
      const s = dot.style
      s.width = '16px'
      s.height = '16px'
      s.borderRadius = '50%'
      s.background = '#4285f4' // Google-blue "you are here" — not themed on purpose
      s.border = '3px solid #ffffff'
      s.boxShadow = '0 0 6px rgba(0, 0, 0, 0.5)'
      myPosMarker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: loc,
        content: dot,
        zIndex: 2000,
        title: 'You are here',
      })
    } else {
      myPosMarker.position = loc
    }
    map.panTo(loc)
    map.setZoom(Math.max(map.getZoom() ?? DEFAULT_ZOOM, 17))
  } catch {
    locateError.value = 'Could not get your location — check location permission for this app.'
  } finally {
    locatingMe.value = false
  }
}

// --- Custom results-list scrollbar: the rows are buttons, so a touch-drag
// starting on one scrolls unreliably (or just triggers the row). A dedicated
// thumb gives a spot that's always just "grab and scroll", and staying custom
// (rather than the native scrollbar) means it looks and behaves the same
// whether this runs in a browser tab or an installed/PWA shell. ---

const resultsListEl = ref<HTMLElement | null>(null)
const thumbHeight = ref(0)
const thumbTop = ref(0)
const showThumb = ref(false)
let resizeObserver: ResizeObserver | null = null

const MIN_THUMB = 32

function recomputeThumb() {
  const el = resultsListEl.value
  if (!el) return
  const { scrollHeight, clientHeight, scrollTop } = el
  if (scrollHeight <= clientHeight + 1) {
    showThumb.value = false
    return
  }
  showThumb.value = true
  const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * clientHeight)
  const maxTop = clientHeight - height
  const scrollableMax = scrollHeight - clientHeight
  const top = scrollableMax > 0 ? (scrollTop / scrollableMax) * maxTop : 0
  thumbHeight.value = height
  thumbTop.value = top
}

function onResultsScroll() {
  recomputeThumb()
}

function onThumbPointerDown(event: PointerEvent) {
  const el = resultsListEl.value
  if (!el) return
  event.preventDefault()
  const track = event.currentTarget as HTMLElement
  track.setPointerCapture(event.pointerId)
  const trackHeight = el.clientHeight
  const scrollableMax = el.scrollHeight - el.clientHeight
  const startY = event.clientY
  const startScrollTop = el.scrollTop

  function onMove(e: PointerEvent) {
    const deltaY = e.clientY - startY
    const maxTop = trackHeight - thumbHeight.value
    const scrollDelta = maxTop > 0 ? (deltaY / maxTop) * scrollableMax : 0
    el!.scrollTop = Math.min(scrollableMax, Math.max(0, startScrollTop + scrollDelta))
  }
  function onUp() {
    track.removeEventListener('pointermove', onMove)
    track.removeEventListener('pointerup', onUp)
  }
  track.addEventListener('pointermove', onMove)
  track.addEventListener('pointerup', onUp)
}

watch(searchResults, () => void nextTick(recomputeThumb))

// --- Map fullscreen toggle. Safari (incl. iOS) only ever exposes the
// webkit-prefixed API, so both directions need a fallback. Google Maps
// doesn't notice its container resized on its own, so nudge it after the
// browser finishes the transition (the 'fullscreenchange' event fires only
// once the change has actually happened). ---

type FullscreenableEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}
type FullscreenableDoc = Document & {
  webkitExitFullscreen?: () => Promise<void> | void
  webkitFullscreenElement?: Element | null
}

function toggleFullscreen() {
  const doc = document as FullscreenableDoc
  const isCurrentlyFullscreen = Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement)
  if (isCurrentlyFullscreen) {
    if (document.exitFullscreen) void document.exitFullscreen()
    else doc.webkitExitFullscreen?.()
    return
  }
  const el = mapWrapEl.value as FullscreenableEl | null
  if (!el) return
  if (el.requestFullscreen) void el.requestFullscreen()
  else el.webkitRequestFullscreen?.()
}

function onFullscreenChange() {
  const doc = document as FullscreenableDoc
  isFullscreen.value = Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement)
  setTimeout(() => {
    if (!map) return
    google.maps.event.trigger(map, 'resize')
    // The canvas sizes itself off the map div — re-measure after the
    // transition or it keeps painting at the old dimensions.
    doorLayer?.checkView()
    doorLayer?.requestRepaint()
  }, 0)
}

onMounted(() => {
  if (resultsListEl.value) {
    resizeObserver = new ResizeObserver(recomputeThumb)
    resizeObserver.observe(resultsListEl.value)
  }
  recomputeThumb()
  subscribeToKnockFeed()
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  if (knockFeed) {
    void supabase.removeChannel(knockFeed)
    knockFeed = null
  }
  doorLayer?.dispose()
  doorLayer = null
  addressById.clear()
  doorInfoByAddress.clear()
  cityLayer?.dispose()
  if (myPosMarker) {
    myPosMarker.map = null
    myPosMarker = null
  }
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
})
</script>

<template>
  <div class="hunt">
    <!-- Whatever was last clicked — a pin on the map or a result below —
         always surfaces here, whether or not it matches the current search. -->
    <div v-if="locatedAddress" v-motion="fadeUp()" class="card located-card" :class="locatedStatusClass">
      <span class="result-left">
        <span class="result-name">
          {{ locatedAddress.street }}{{ locatedAddress.unit ? ' ' + locatedAddress.unit : '' }}
        </span>
        <span v-if="wasKnockedToday(locatedAddress.id)" class="today-badge">Knocked today</span>
      </span>
      <OutcomeIndicatorGrid
        :summary="summaryFor(locatedAddress.id)"
        :household-size="householdSize(locatedAddress)"
      />
      <button
        class="btn btn-sm knock-btn"
        :style="{ background: knockColorFor(locatedAddress.id), color: '#fff' }"
        @click="knock(locatedAddress.id)"
      >
        Knock
      </button>
    </div>

    <!-- No "Zoom to my turf" chip strip anymore (2026-07-24): the map's
         "My turf" layer button both colors your ground and flies you to it,
         so a second control for the same intent was one too many. -->

    <div ref="mapWrapEl" class="map-wrap" :class="{ 'map-wrap-fullscreen': isFullscreen }">
      <div ref="mapEl" class="map"></div>
      <div v-if="pinsLoading" class="pins-loading" role="status" aria-live="polite">
        <span class="pins-loading-spinner" aria-hidden="true"></span>
        Loading pins…
      </div>
      <!-- Flip every pin between a colored dot and its house number. Sits
           top-left, inside the map, opposite the fullscreen button. -->
      <div class="pin-mode-toggle" role="group" aria-label="Pin style">
        <button
          type="button"
          class="pin-mode-btn"
          :class="{ active: pinMode === 'dots' }"
          :aria-pressed="pinMode === 'dots'"
          aria-label="Show pins as dots"
          title="Dots"
          @click="setPinMode('dots')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="12" cy="12" r="6" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="pin-mode-btn"
          :class="{ active: pinMode === 'numbers' }"
          :aria-pressed="pinMode === 'numbers'"
          aria-label="Show pins as house numbers"
          title="House numbers"
          @click="setPinMode('numbers')"
        >
          123
        </button>
      </div>
      <!-- Map layers: the turf layer (ring your doors / every turf's doors
           in its own color — tap the active one for plain status pins) and
           city/village limits. Below the pin-style toggle, same chrome. -->
      <div class="layer-toggle" role="group" aria-label="Map layers">
        <button
          type="button"
          class="layer-btn"
          :class="{ active: turfShade === 'mine' }"
          :aria-pressed="turfShade === 'mine'"
          title="Ring your turf's doors in its color"
          @click="setTurfShade('mine')"
        >
          My turf
        </button>
        <button
          type="button"
          class="layer-btn"
          :class="{ active: turfShade === 'all' }"
          :aria-pressed="turfShade === 'all'"
          title="Ring every turf's doors in its own color"
          @click="setTurfShade('all')"
        >
          All turf
        </button>
        <button
          type="button"
          class="layer-btn"
          :class="{ active: showCity }"
          :aria-pressed="showCity"
          title="Show city and village limits"
          @click="toggleCity"
        >
          City
        </button>
      </div>
      <button
        type="button"
        class="map-fullscreen-btn"
        :aria-label="isFullscreen ? 'Exit fullscreen map' : 'View map fullscreen'"
        @click="toggleFullscreen"
      >
        <!-- Four corner brackets pointing out (enter) / in (exit) — the
             standard fullscreen-toggle glyph, drawn inline so it renders
             identically everywhere instead of depending on font glyph
             support for the unicode fullscreen arrows. -->
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <template v-if="isFullscreen">
            <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </template>
          <template v-else>
            <path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </template>
        </svg>
      </button>
      <button
        type="button"
        class="map-locate-btn"
        :class="{ busy: locatingMe }"
        aria-label="Show my location"
        title="My location"
        @click="locateMe"
      >
        <!-- Crosshair target: circle + four ticks, the standard locate glyph. -->
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <p v-if="loadError" class="muted map-error">{{ loadError }}</p>
    <p v-if="locateError" class="muted map-error">{{ locateError }}</p>
    <p v-if="mapsAuthError" class="muted map-error">
      Google rejected the Maps API key — usually quota, billing, or a referrer restriction on the
      key. The exact reason is logged in the browser console. Search and knock logging still work.
    </p>
    <p v-if="locating" class="muted map-error">Locating nearby doors…</p>

    <input
      :value="listQuery"
      class="street-search"
      type="search"
      placeholder="Search a name or street…"
      aria-label="Search people or addresses"
      @focus="scrollHuntToBottom"
      @input="onListInput(($event.target as HTMLInputElement).value)"
    />

    <div class="results-list-wrap">
    <div ref="resultsListEl" class="results-list" @scroll="onResultsScroll">
      <p v-if="listQuery.trim().length < 2" class="muted empty">
        Type at least 2 characters of a name or street.
      </p>
      <p v-else-if="searching" class="muted empty">Searching…</p>
      <template v-else>
        <div v-if="!searchResults.persons.length && !searchResults.addresses.length" class="muted empty">
          No matches.
        </div>

        <button
          v-for="p in searchResults.persons"
          :key="'p-' + p.id"
          class="result-row"
          :class="{ 'result-active': p.household_id === locatedAddressId }"
          @click="p.addresses && locateAddress(p.addresses as AddressWithRoster)"
        >
          <span class="result-left">
            <span class="result-name">{{ p.name }}</span>
            <span class="muted result-sub">
              {{ p.addresses ? `${p.addresses.street}${p.addresses.unit ? ' ' + p.addresses.unit : ''}` : 'No address on file' }}
            </span>
            <span v-if="wasKnockedToday(p.household_id)" class="today-badge">Knocked today</span>
          </span>
          <OutcomeIndicatorGrid
            :summary="summaryFor(p.household_id)"
            :household-size="householdSize(p.addresses)"
          />
          <button
            v-if="p.household_id"
            class="btn btn-sm knock-btn"
            :style="{ background: knockColorFor(p.household_id), color: '#fff' }"
            @click.stop="knock(p.household_id!, p.id)"
          >
            Knock
          </button>
        </button>

        <button
          v-for="a in searchResults.addresses"
          :key="'a-' + a.id"
          class="result-row"
          :class="{ 'result-active': a.id === locatedAddressId }"
          @click="locateAddress(a)"
        >
          <span class="result-left">
            <span class="result-name">{{ a.street }}{{ a.unit ? ' ' + a.unit : '' }}</span>
            <span v-if="wasKnockedToday(a.id)" class="today-badge">Knocked today</span>
          </span>
          <OutcomeIndicatorGrid :summary="summaryFor(a.id)" :household-size="householdSize(a)" />
          <button
            class="btn btn-sm knock-btn"
            :style="{ background: knockColorFor(a.id), color: '#fff' }"
            @click.stop="knock(a.id)"
          >
            Knock
          </button>
        </button>
      </template>
    </div>

    <div
      v-if="showThumb"
      class="scrollbar-track"
      @pointerdown="onThumbPointerDown"
    >
      <div
        class="scrollbar-thumb"
        :style="{ height: thumbHeight + 'px', transform: `translateY(${thumbTop}px)` }"
      ></div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.hunt {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.map-wrap {
  position: relative;
}

.map {
  /* `svh` (small viewport height) instead of `dvh` — `dvh` shrinks/grows as
   * the on-screen keyboard opens/closes while typing in the search box
   * below, and that live resize was what made the page jump on focus/blur. */
  height: min(45svh, 420px);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
}

/* Actual Fullscreen API target — filling the screen only takes effect once
 * the browser grants fullscreen, driven by the JS-toggled class below rather
 * than the `:fullscreen` pseudo-class so old-Safari's webkit-prefixed event
 * (no matching prefixed pseudo-class) still gets the right layout. */
.map-wrap-fullscreen {
  background: #000;
}

.map-wrap-fullscreen .map {
  height: 100%;
  border-radius: 0;
  border: none;
}

.map-fullscreen-btn {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.map-fullscreen-btn:hover {
  background: var(--surface-2);
}

/* Same chrome as the fullscreen button, stacked directly beneath it. */
.map-locate-btn {
  position: absolute;
  top: calc(0.6rem + 36px + 0.5rem);
  right: 0.6rem;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.map-locate-btn:hover {
  background: var(--surface-2);
}

.map-locate-btn.busy svg {
  animation: pins-spin 0.9s linear infinite;
}

/* Status pill while the initial pin set loads/renders. Top-center so it clears
 * both the fullscreen button (top-right) and the pin-style toggle (top-left). */
.pins-loading {
  position: absolute;
  top: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.6rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}

/* Segmented dots/numbers control, styled to match the fullscreen button but
 * as a two-button group in the opposite (top-left) corner. */
.pin-mode-toggle {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.pin-mode-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.pin-mode-btn + .pin-mode-btn {
  border-left: 1px solid var(--border);
}

.pin-mode-btn.active {
  background: var(--accent);
  color: #fff;
}

.pin-mode-btn:not(.active):hover {
  background: var(--surface-2);
}

/* Layers control, stacked directly beneath the pin-style toggle. */
.layer-toggle {
  position: absolute;
  top: calc(0.6rem + 36px + 0.5rem);
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.layer-btn {
  min-height: 36px;
  padding: 0 0.6rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}

.layer-btn + .layer-btn {
  border-left: 1px solid var(--border);
}

.layer-btn.active {
  background: var(--accent);
  color: #fff;
}

.layer-btn:not(.active):hover {
  background: var(--surface-2);
}

.pins-loading-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: pins-spin 0.7s linear infinite;
}

@keyframes pins-spin {
  to {
    transform: rotate(360deg);
  }
}

.map-error {
  margin: 0;
  font-size: 0.88rem;
}

.street-search {
  width: 100%;
  min-height: 48px;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}

.street-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}


/* A violet family, distinct from the list's blue accent highlight below —
 * this card is "what's currently focused on the map", a different concern
 * from "which list row matches it", so they shouldn't share a color. */
.located-card {
  --located-accent: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 2px solid var(--located-accent);
  border-left-width: 6px;
  background: color-mix(in srgb, var(--located-accent) 6%, var(--surface));
}

/* Left stripe still carries knock status (muted/green/amber) — a separate
 * signal from the violet "this is focused" framing above. */
.located-card.card-not-knocked {
  border-left-color: var(--text-muted);
}

.located-card.card-reached {
  border-left-color: var(--success);
}

.located-card.card-not-reached {
  border-left-color: var(--warning);
}

.located-card .result-name {
  color: var(--located-accent);
}

.results-list-wrap {
  position: relative;
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 40svh;
  overflow-y: auto;
  /* Scrolling here is via touch/wheel plus the custom thumb beside it —
   * the native scrollbar is hidden so behavior/look is consistent across
   * browser tab vs installed PWA shell. */
  scrollbar-width: none;
  padding-right: max(0.6rem, calc(var(--scrollbar-width, 8px) + 0.6rem));
}

.results-list::-webkit-scrollbar {
  display: none;
}

/* Wide invisible touch target with a visible thumb centered in it — easy to
 * grab with a thumb (finger), sized/colored/shaped per the active appearance
 * scheme (see lib/themes.ts) instead of one fixed look for every scheme. */
.scrollbar-track {
  position: absolute;
  top: 0;
  right: -0.1rem;
  bottom: 0;
  width: max(2.25rem, calc(var(--scrollbar-width, 8px) + 1.25rem));
  touch-action: none;
}

.scrollbar-thumb {
  position: absolute;
  right: 0.4rem;
  width: var(--scrollbar-width, 8px);
  border-radius: var(--scrollbar-radius, 999px);
  background: var(--scrollbar-color, var(--accent));
  box-shadow: var(--scrollbar-shadow, none);
  transition: filter 0.1s ease;
}

.scrollbar-track:hover .scrollbar-thumb,
.scrollbar-track:active .scrollbar-thumb {
  filter: brightness(1.15);
}

.result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  width: 100%;
  min-height: 48px;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.result-row:hover {
  background: var(--surface-2);
}

.result-row.result-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.result-left {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  flex: 1;
  text-align: left;
}

.result-name,
.result-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-name {
  font-weight: 600;
}

.result-sub {
  font-size: 0.82rem;
}

.knock-btn {
  flex-shrink: 0;
  font-weight: 700;
}

/* "Someone already knocked here today" — same signal as the dark halo on the
 * map pins, in word form for the list rows and located card. */
.today-badge {
  align-self: flex-start;
  padding: 0.1rem 0.45rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #fff;
  background: #111;
  border-radius: 999px;
}

.empty {
  font-size: 0.9rem;
  padding: 0.4rem 0.1rem;
}
</style>
