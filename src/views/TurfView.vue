<script setup lang="ts">
// Turf cutter (team leads + admins): the same Google map as Hunt, but pins
// are paint targets instead of knock targets. Cutting works like a
// highlighter — tap one door to anchor a sweep, tap another door down the
// same street to close it, and every door in that house-number range lights
// up under a colored stroke. Sweeps stack into a draft turf that gets a
// name and an assignee: a squad (the day crew sorts out who takes what) or
// a single canvasser. Saving stamps addresses.turf_id server-side via the
// set_turf_segments RPC, which is what Hunt reads to show "your turf".
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import type { SelectOption } from '@/components/ui/AppSelect.vue'
import { loadMaps, mapsAuthError } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  CityLimitsLayer,
  TurfAreasLayer,
  corridorFor,
  readMapPref,
  writeMapPref,
} from '@/lib/mapLayers'
import type { DoorPoint } from '@/lib/mapLayers'
import { geocodeAndCache } from '@/lib/geocode'
import { supabase } from '@/lib/supabase'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import { useAuthStore } from '@/stores/auth'
import { useSquadsStore } from '@/stores/squads'
import { PARITY_LABELS } from '@/types'
import type { ChatProfile, Turf, TurfParity, TurfSegment } from '@/types'

// Same fallback as Hunt: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }

/** Slim address row — everything turf cutting needs, nothing Talk-specific. */
interface AddressLite {
  id: string
  street: string
  unit: string | null
  city: string
  zip: string | null
  lat: number | null
  lng: number | null
  turf_id: string | null
}

interface TurfWithMeta extends Turf {
  turf_segments: TurfSegment[]
  assignee: ChatProfile | null
  squad: { id: string; name: string; squad_date: string } | null
}

/** A sweep in the draft tray. memberIds/doorCount come from the full address
 * table (not just geocoded pins), so the door count is exact. */
interface DraftSegment {
  key: string
  street_name: string
  city: string | null
  range_start: number
  range_end: number
  parity: TurfParity
  memberIds: string[]
  doorCount: number
  /** Doors matching the range but already claimed by a different turf —
   * they stay where they are (first claim wins). */
  takenCount: number
}

// Distinct map hues; a new turf takes the first color no existing turf uses.
const PALETTE = [
  '#7c3aed', '#0ea5e9', '#f97316', '#10b981', '#ef4444',
  '#eab308', '#ec4899', '#14b8a6', '#6366f1', '#84cc16',
]

const auth = useAuthStore()
const squadsStore = useSquadsStore()

const mapEl = ref<HTMLElement | null>(null)
const pinsLoading = ref(false)
const loadError = ref('')
const saveError = ref('')
const saving = ref(false)

const turfs = ref<TurfWithMeta[]>([])
const people = ref<ChatProfile[]>([])

// --- Draft turf state ---
const draftName = ref('')
const segments = ref<DraftSegment[]>([])
const anchor = ref<AddressLite | null>(null)
const parityChoice = ref<TurfParity>('both')
const editingTurfId = ref<string | null>(null)
// 'none' | 'squad:<id>' | 'user:<id>' — Reka's SelectItem forbids '' values.
const assignChoice = ref('none')
const sweepBusy = ref(false)

let map: google.maps.Map | null = null
let clusterer: MarkerClusterer | null = null
let areasLayer: TurfAreasLayer | null = null
let cityLayer: CityLimitsLayer | null = null
/** Draft-sweep shading lives on its own Data layer so it can restyle and
 * clear independently of the saved-turf areas. */
let draftData: google.maps.Data | null = null
const draftFeaturesBySeg = new Map<string, google.maps.Data.Feature[]>()
let initStarted = false
const markersByAddress = new Map<string, google.maps.marker.AdvancedMarkerElement>()
const addressById = new Map<string, AddressLite>()
const segPolylines = new Map<string, google.maps.Polyline>()
/** Street rows already pulled for a sweep, so range tweaks don't re-query. */
const streetCache = new Map<string, AddressLite[]>()
let segKeyCounter = 0

const turfColorById = computed(() => new Map(turfs.value.map((t) => [t.id, t.color])))

// Layer toggles, persisted per device like Hunt's pin mode.
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

const draftColor = computed(() => {
  if (editingTurfId.value) {
    return turfs.value.find((t) => t.id === editingTurfId.value)?.color ?? PALETTE[0]
  }
  const used = new Set(turfs.value.map((t) => t.color))
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[turfs.value.length % PALETTE.length]
})

const draftMemberIds = computed(() => {
  const all = new Set<string>()
  for (const s of segments.value) for (const id of s.memberIds) all.add(id)
  return all
})

const draftDoorCount = computed(() => draftMemberIds.value.size)
const draftTakenCount = computed(() => segments.value.reduce((n, s) => n + s.takenCount, 0))

