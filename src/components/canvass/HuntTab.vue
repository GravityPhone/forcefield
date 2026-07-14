<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { Geolocation } from '@capacitor/geolocation'
import { loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import { CityLimitsLayer, TurfAreasLayer, densityDotElement, readMapPref, writeMapPref } from '@/lib/mapLayers'
import type { DoorPoint } from '@/lib/mapLayers'
import { geocodeAndCache, geocodeMissing, streetsAtPoints } from '@/lib/geocode'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { localToday, startOfLocalDayISO } from '@/lib/day'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'
import { OUTCOME_HEX, PIN_DEFAULT_HEX, doorStatusOutcome, knockButtonHex } from '@/lib/outcomes'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import OutcomeIndicatorGrid from './OutcomeIndicatorGrid.vue'
import { fadeUp } from '@/lib/motion'
import type { Address, HouseholdKnockSummary, HouseholdLatestKnock, KnockLog, KnockOutcome, Person } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }
const NEARBY_CAP = 50
const DEFAULT_ZOOM = 14
/** Below this zoom, numbers mode falls back to plain dots — house numbers
 * only mean something when you're close enough to be looking at one street,
 * and number chips floating over a whole town read as noise. */
const NUMBERS_MIN_ZOOM = 16
/** Below this zoom, individual pins give way to clickable density dots (tap
 * one to zoom into that area). With ~10k geocoded doors, town-level zooms
 * would otherwise mean thousands of live marker elements — the main thing
 * that made Hunt crawl on phones. */
const PINS_MIN_ZOOM = 15
/** Hard cap on live pin elements even at close zoom (nearest to the map
 * center win) — a safety net, not something a normal viewport hits. */
const MAX_VISIBLE_PINS = 2000

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
// so a canvasser's choice survives reloads/navigation.
type PinMode = 'dots' | 'numbers'
const pinMode = ref<PinMode>(readStoredPinMode())
const locatedAddressId = ref<string | null>(null)
/** Tracked so numbers mode can fall back to dots when zoomed out; only
 * threshold CROSSINGS trigger a restyle (per-tick loops over every marker
 * were the map's old perf sin). */
let mapZoom = DEFAULT_ZOOM

function readStoredPinMode(): PinMode {
  try {
    return localStorage.getItem('hunt-pin-mode') === 'numbers' ? 'numbers' : 'dots'
  } catch {
    return 'dots'
  }
}

function setPinMode(mode: PinMode) {
  if (pinMode.value === mode) return
  pinMode.value = mode
  try {
    localStorage.setItem('hunt-pin-mode', mode)
  } catch {
    /* private-mode / storage disabled — the toggle still works this session */
  }
  refreshAllPinStyles()
}

// Map layer toggles (turf area shading, city limits), prefs shared with the
// turf cutter so the map looks the same on both pages. Turf shading is for
// EVERYONE — a canvasser with no assignment still gets to see where all the
// turfs are (own turf shades stronger).
const showAreas = ref(readMapPref('map-show-areas', true))
const showCity = ref(readMapPref('map-show-city', false))

function toggleAreas() {
  showAreas.value = !showAreas.value
  writeMapPref('map-show-areas', showAreas.value)
  areasLayer?.setVisible(showAreas.value)
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
/** Every geocoded door we know about, markers or not — the source of truth
 * the viewport renderer draws from. Markers are created lazily for doors in
 * (or near) the current view and torn down when they leave it. */
const addressById = new Map<string, AddressWithRoster>()
let densityMarkers: google.maps.marker.AdvancedMarkerElement[] = []
let densityZoom = -1
let areasLayer: TurfAreasLayer | null = null
let cityLayer: CityLimitsLayer | null = null
let markersByAddress = new Map<string, google.maps.marker.AdvancedMarkerElement>()
let initStarted = false
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => talk.activeTab,
  (tab) => {
    if (tab !== 'hunt') return
    if (!initStarted) {
      initStarted = true
      void initialize()
    } else {
      void refreshStatuses()
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
 * Hunt's "locate", and "Place pins" all geocode on demand). Now ~10k doors
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

/** All turfs (for the area shading), plus which of them are mine — dispatched
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

/** Any turf doors at all — gates the "All turf" zoom chip. */
const anyTurfDoors = computed(() => turfByAddress.value.size > 0)

/** Redraw the shaded turf areas from whatever doors the map knows about. */
function rebuildTurfAreas() {
  if (!areasLayer) return
  const doorsByTurf = new Map<string, DoorPoint[]>()
  for (const [addressId, turfId] of turfByAddress.value) {
    const door = doorInfoByAddress.get(addressId)
    if (!door) continue
    const list = doorsByTurf.get(turfId)
    if (list) list.push(door)
    else doorsByTurf.set(turfId, [door])
  }
  void areasLayer.setTurfs(
    allTurfs.value
      .filter((t) => doorsByTurf.has(t.id))
      .map((t) => ({
        id: t.id,
        color: t.color,
        doors: doorsByTurf.get(t.id)!,
        emphasis: myTurfIds.value.has(t.id),
      })),
  )
}

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

/** Each pin is a plain DOM dot (AdvancedMarkerElement content) rather than a
 * classic google.maps.Symbol — far lighter than legacy Marker overlays.
 * Fixed size — the viewport renderer handles decluttering (density dots when
 * zoomed out), so there's no per-zoom rescale loop (that loop, running over
 * every marker on every zoom tick, was the main thing making the map feel
 * sluggish). Located pin stands out larger with a dark ring and sits above
 * its neighbors. */
function styleMarker(marker: google.maps.marker.AdvancedMarkerElement, addressId: string) {
  const el = marker.content as HTMLElement
  const outcome = doorOutcomeFor(addressId)
  const isLocated = addressId === locatedAddressId.value
  // Common look (shared by both modes): outcome color, white ring, dark ring
  // + raised when it's the located pin.
  const s = el.style
  s.boxSizing = 'border-box'
  s.cursor = 'pointer'
  s.background = outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX
  s.border = isLocated ? '3px solid #111' : '1.5px solid #ffffff'
  // Dark halo = someone already knocked here today (any canvasser) — the
  // "don't re-knock" cue, distinct from the located pin's solid dark border.
  s.outline = knockedToday.value.has(addressId) ? '2px solid #111' : ''
  s.outlineOffset = '1.5px'
  // "Your turf" ring: the turf's own color, so multiple turfs (yours vs your
  // squad's) stay tellable apart. Layered under the usual drop shadow.
  const turfId = turfByAddress.value.get(addressId)
  const turfColor = turfId ? myTurfColorById.value.get(turfId) : undefined
  s.boxShadow = turfColor
    ? `0 0 0 3px ${turfColor}, 0 0 3px rgba(0, 0, 0, 0.45)`
    : '0 0 3px rgba(0, 0, 0, 0.45)'
  s.color = '#ffffff'
  s.display = 'flex'
  s.alignItems = 'center'
  s.justifyContent = 'center'
  s.fontWeight = '700'
  s.lineHeight = '1'
  marker.zIndex = isLocated ? 1000 : 1

  // `data-house` is stamped in addOrUpdateMarker; fall back to a dot when a
  // row has no parseable house number so those pins never render blank —
  // or when the map is zoomed too far out for house numbers to mean much.
  if (pinMode.value === 'numbers' && mapZoom >= NUMBERS_MIN_ZOOM && el.dataset.house) {
    el.textContent = el.dataset.house
    s.borderRadius = '7px'
    s.width = 'auto'
    s.height = isLocated ? '24px' : '19px'
    s.minWidth = isLocated ? '24px' : '19px'
    s.padding = '0 5px'
    s.fontSize = isLocated ? '13px' : '11px'
  } else {
    el.textContent = ''
    const size = isLocated ? 22 : 14
    s.borderRadius = '50%'
    s.width = `${size}px`
    s.height = `${size}px`
    s.minWidth = ''
    s.padding = ''
    s.fontSize = ''
  }
}

function refreshAllPinStyles() {
  for (const [id, marker] of markersByAddress) styleMarker(marker, id)
}

/** Register a door (turf membership, shading info, viewport source-of-truth)
 * without creating a marker for it. */
function registerDoor(a: AddressWithRoster) {
  if (a.turf_id) turfByAddress.value.set(a.id, a.turf_id)
  else turfByAddress.value.delete(a.id)
  if (a.lat == null || a.lng == null) return
  addressById.set(a.id, a)
  doorInfoByAddress.set(a.id, { lat: a.lat, lng: a.lng, street: a.street })
}

function addOrUpdateMarker(a: AddressWithRoster) {
  registerDoor(a)
  if (a.lat == null || a.lng == null || !map) return
  let marker = markersByAddress.get(a.id)
  if (!marker) {
    const content = document.createElement('div')
    const num = houseNumber(a.street)
    if (num > 0) content.dataset.house = String(num)
    marker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat: a.lat, lng: a.lng },
      title: `${a.street}${a.unit ? ' ' + a.unit : ''}`,
      content,
      gmpClickable: true,
      map,
    })
    marker.addListener('gmp-click', () => void locateAddress(a))
    markersByAddress.set(a.id, marker)
  } else {
    marker.position = { lat: a.lat, lng: a.lng }
  }
  styleMarker(marker, a.id)
}