// Transient feedback line ("Added WALNUT ST — 41 doors") that temporarily
// replaces the standing instructions in the sweep bar.
const flashMsg = ref('')
let flashTimer: ReturnType<typeof setTimeout> | undefined

function flash(msg: string) {
  flashMsg.value = msg
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashMsg.value = ''
  }, 3500)
}

const hint = computed(() => {
  if (sweepBusy.value) return 'Sweeping…'
  if (flashMsg.value) return flashMsg.value
  if (anchor.value) {
    const a = anchor.value
    return `Anchor down at ${a.street} — tap another door on ${streetNameOf(a.street)} to sweep the range (or tap the anchor again to cancel).`
  }
  return 'Double-tap the map to add or remove a whole street. For part of a street, tap a door, then a second door on it.'
})

// --- Assignment options: today's squads + every canvasser. A turf being
// edited may point at a past day's squad that loadToday won't return — keep
// it selectable so editing doesn't silently drop the assignment. ---
const assignOptions = computed<SelectOption[]>(() => {
  const opts: SelectOption[] = [{ value: 'none', label: 'Unassigned' }]
  const squadIds = new Set<string>()
  for (const s of squadsStore.squads) {
    squadIds.add(s.id)
    opts.push({ value: `squad:${s.id}`, label: `Squad — ${s.name}` })
  }
  if (editingTurfId.value) {
    const t = turfs.value.find((x) => x.id === editingTurfId.value)
    if (t?.squad && !squadIds.has(t.squad.id)) {
      opts.push({ value: `squad:${t.squad.id}`, label: `Squad — ${t.squad.name} (${t.squad.squad_date})` })
    }
  }
  for (const p of people.value) {
    opts.push({ value: `user:${p.id}`, label: `Canvasser — ${p.display_name || p.username}` })
  }
  return opts
})

function personName(p: ChatProfile | null): string {
  return p ? p.display_name || p.username : '—'
}

function assignmentLabel(t: TurfWithMeta): string {
  if (t.squad) return `Squad: ${t.squad.name} (${t.squad.squad_date})`
  if (t.assignee) return `Canvasser: ${personName(t.assignee)}`
  return 'Unassigned'
}

function segmentLabel(s: { street_name: string; range_start: number; range_end: number; parity: TurfParity }): string {
  const side = s.parity === 'both' ? '' : ` · ${PARITY_LABELS[s.parity].toLowerCase()}`
  return `${s.street_name} ${s.range_start}–${s.range_end}${side}`
}

// --- Map + pins ---

function styleMarker(marker: google.maps.marker.AdvancedMarkerElement, a: AddressLite) {
  const el = marker.content as HTMLElement
  const s = el.style
  const isAnchor = anchor.value?.id === a.id
  const inDraft = draftMemberIds.value.has(a.id)
  // While editing, doors still stamped to the turf but swept OUT of the
  // draft show as unclaimed — the map previews the save.
  const stampedColor =
    a.turf_id && !(editingTurfId.value && a.turf_id === editingTurfId.value)
      ? turfColorById.value.get(a.turf_id)
      : undefined

  const color = inDraft ? draftColor.value : stampedColor ?? '#9aa0a6'
  const size = isAnchor ? 24 : inDraft ? 17 : 13
  s.boxSizing = 'border-box'
  s.cursor = 'pointer'
  s.width = `${size}px`
  s.height = `${size}px`
  s.borderRadius = '50%'
  s.background = color
  s.border = isAnchor ? '3px solid #111' : '1.5px solid #ffffff'
  s.boxShadow = '0 0 3px rgba(0, 0, 0, 0.45)'
  s.animation = isAnchor ? 'turf-anchor-pulse 1.1s ease-in-out infinite' : ''
  marker.zIndex = isAnchor ? 1000 : inDraft ? 500 : 1
}

function restyleAll() {
  for (const [id, marker] of markersByAddress) {
    const a = addressById.get(id)
    if (a) styleMarker(marker, a)
  }
}

function upsertMarker(a: AddressLite) {
  addressById.set(a.id, a)
  if (a.lat == null || a.lng == null || !map) return
  let marker = markersByAddress.get(a.id)
  if (!marker) {
    marker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat: a.lat, lng: a.lng },
      title: `${a.street}${a.unit ? ' ' + a.unit : ''}`,
      content: document.createElement('div'),
      gmpClickable: true,
    })
    marker.addListener('gmp-click', () => void onPinTap(a.id))
    markersByAddress.set(a.id, marker)
    clusterer?.addMarker(marker)
  }
  styleMarker(marker, a)
}

async function fetchAddresses(): Promise<AddressLite[]> {
  const { data, error } = await supabase
    .from('addresses')
    .select('id, street, unit, city, zip, lat, lng, turf_id')
    .not('lat', 'is', null)
    .limit(2000)
  if (error) throw error
  return (data ?? []) as AddressLite[]
}

async function fetchTurfs() {
  const { data } = await supabase
    .from('turfs')
    .select(
      '*, turf_segments(*), assignee:profiles!turfs_assignee_id_fkey(id, username, display_name), squad:squads!turfs_squad_id_fkey(id, name, squad_date)',
    )
    .order('created_at')
  turfs.value = (data ?? []) as TurfWithMeta[]
}

async function initialize() {
  pinsLoading.value = true
  let rows: AddressLite[] = []
  try {
    ;[rows] = await Promise.all([
      fetchAddresses(),
      fetchTurfs(),
      loadMaps(),
      squadsStore.loadToday(),
      supabase
        .from('profiles')
        .select('id, username, display_name')
        .order('username')
        .then((res) => {
          people.value = (res.data ?? []) as ChatProfile[]
        }),
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
    center: FALLBACK_CENTER,
    zoom: 14,
    mapId: GOOGLE_MAPS_MAP_ID,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
    // Double-click/tap is the street toggle here, not zoom (pinch and the
    // +/- controls still zoom).
    disableDoubleClickZoom: true,
  })
  map.addListener('dblclick', (e: google.maps.MapMouseEvent) => {
    if (e.latLng) void onMapDoubleClick(e.latLng)
  })
  clusterer = new MarkerClusterer({ map, markers: [] })

  areasLayer = new TurfAreasLayer(map)
  areasLayer.setVisible(showAreas.value)
  cityLayer = new CityLimitsLayer(map)
  if (showCity.value) void cityLayer.setVisible(true)
  draftData = new google.maps.Data({ map })
  draftData.setStyle((f) => ({
    fillColor: (f.getProperty('color') as string) || '#7c3aed',
    fillOpacity: 0.2,
    strokeOpacity: 0,
    clickable: false,
    zIndex: 0,
  }))

  const bounds = new google.maps.LatLngBounds()
  for (const a of rows) {
    upsertMarker(a)
    if (a.lat != null && a.lng != null) bounds.extend({ lat: a.lat, lng: a.lng })
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
  buildSavedAreas()
  pinsLoading.value = false
}

/** Shade every saved turf (except the one being edited — its shape is being
 * redrawn live as the draft). */
function buildSavedAreas() {
  if (!areasLayer) return
  const doorsByTurf = new Map<string, DoorPoint[]>()
  for (const a of addressById.values()) {
    if (!a.turf_id || a.lat == null || a.lng == null) continue
    if (editingTurfId.value && a.turf_id === editingTurfId.value) continue
    const list = doorsByTurf.get(a.turf_id)
    const door = { lat: a.lat, lng: a.lng, street: a.street }
    if (list) list.push(door)
    else doorsByTurf.set(a.turf_id, [door])
  }
  void areasLayer.setTurfs(
    turfs.value
      .filter((t) => doorsByTurf.has(t.id))
      .map((t) => ({ id: t.id, color: t.color, doors: doorsByTurf.get(t.id)! })),
  )
}

/** Re-pull addresses + turfs after a save/delete (turf_id stamps changed
 * server-side) and repaint. */
async function reloadAll() {
  const [rows] = await Promise.all([fetchAddresses(), fetchTurfs()])
  for (const a of rows) upsertMarker(a)
  streetCache.clear()
  restyleAll()
  buildSavedAreas()
}

// --- Sweeping ---

async function onPinTap(addressId: string) {
  const a = addressById.get(addressId)
  if (!a || sweepBusy.value) return
  if (!anchor.value) {
    anchor.value = a
    restyleAll()
    return
  }
  if (anchor.value.id === a.id) {
    anchor.value = null
    restyleAll()
    return
  }
  const from = anchor.value
  if (streetNameOf(from.street) !== streetNameOf(a.street)) {
    // Different street: move the anchor rather than erroring — tapping around
    // to find the right starting door shouldn't require a cancel step.
    anchor.value = a
    restyleAll()
    return
  }
  const lo = Math.min(houseNumber(from.street), houseNumber(a.street))
  const hi = Math.max(houseNumber(from.street), houseNumber(a.street))
  anchor.value = null
  await addSegment(streetNameOf(from.street), from.city, lo, hi, parityChoice.value)
}

async function fetchStreetRows(streetName: string, city: string | null): Promise<AddressLite[]> {
  const cacheKey = `${streetName}|${city ?? ''}`
  const cached = streetCache.get(cacheKey)
  if (cached) return cached
  // Suffix match ("%WALNUT ST") like Hunt's locate, then exact-name filter —
  // this pulls EVERY row on the street (geocoded or not), so counts are real.
  const { data } = await supabase
    .from('addresses')
    .select('id, street, unit, city, zip, lat, lng, turf_id')
    .ilike('street', `%${streetName}`)
  let rows = ((data ?? []) as AddressLite[]).filter((r) => streetNameOf(r.street) === streetName)
  if (city) rows = rows.filter((r) => r.city.toUpperCase() === city.toUpperCase())
  streetCache.set(cacheKey, rows)
  return rows
}

function matchesSegment(a: AddressLite, seg: Pick<DraftSegment, 'range_start' | 'range_end' | 'parity'>): boolean {
  const n = houseNumber(a.street)
  if (n < seg.range_start || n > seg.range_end) return false
  return seg.parity === 'both' || (n % 2 === 0) === (seg.parity === 'even')
}

/** (Re)derive a segment's members from its street rows, refresh its
 * highlighter stroke, and repaint pins. */
async function computeSegment(seg: DraftSegment) {
  const rows = await fetchStreetRows(seg.street_name, seg.city)
  const members = rows.filter((a) => matchesSegment(a, seg))
  const free = members.filter(
    (a) => !a.turf_id || a.turf_id === editingTurfId.value,
  )
  seg.memberIds = free.map((a) => a.id)
  seg.doorCount = free.length
  seg.takenCount = members.length - free.length

  // Newly-discovered geocoded doors on this street get pins too, so the
  // stroke never floats over empty map.
  for (const a of members) if (!markersByAddress.has(a.id)) upsertMarker(a)

  segPolylines.get(seg.key)?.setMap(null)
  segPolylines.delete(seg.key)
  const located = free.filter((a) => a.lat != null && a.lng != null)
  located.sort((a, b) => houseNumber(a.street) - houseNumber(b.street))
  const path = located.map((a) => ({ lat: a.lat!, lng: a.lng! }))
  if (path.length >= 2 && map) {
    segPolylines.set(
      seg.key,
      new google.maps.Polyline({
        map,
        path,
        strokeColor: draftColor.value,
        strokeOpacity: 0.7,
        strokeWeight: 6,
        clickable: false,
      }),
    )
  }

  // Shaded swath under the stroke — the "color over the area" preview.
  if (draftData) {
    for (const f of draftFeaturesBySeg.get(seg.key) ?? []) draftData.remove(f)
    draftFeaturesBySeg.delete(seg.key)
    const corridor = await corridorFor(
      located.map((a) => ({ lat: a.lat!, lng: a.lng!, street: a.street })),
    )
    if (corridor) {
      const added = draftData.addGeoJson({
        type: 'Feature',
        geometry: corridor.geometry,
        properties: { color: draftColor.value },
      })
      draftFeaturesBySeg.set(seg.key, added)
    }
  }
  restyleAll()
}

function removeDraftShading(segKey: string) {
  if (!draftData) return
  for (const f of draftFeaturesBySeg.get(segKey) ?? []) draftData.remove(f)
  draftFeaturesBySeg.delete(segKey)
}

async function addSegment(
  streetName: string,
  city: string | null,
  lo: number,
  hi: number,
  parity: TurfParity,
) {
  sweepBusy.value = true
  try {
    // reactive(): computeSegment fills memberIds/doorCount in AFTER the push,
    // and those writes must invalidate draftMemberIds/draftDoorCount.
    const seg: DraftSegment = reactive({
      key: `seg-${++segKeyCounter}`,
      street_name: streetName,
      city,
      range_start: lo,
      range_end: hi,
      parity,
      memberIds: [],
      doorCount: 0,
      takenCount: 0,
    })
    segments.value.push(seg)
    await computeSegment(seg)
  } finally {
    sweepBusy.value = false
  }
}

function removeSegment(seg: DraftSegment) {
  segments.value = segments.value.filter((s) => s.key !== seg.key)
  segPolylines.get(seg.key)?.setMap(null)
  segPolylines.delete(seg.key)
  removeDraftShading(seg.key)
  restyleAll()
}

async function onSegmentRangeChange(seg: DraftSegment) {
  if (seg.range_end < seg.range_start) {
    ;[seg.range_start, seg.range_end] = [seg.range_end, seg.range_start]
  }
  await computeSegment(seg)
}

async function onSegmentParityChange(seg: DraftSegment, parity: string) {
  seg.parity = parity as TurfParity
  await computeSegment(seg)
}

function clearDraft() {
  segments.value = []
  for (const line of segPolylines.values()) line.setMap(null)
  segPolylines.clear()
  for (const key of [...draftFeaturesBySeg.keys()]) removeDraftShading(key)
  anchor.value = null
  editingTurfId.value = null
  draftName.value = ''
  assignChoice.value = 'none'
  saveError.value = ''
  restyleAll()
  // Restore the saved shading of whatever turf was being edited.
  buildSavedAreas()
}

// --- Street toggling: double-click/tap anywhere on the map snaps to the
// closest pinned door and toggles that door's ENTIRE street in or out of the
// draft. That makes multi-street turf painting fast: double-tap street after
// street to add them, double-tap an added street again to drop it. The
// two-tap anchor sweep above stays for partial-street ranges. ---

/** Farthest a double-tap can be from any pinned door and still count —
 * beyond this the tap was probably a stray zoom attempt, not a selection. */
const SNAP_RADIUS_M = 300

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(s))
}