// --- Viewport-scoped pins ---
// Runs on every map 'idle' (pan/zoom settled, never per zoom tick). Zoomed
// out: no individual pins at all, just density dots — tap one to zoom into
// that patch. Zoomed in: real pins, but only for doors inside the padded
// viewport; everything that left the view is torn down.

function renderVisibleDoors() {
  if (!map) return
  const zoom = map.getZoom() ?? mapZoom
  if (zoom < PINS_MIN_ZOOM) {
    for (const [id, marker] of markersByAddress) {
      if (id === locatedAddressId.value) continue // keep the highlighted pin
      marker.map = null
      markersByAddress.delete(id)
    }
    renderDensityDots(zoom)
    return
  }
  clearDensityDots()
  const b = map.getBounds()
  if (!b) return
  // Pad by half a viewport each side so short pans land on already-built pins.
  const ne = b.getNorthEast()
  const sw = b.getSouthWest()
  const padLat = (ne.lat() - sw.lat()) / 2
  const padLng = (ne.lng() - sw.lng()) / 2
  const minLat = sw.lat() - padLat
  const maxLat = ne.lat() + padLat
  const minLng = sw.lng() - padLng
  const maxLng = ne.lng() + padLng
  let inView: AddressWithRoster[] = []
  for (const a of addressById.values()) {
    if (a.lat! >= minLat && a.lat! <= maxLat && a.lng! >= minLng && a.lng! <= maxLng) {
      inView.push(a)
    }
  }
  if (inView.length > MAX_VISIBLE_PINS) {
    const c = map.getCenter()
    const origin = c ? { lat: c.lat(), lng: c.lng() } : FALLBACK_CENTER
    inView = inView
      .sort(
        (a, b2) =>
          flatDistance({ lat: a.lat!, lng: a.lng! }, origin) -
          flatDistance({ lat: b2.lat!, lng: b2.lng! }, origin),
      )
      .slice(0, MAX_VISIBLE_PINS)
  }
  const keepIds = new Set(inView.map((a) => a.id))
  for (const [id, marker] of markersByAddress) {
    if (!keepIds.has(id) && id !== locatedAddressId.value) {
      marker.map = null
      markersByAddress.delete(id)
    }
  }
  for (const a of inView) {
    if (!markersByAddress.has(a.id)) addOrUpdateMarker(a)
  }
}

/** Grid-bucket every known door into ~72px cells and draw one clickable
 * density dot per cell (same look as the Squad/Turf cluster bubbles).
 * Tapping a dot zooms to that cell's doors — repeat taps walk you down
 * until real pins take over at PINS_MIN_ZOOM. */
function renderDensityDots(zoom: number) {
  // Buckets are global (not viewport-dependent) — panning at the same zoom
  // reuses the existing dots; only a zoom change re-bins.
  if (zoom === densityZoom && densityMarkers.length) return
  clearDensityDots()
  if (!map) return
  densityZoom = zoom
  const worldPx = 256 * 2 ** zoom
  const cellLng = (360 * 72) / worldPx
  const cellLat = cellLng * 0.77 // ≈cos(40°N): keeps cells visually squarish here
  type Bucket = { n: number; sumLat: number; sumLng: number; b: google.maps.LatLngBounds }
  const buckets = new Map<string, Bucket>()
  for (const a of addressById.values()) {
    const key = `${Math.floor(a.lat! / cellLat)}:${Math.floor(a.lng! / cellLng)}`
    let bkt = buckets.get(key)
    if (!bkt) buckets.set(key, (bkt = { n: 0, sumLat: 0, sumLng: 0, b: new google.maps.LatLngBounds() }))
    bkt.n++
    bkt.sumLat += a.lat!
    bkt.sumLng += a.lng!
    bkt.b.extend({ lat: a.lat!, lng: a.lng! })
  }
  for (const bkt of buckets.values()) {
    const marker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat: bkt.sumLat / bkt.n, lng: bkt.sumLng / bkt.n },
      content: densityDotElement(bkt.n),
      zIndex: 300,
      gmpClickable: true,
      map,
    })
    marker.addListener('gmp-click', () => map?.fitBounds(bkt.b, 48))
    densityMarkers.push(marker)
  }
}