function nearestDoor(lat: number, lng: number): { door: AddressLite; meters: number } | null {
  let best: AddressLite | null = null
  let bestD = Infinity
  for (const a of addressById.values()) {
    if (a.lat == null || a.lng == null) continue
    const d = metersBetween(lat, lng, a.lat, a.lng)
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best ? { door: best, meters: bestD } : null
}

/** Draft segments already covering this street (in the same city, when known).
 * Both the map double-tap toggle and the search-result add consult this so a
 * street can never land in the draft twice. */
function matchingSegments(streetName: string, city: string | null) {
  return segments.value.filter(
    (s) =>
      s.street_name === streetName &&
      (!s.city || !city || s.city.toUpperCase() === city.toUpperCase()),
  )
}

async function onMapDoubleClick(latLng: google.maps.LatLng) {
  if (sweepBusy.value) return
  const hit = nearestDoor(latLng.lat(), latLng.lng())
  if (!hit || hit.meters > SNAP_RADIUS_M) {
    flash('No mapped door near that spot — try closer to a street with pins, or search below.')
    return
  }
  anchor.value = null
  const name = streetNameOf(hit.door.street)
  const already = matchingSegments(name, hit.door.city)
  if (already.length) {
    for (const s of already) removeSegment(s)
    flash(`Removed ${name} from the draft.`)
    return
  }
  await sweepWholeStreet(name, hit.door.city)
}

/** Add an entire street (its full house-number span) as one draft segment,
 * then pin down its unmapped doors. Both the double-tap toggle and the
 * street search land here. Guards against adding a street that's already in
 * the draft — the map path pre-checks, but rapid search-result taps would
 * otherwise stack duplicate segments. */
async function sweepWholeStreet(streetName: string, city: string | null, zoomTo = false) {
  // Bail if another sweep is mid-flight: a second rapid tap would otherwise
  // clear the duplicate check below before the first one's addSegment lands.
  if (sweepBusy.value) return
  if (matchingSegments(streetName, city).length) {
    flash(`${streetName} is already in the draft — double-tap it on the map to remove it.`)
    if (zoomTo) await materializeStreetPins(streetName, city, true)
    return
  }
  let rows: AddressLite[]
  // Hold the busy flag across the door fetch — addSegment only raises it once
  // it starts, leaving the fetch window open to concurrent taps otherwise.
  sweepBusy.value = true
  try {
    rows = await fetchStreetRows(streetName, city)
  } finally {
    sweepBusy.value = false
  }
  if (!rows.length) {
    flash(`No doors found on ${streetName}.`)
    return
  }
  const nums = rows.map((r) => houseNumber(r.street))
  await addSegment(streetName, city, Math.min(...nums), Math.max(...nums), parityChoice.value)
  flash(`Added ${streetName} — ${rows.length} doors. Double-tap it again to remove it.`)
  await materializeStreetPins(streetName, city, zoomTo)
}

/** Streets pulled in by search (or a double-tap near a sparsely-pinned
 * street) can hold doors that were never geocoded, so the sweep would float
 * over empty map. Geocode a capped batch of them, drop their pins, refresh
 * the segment's stroke, and optionally zoom the map to the street. */
const GEOCODE_BATCH_CAP = 25

async function materializeStreetPins(streetName: string, city: string | null, zoomTo: boolean) {
  const rows = await fetchStreetRows(streetName, city)
  const fitToStreet = () => {
    if (!map) return
    const bounds = new google.maps.LatLngBounds()
    for (const a of rows) {
      if (a.lat != null && a.lng != null) bounds.extend({ lat: a.lat, lng: a.lng })
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, 72)
  }
  // Zoom to what's already pinned right away — don't make the user wait for
  // geocoding to see where the street is.
  if (zoomTo) fitToStreet()

  const missing = rows.filter((a) => a.lat == null || a.lng == null).slice(0, GEOCODE_BATCH_CAP)
  let added = 0
  for (const a of missing) {
    const loc = await geocodeAndCache(a)
    if (loc) {
      a.lat = loc.lat
      a.lng = loc.lng
      upsertMarker(a)
      added++
    }
  }
  if (added) {
    const seg = segments.value.find((s) => s.street_name === streetName && s.city === city)
    if (seg) await computeSegment(seg)
    if (zoomTo) fitToStreet()
  }
}

// --- Street search: the non-map way in. Typing "walnut" lists matching
// streets with their door counts and number spans; tapping one sweeps the
// whole street, zooms the map to it, and pins down its unmapped doors
// (trim the range in the tray afterwards). ---

const streetQuery = ref('')
const streetMatches = ref<{ street_name: string; city: string; count: number; lo: number; hi: number }[]>([])
const streetSearching = ref(false)
let streetTimer: ReturnType<typeof setTimeout> | undefined

function onStreetInput(value: string) {
  streetQuery.value = value
  clearTimeout(streetTimer)
  const q = value.trim()
  if (q.length < 2) {
    streetMatches.value = []
    streetSearching.value = false
    return
  }
  streetSearching.value = true
  streetTimer = setTimeout(async () => {
    const { data } = await supabase
      .from('addresses')
      .select('street, city')
      .ilike('street', `%${q}%`)
      .limit(600)
    if (streetQuery.value.trim() !== q) return
    const groups = new Map<string, { street_name: string; city: string; count: number; lo: number; hi: number }>()
    for (const r of (data ?? []) as { street: string; city: string }[]) {
      const name = streetNameOf(r.street)
      if (!name) continue
      const key = `${name}|${r.city.toUpperCase()}`
      const n = houseNumber(r.street)
      const g = groups.get(key)
      if (!g) groups.set(key, { street_name: name, city: r.city, count: 1, lo: n, hi: n })
      else {
        g.count++
        g.lo = Math.min(g.lo, n)
        g.hi = Math.max(g.hi, n)
      }
    }
    streetMatches.value = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 8)
    streetSearching.value = false
  }, 250)
}