function clearDensityDots() {
  for (const marker of densityMarkers) marker.map = null
  densityMarkers = []
  densityZoom = -1
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

async function initialize() {
  pinsLoading.value = true
  let mapAddresses: AddressWithRoster[] = []
  let lastCenter: { lat: number; lng: number } | null = null
  try {
    ;[mapAddresses, , lastCenter] = await Promise.all([
      fetchMapData(),
      loadMaps(),
      lastKnockCenter(),
      fetchTurfs(),
    ])
  } catch {
    loadError.value = 'Could not load the map or address data. Check your connection.'
    initStarted = false
    pinsLoading.value = false
    return
  }
  if (!mapEl.value) {
    pinsLoading.value = false
    return
  }

  map = new google.maps.Map(mapEl.value, {
    center: lastCenter ?? FALLBACK_CENTER,
    zoom: lastCenter ? 16 : DEFAULT_ZOOM,
    // mapId is what lets pins render as AdvancedMarker elements instead of
    // the heavier legacy Marker overlays.
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
  // Tapping the map background (not a pin — markers fire their own 'gmp-click'
  // instead of bubbling to this one) means "let me see the map", so bring
  // it into view. Tapping a pin doesn't hit this listener at all.
  map.addListener('click', scrollHuntToTop)
  mapZoom = map.getZoom() ?? DEFAULT_ZOOM
  map.addListener('zoom_changed', () => {
    const wasClose = mapZoom >= NUMBERS_MIN_ZOOM
    mapZoom = map?.getZoom() ?? mapZoom
    if (pinMode.value === 'numbers' && wasClose !== mapZoom >= NUMBERS_MIN_ZOOM) {
      refreshAllPinStyles()
    }
  })
  // Pins and density dots are (re)built on every settled pan/zoom — never
  // per zoom tick, and never for doors outside the padded viewport.
  map.addListener('idle', renderVisibleDoors)

  areasLayer = new TurfAreasLayer(map)
  areasLayer.setVisible(showAreas.value)
  cityLayer = new CityLimitsLayer(map)
  if (showCity.value) void cityLayer.setVisible(true)

  const bounds = new google.maps.LatLngBounds()
  const myTurfBounds = new google.maps.LatLngBounds()
  for (const a of mapAddresses) {
    if (a.lat == null || a.lng == null) continue
    registerDoor(a)
    bounds.extend({ lat: a.lat, lng: a.lng })
    if (a.turf_id && myTurfIds.value.has(a.turf_id)) {
      myTurfBounds.extend({ lat: a.lat, lng: a.lng })
    }
  }
  // Opening frame, best anchor first: all of your (and your today-squad's)
  // turf together — the crew's whole assignment in one look — then your last
  // knocked door, then every pin. (Fitting all ~10k county-wide pins zooms
  // way out and looks like the map "doesn't know where to start".)
  if (!myTurfBounds.isEmpty()) map.fitBounds(myTurfBounds, 64)
  else if (!lastCenter && !bounds.isEmpty()) map.fitBounds(bounds, 48)
  rebuildTurfAreas()
  pinsLoading.value = false
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
  refreshAllPinStyles()
  rebuildTurfAreas()
}

/** Pan/zoom to a turf's doors (the chips above the map). Works off door
 * data, not markers — the turf's pins may not be built yet. */
function focusTurf(turfId: string) {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const [addressId, door] of doorInfoByAddress) {
    if (turfByAddress.value.get(addressId) === turfId) {
      bounds.extend({ lat: door.lat, lng: door.lng })
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

// --- Geolocate what's on screen ---
// Coordinates are the only way to know a door is "on screen", so the button
// works street-wise: every street with at least one pinned door in view gets
// ALL of its doors geocoded. A confirm gates batches over 100 (the Geocoder
// runs one door at a time, so big batches take minutes).

const GEOLOCATE_WARN_AT = 100
const geolocating = ref(false)
const geoProgress = ref('')
const geoNote = ref('')
let geoNoteTimer: ReturnType<typeof setTimeout> | undefined
let huntUnmounted = false

function flashGeoNote(msg: string) {
  geoNote.value = msg
  clearTimeout(geoNoteTimer)
  geoNoteTimer = setTimeout(() => {
    geoNote.value = ''
  }, 3500)
}

async function geolocateVisible() {
  if (!map || geolocating.value) return
  const bounds = map.getBounds()
  if (!bounds) return
  geolocating.value = true
  try {
    // Streets in view, two ways: any street with a pinned door on screen,
    // plus reverse-geocoding a spread of viewport points — so panning over
    // a completely pinless neighborhood still finds its streets.
    const names = new Set<string>()
    for (const [id, marker] of markersByAddress) {
      if (!marker.position || !bounds.contains(marker.position)) continue
      const info = doorInfoByAddress.get(id)
      const name = info ? streetNameOf(info.street) : ''
      if (name) names.add(name)
    }
    const ne = bounds.getNorthEast()
    const sw = bounds.getSouthWest()
    const cLat = (ne.lat() + sw.lat()) / 2
    const cLng = (ne.lng() + sw.lng()) / 2
    const qLat = (ne.lat() - sw.lat()) / 4
    const qLng = (ne.lng() - sw.lng()) / 4
    const sampled = await streetsAtPoints([
      { lat: cLat, lng: cLng },
      { lat: cLat + qLat, lng: cLng + qLng },
      { lat: cLat + qLat, lng: cLng - qLng },
      { lat: cLat - qLat, lng: cLng + qLng },
      { lat: cLat - qLat, lng: cLng - qLng },
    ])
    for (const s of sampled) names.add(s.name)
    if (!names.size) {
      flashGeoNote("Couldn't identify any streets here — zoom in on a neighborhood and try again.")
      return
    }
    const missing: AddressWithRoster[] = []
    for (const name of names) {
      const { data } = await supabase
        .from('addresses')
        .select('*, persons(count)')
        .ilike('street', `%${name}`)
        .is('lat', null)
      for (const r of (data ?? []) as AddressWithRoster[]) {
        if (streetNameOf(r.street) === name) missing.push(r)
      }
    }
    if (!missing.length) {
      flashGeoNote('Every door on the streets in view already has a pin.')
      return
    }
    if (
      missing.length > GEOLOCATE_WARN_AT &&
      !window.confirm(
        `Place pins for ${missing.length} doors? That's a big batch — they geocode one at a time, so it can take several minutes. Continue?`,
      )
    ) {
      return
    }
    let done = 0
    geoProgress.value = `0/${missing.length}`
    await geocodeMissing(
      missing,
      (id, loc) => {
        const a = missing.find((m) => m.id === id)
        if (a) {
          a.lat = loc.lat
          a.lng = loc.lng
          addOrUpdateMarker(a)
        }
        geoProgress.value = `${++done}/${missing.length}`
      },
      () => huntUnmounted,
    )
    if (!huntUnmounted) {
      rebuildTurfAreas()
      flashGeoNote(`Placed ${done} of ${missing.length} pins.`)
    }
  } finally {
    geolocating.value = false
    geoProgress.value = ''
  }
}

/** Re-frame around every turf that's yours — same view the map opens with. */
function focusAllMyTurf() {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const [addressId, marker] of markersByAddress) {
    const turfId = turfByAddress.value.get(addressId)
    if (turfId && myTurfIds.value.has(turfId) && marker.position) {
      bounds.extend(marker.position)
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

/** Frame every turf anyone has — the whole campaign's cut geography in one
 * look. Works off door data (not markers), so it doesn't matter whether the
 * pins are built yet. */
function focusAllTurf() {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const [addressId, door] of doorInfoByAddress) {
    if (turfByAddress.value.has(addressId)) bounds.extend({ lat: door.lat, lng: door.lng })
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

// --- Live teammate knocks: when anyone on the campaign logs a door, its pin
// recolors and picks up the today-halo immediately — a squad working the
// same neighborhood sees each other's progress without reloading. Undo/redo
// (DELETE/UPDATE on knock_logs) is rarer and self-corrects on the next
// refreshStatuses, so only INSERTs are streamed. ---

let knockFeed: RealtimeChannel | null = null

/** One-shot pop on a pin as its knock lands — the "plink" that makes live
 * progress watchable. Squadmates' knocks pop bigger than the rest of the
 * org's. Web Animations API (not a CSS class) so back-to-back knocks on
 * nearby doors each restart cleanly. */
function plinkMarker(addressId: string, isSquadmate: boolean) {
  const marker = markersByAddress.get(addressId)
  const el = marker?.content as HTMLElement | undefined
  if (!marker || !el) return
  const prevZ = marker.zIndex
  marker.zIndex = 1500
  const anim = el.animate(
    [
      { transform: 'scale(1)' },
      { transform: `scale(${isSquadmate ? 2.6 : 1.8})` },
      { transform: 'scale(1)' },
    ],
    { duration: isSquadmate ? 750 : 550, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  )
  anim.onfinish = () => {
    marker.zIndex = prevZ ?? 1
  }
}

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
      const marker = markersByAddress.get(knock.household_id)
      if (marker) {
        styleMarker(marker, knock.household_id)
        plinkMarker(knock.household_id, squadmateIds.value.has(knock.canvasser_id))
      }
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
      supabase.from('addresses').select('*, persons(count)').ilike('street', pattern).limit(20),
    ])
    if (listQuery.value.trim() !== q) return
    searchResults.value = {
      persons: (personsRes.data ?? []) as PersonHit[],
      addresses: (addressesRes.data ?? []) as AddressWithRoster[],
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
    // Shrink the previously-located pin back to normal (the per-zoom restyle
    // loop used to do this implicitly; it's gone now, so do it explicitly).
    const prevLocatedId = locatedAddressId.value
    locatedAddressId.value = address.id
    locatedAddress.value = address
    if (prevLocatedId && prevLocatedId !== address.id) {
      const prev = markersByAddress.get(prevLocatedId)
      if (prev) styleMarker(prev, prevLocatedId)
    }
    addOrUpdateMarker(address)

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

    for (const a of geocoded.slice(0, NEARBY_CAP)) addOrUpdateMarker(a)
  } finally {
    locating.value = false
  }
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
  huntUnmounted = true
  resizeObserver?.disconnect()
  if (knockFeed) {
    void supabase.removeChannel(knockFeed)
    knockFeed = null
  }
  for (const marker of markersByAddress.values()) marker.map = null
  markersByAddress.clear()
  clearDensityDots()
  addressById.clear()
  doorInfoByAddress.clear()
  areasLayer?.dispose()
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

    <!-- Turf assigned to you (or a squad you're in today) gets a zoom chip;
         "All turf" frames every turf anyone has — visible to every role, so
         a plain canvasser can still see how the campaign's ground is cut. -->
    <div v-if="myTurfs.length || anyTurfDoors" class="turf-chips">
      <button
        v-if="myTurfs.length > 1"
        class="turf-chip"
        :style="{ '--turf-color': 'var(--accent)' }"
        @click="focusAllMyTurf"
      >
        <span class="turf-chip-dot" aria-hidden="true"></span>
        All our turf
      </button>
      <button
        v-for="t in myTurfs"
        :key="t.id"
        class="turf-chip"
        :style="{ '--turf-color': t.color }"
        @click="focusTurf(t.id)"
      >
        <span class="turf-chip-dot" aria-hidden="true"></span>
        Your turf: {{ t.name }}
      </button>
      <button
        v-if="anyTurfDoors"
        class="turf-chip"
        :style="{ '--turf-color': 'var(--text-muted)' }"
        @click="focusAllTurf"
      >
        <span class="turf-chip-dot" aria-hidden="true"></span>
        All turf
      </button>
    </div>

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
      <!-- Map layers: turf area shading and city/village limits. Below the
           pin-style toggle, same chrome. -->
      <div class="layer-toggle" role="group" aria-label="Map layers">
        <button
          type="button"
          class="layer-btn"
          :class="{ active: showAreas }"
          :aria-pressed="showAreas"
          title="Shade each turf's area on the map"
          @click="toggleAreas"
        >
          Turf
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
        class="place-pins-btn"
        :disabled="geolocating"
        title="Place a pin for every door on the streets in view"
        @click="geolocateVisible"
      >
        {{ geolocating ? geoProgress || 'Placing…' : 'Place pins' }}
      </button>
      <div v-if="geoNote" class="pins-loading" role="status" aria-live="polite">{{ geoNote }}</div>
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

/* "Your turf" chips — each in its turf's map color. */
.turf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.turf-chip {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 36px;
  padding: 0.3rem 0.7rem;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text);
  background: color-mix(in srgb, var(--turf-color) 10%, var(--surface));
  border: 1.5px solid var(--turf-color);
  border-radius: 999px;
  cursor: pointer;
}

.turf-chip:hover {
  background: color-mix(in srgb, var(--turf-color) 18%, var(--surface));
}

.turf-chip-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--turf-color);
  border: 1.5px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
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
/* Standalone pin-filling action, stacked under the layer toggles (it's an
 * action, not a toggle, so it doesn't share their strip). */
.place-pins-btn {
  position: absolute;
  top: calc(0.6rem + 36px + 0.5rem + 36px + 0.5rem);
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

.place-pins-btn:disabled {
  color: var(--text-muted);
  cursor: default;
}

.place-pins-btn:not(:disabled):hover {
  background: var(--surface-2);
}

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