async function addWholeStreet(m: { street_name: string; city: string }) {
  streetQuery.value = ''
  streetMatches.value = []
  // Bring the map back on screen — the payoff of picking a search result is
  // watching the street light up, not a new row in the tray below.
  mapEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  await sweepWholeStreet(m.street_name, m.city, true)
}

// --- Save / edit / delete ---

async function saveTurf() {
  saveError.value = ''
  const name = draftName.value.trim()
  if (!name) {
    saveError.value = 'Give the turf a name.'
    return
  }
  if (!segments.value.length) {
    saveError.value = 'Sweep at least one street range first.'
    return
  }
  saving.value = true
  try {
    const [kind, id] = assignChoice.value.split(':')
    const assignment = {
      squad_id: kind === 'squad' ? id : null,
      assignee_id: kind === 'user' ? id : null,
    }
    let turfId = editingTurfId.value
    if (turfId) {
      const { error } = await supabase
        .from('turfs')
        .update({ name, ...assignment, updated_at: new Date().toISOString() })
        .eq('id', turfId)
      if (error) throw error
    } else {
      const { data, error } = await supabase
        .from('turfs')
        .insert({ name, color: draftColor.value, ...assignment, created_by: auth.profile?.id })
        .select('id')
        .single()
      if (error || !data) throw error ?? new Error('insert failed')
      turfId = data.id as string
    }
    const { error: rpcError } = await supabase.rpc('set_turf_segments', {
      target_turf_id: turfId,
      segments: segments.value.map((s) => ({
        street_name: s.street_name,
        city: s.city,
        range_start: s.range_start,
        range_end: s.range_end,
        parity: s.parity,
      })),
    })
    if (rpcError) throw rpcError
    clearDraft()
    await reloadAll()
  } catch {
    saveError.value = 'Could not save the turf — try again.'
  } finally {
    saving.value = false
  }
}

async function editTurf(t: TurfWithMeta) {
  clearDraft()
  editingTurfId.value = t.id
  draftName.value = t.name
  assignChoice.value = t.squad_id ? `squad:${t.squad_id}` : t.assignee_id ? `user:${t.assignee_id}` : 'none'
  // Hide this turf's saved shading — the draft redraws it live.
  buildSavedAreas()
  for (const s of t.turf_segments) {
    await addSegment(s.street_name, s.city, s.range_start, s.range_end, s.parity)
  }
  focusTurf(t.id)
  focusDraft()
}

async function deleteTurf(t: TurfWithMeta) {
  if (!window.confirm(`Delete turf "${t.name}"? Its doors become unassigned.`)) return
  if (editingTurfId.value === t.id) clearDraft()
  await supabase.from('turfs').delete().eq('id', t.id)
  await reloadAll()
}

function focusTurf(turfId: string) {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const a of addressById.values()) {
    if (a.turf_id === turfId && a.lat != null && a.lng != null) {
      bounds.extend({ lat: a.lat, lng: a.lng })
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

const draftCardEl = ref<HTMLElement | null>(null)

function focusDraft() {
  draftCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

onMounted(() => {
  if (!initStarted) {
    initStarted = true
    void initialize()
  }
})

onUnmounted(() => {
  clusterer?.clearMarkers()
  markersByAddress.clear()
  for (const line of segPolylines.values()) line.setMap(null)
  segPolylines.clear()
  areasLayer?.dispose()
  cityLayer?.dispose()
  draftData?.setMap(null)
  draftFeaturesBySeg.clear()
})
</script>

<template>
  <AppShell title="Turf">
    <div class="stack">
      <!-- Sweep status + side filter: the "controls" of the highlighter. -->
      <div class="sweep-bar" :style="{ '--draft-color': draftColor }">
        <span class="sweep-dot" :class="{ armed: !!anchor }" aria-hidden="true"></span>
        <p class="sweep-hint">{{ hint }}</p>
        <div class="parity-toggle" role="group" aria-label="Which side of the street to sweep">
          <button
            v-for="p in (['both', 'even', 'odd'] as const)"
            :key="p"
            class="parity-btn"
            :class="{ active: parityChoice === p }"
            @click="parityChoice = p"
          >
            {{ p === 'both' ? 'Both' : p === 'even' ? 'Even' : 'Odd' }}
          </button>
        </div>
      </div>

      <div class="map-wrap">
        <div ref="mapEl" class="map"></div>
        <div v-if="pinsLoading" class="pins-loading" role="status" aria-live="polite">
          <span class="pins-loading-spinner" aria-hidden="true"></span>
          Loading pins…
        </div>
        <!-- Map layers: turf area shading and city/village limits. -->
        <div class="layer-toggle" role="group" aria-label="Map layers">
          <button
            type="button"
            class="layer-btn"
            :class="{ active: showAreas }"
            :aria-pressed="showAreas"
            title="Shade turf areas"
            @click="toggleAreas"
          >
            Areas
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
      </div>
      <p v-if="loadError" class="muted map-error">{{ loadError }}</p>
      <p v-if="mapsAuthError" class="muted map-error">
        Google rejected the Maps API key — usually quota, billing, or a referrer restriction on
        the key. The exact reason is logged in the browser console.
      </p>

      <!-- Non-map entry point: sweep a whole street by name. -->
      <input
        :value="streetQuery"
        class="street-search"
        type="search"
        placeholder="…or search a street to sweep it whole"
        aria-label="Search streets to add to the turf"
        @input="onStreetInput(($event.target as HTMLInputElement).value)"
      />
      <div v-if="streetSearching" class="muted search-note">Searching…</div>
      <div v-else-if="streetMatches.length" class="street-matches">
        <button v-for="m in streetMatches" :key="m.street_name + m.city" class="street-match" @click="addWholeStreet(m)">
          <span class="street-match-name">{{ m.street_name }}</span>
          <span class="muted">{{ m.city }} · {{ m.count }} doors · {{ m.lo }}–{{ m.hi }}</span>
        </button>
      </div>

      <!-- Draft tray: the turf being cut. -->
      <div ref="draftCardEl" class="card draft-card" :style="{ '--draft-color': draftColor }">
        <h3 class="draft-title">
          <span class="draft-swatch" aria-hidden="true"></span>
          {{ editingTurfId ? 'Editing turf' : 'New turf' }}
          <span v-if="draftDoorCount" class="draft-count">{{ draftDoorCount }} doors</span>
        </h3>

        <template v-if="segments.length">
          <div class="seg-list">
            <div v-for="seg in segments" :key="seg.key" class="seg-chip">
              <div class="seg-chip-main">
                <span class="seg-street">{{ seg.street_name }}</span>
                <span class="muted seg-city">{{ seg.city ?? 'any city' }}</span>
              </div>
              <div class="seg-chip-controls">
                <input
                  type="number"
                  class="seg-num"
                  :value="seg.range_start"
                  min="0"
                  aria-label="Range start"
                  @change="seg.range_start = Number(($event.target as HTMLInputElement).value); onSegmentRangeChange(seg)"
                />
                <span class="muted">–</span>
                <input
                  type="number"
                  class="seg-num"
                  :value="seg.range_end"
                  min="0"
                  aria-label="Range end"
                  @change="seg.range_end = Number(($event.target as HTMLInputElement).value); onSegmentRangeChange(seg)"
                />
                <AppSelect
                  class="seg-parity"
                  small
                  :options="[
                    { value: 'both', label: 'Both sides' },
                    { value: 'even', label: 'Even side' },
                    { value: 'odd', label: 'Odd side' },
                  ]"
                  :model-value="seg.parity"
                  aria-label="Which side of the street"
                  @update:model-value="onSegmentParityChange(seg, $event)"
                />
                <span class="seg-doors" :class="{ 'seg-doors-empty': !seg.doorCount }">
                  {{ seg.doorCount }} doors
                </span>
                <button class="btn btn-ghost btn-sm seg-remove" aria-label="Remove this street range" @click="removeSegment(seg)">
                  ✕
                </button>
              </div>
              <p v-if="seg.takenCount" class="muted seg-taken">
                {{ seg.takenCount }} of these doors already belong to another turf and stay there.
              </p>
            </div>
          </div>
        </template>
        <p v-else class="muted empty-note">
          No streets swept yet — double-tap the map near a street, tap two doors for part of one,
          or search a street by name.
        </p>

        <div class="draft-form">
          <input
            v-model="draftName"
            class="draft-name"
            type="text"
            maxlength="80"
            placeholder="Turf name (e.g. Walnut &amp; Maple loop)"
            aria-label="Turf name"
          />
          <AppSelect v-model="assignChoice" :options="assignOptions" aria-label="Assign this turf to" />
          <div class="draft-actions">
            <button class="btn btn-primary" :disabled="saving" @click="saveTurf">
              {{ saving ? 'Saving…' : editingTurfId ? 'Save changes' : 'Create turf' }}
            </button>
            <button v-if="segments.length || editingTurfId" class="btn btn-ghost" :disabled="saving" @click="clearDraft">
              {{ editingTurfId ? 'Cancel edit' : 'Clear' }}
            </button>
          </div>
          <p v-if="draftTakenCount" class="muted">
            {{ draftTakenCount }} swept doors stay with their current turf (first claim wins).
          </p>
          <p v-if="saveError" class="error">{{ saveError }}</p>
        </div>
      </div>

      <!-- Existing turfs -->
      <div class="card">
        <h3>Turfs</h3>
        <p v-if="!turfs.length" class="muted empty-note">
          No turf cut yet. Squads without turf just pick their own streets.
        </p>
        <div v-else class="turf-list">
          <div v-for="t in turfs" :key="t.id" class="turf-row">
            <button class="turf-row-main" @click="focusTurf(t.id)">
              <span class="turf-swatch" :style="{ background: t.color }" aria-hidden="true"></span>
              <span class="turf-row-text">
                <span class="turf-name">{{ t.name }}</span>
                <span class="muted turf-assignment">{{ assignmentLabel(t) }}</span>
                <span class="muted turf-segments">
                  {{ t.turf_segments.map(segmentLabel).join(' · ') || 'No street ranges' }}
                </span>
              </span>
            </button>
            <div class="turf-row-actions">
              <button class="btn btn-ghost btn-sm" @click="editTurf(t)">Edit</button>
              <button class="btn btn-ghost btn-sm turf-delete" @click="deleteTurf(t)">Delete</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* --- Sweep bar --- */

.sweep-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--border);
  border-left: 6px solid var(--draft-color);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--draft-color) 6%, var(--surface));
}

.sweep-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--draft-color);
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.4);
}

.sweep-dot.armed {
  animation: turf-anchor-pulse 1.1s ease-in-out infinite;
}

.sweep-hint {
  margin: 0;
  flex: 1;
  font-size: 0.88rem;
}

.parity-toggle {
  display: flex;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.parity-btn {
  min-height: 36px;
  padding: 0 0.6rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.parity-btn + .parity-btn {
  border-left: 1px solid var(--border);
}

.parity-btn.active {
  background: var(--accent);
  color: #fff;
}

/* --- Map --- */

.map-wrap {
  position: relative;
}

.map {
  height: min(50svh, 480px);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
}

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

/* Segmented layers control, top-left on the map — same chrome as Hunt's
 * pin-mode toggle. */
.layer-toggle {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.layer-btn {
  min-height: 36px;
  padding: 0 0.7rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
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
  animation: turf-spin 0.7s linear infinite;
}

.map-error {
  margin: 0;
  font-size: 0.88rem;
}

/* --- Street search --- */

.street-search {
  width: 100%;
  min-height: 48px;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.street-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.search-note {
  font-size: 0.88rem;
}

.street-matches {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.street-match {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.street-match:hover {
  background: var(--surface-2);
}

.street-match-name {
  font-weight: 600;
}

/* --- Draft tray --- */

.draft-card {
  border-left: 6px solid var(--draft-color);
}

.draft-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.draft-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--draft-color);
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.35);
}

.draft-count {
  margin-left: auto;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--draft-color);
}

.seg-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.seg-chip {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-left: 4px solid var(--draft-color);
  border-radius: var(--radius);
  background: var(--surface);
}

.seg-chip-main {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}

.seg-street {
  font-weight: 700;
}

.seg-city {
  font-size: 0.82rem;
}

.seg-chip-controls {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.seg-num {
  width: 5.2rem;
  min-height: 40px;
  padding: 0.3rem 0.5rem;
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.seg-num:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.seg-parity {
  width: auto;
  min-width: 8.5rem;
}

.seg-doors {
  font-size: 0.85rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.seg-doors-empty {
  color: var(--danger);
}

.seg-remove {
  margin-left: auto;
}

.seg-taken {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
}

.draft-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.draft-name {
  width: 100%;
  min-height: 48px;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.draft-name:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.draft-actions {
  display: flex;
  gap: 0.5rem;
}

.empty-note {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
}

/* --- Turf list --- */

.turf-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.turf-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0.5rem 0.65rem;
}

.turf-row-main {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
}

.turf-swatch {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.35);
}

.turf-row-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.turf-name {
  font-weight: 700;
}

.turf-assignment,
.turf-segments {
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turf-row-actions {
  display: flex;
  flex-shrink: 0;
  gap: 0.25rem;
}

.turf-delete {
  color: var(--danger);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 0.9rem;
}

@keyframes turf-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<!-- Unscoped: marker content divs live in Google's map DOM, outside this
     component's subtree, so the anchor pulse keyframes must be global. -->
<style>
@keyframes turf-anchor-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.25);
  }
}
</style>
