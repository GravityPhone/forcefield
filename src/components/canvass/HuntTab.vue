<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import { loadMaps } from '@/lib/googleMaps'
import { geocodeAndCache } from '@/lib/geocode'
import { supabase } from '@/lib/supabase'
import { useTalkStore } from '@/stores/talk'
import { OUTCOME_HEX, PIN_DEFAULT_HEX, knockButtonHex } from '@/lib/outcomes'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import OutcomeIndicatorGrid from './OutcomeIndicatorGrid.vue'
import type { Address, HouseholdKnockSummary, HouseholdLatestKnock, KnockOutcome, Person } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }
const NEARBY_CAP = 50

/** `persons(count)` is a PostgREST aggregate embed — one row per address
 * with a single { count } entry, giving household roster size in the same
 * query as the address itself (no extra round trip). */
type RosterCount = { persons: { count: number }[] }
type AddressWithRoster = Address & Partial<RosterCount>

interface PersonHit extends Person {
  addresses: (Pick<Address, 'id' | 'street' | 'unit' | 'city'> & Partial<RosterCount>) | null
}

const talk = useTalkStore()

const mapEl = ref<HTMLElement | null>(null)
const listQuery = ref('')
const searchResults = ref<{ persons: PersonHit[]; addresses: AddressWithRoster[] }>({
  persons: [],
  addresses: [],
})
const searching = ref(false)
const locating = ref(false)
const locatedAddressId = ref<string | null>(null)
const locatedAddress = ref<AddressWithRoster | null>(null)
const statusByHousehold = ref<Map<string, KnockOutcome>>(new Map())
const summaryByHousehold = ref<Map<string, HouseholdKnockSummary>>(new Map())
const loadError = ref('')

let map: google.maps.Map | null = null
let clusterer: MarkerClusterer | null = null
let markersByAddress = new Map<string, google.maps.Marker>()
let initStarted = false
let searchTimer: ReturnType<typeof setTimeout> | undefined
let currentZoom = 14

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

/** Only geocoded addresses get pins — a much smaller, growing-over-time set
 * (Talk mode, and now Hunt's "locate", both geocode on demand). */
async function fetchMapData() {
  const [addressesRes, statusRes, summaryRes] = await Promise.all([
    supabase.from('addresses').select('*, persons(count)').not('lat', 'is', null).limit(2000),
    supabase.from('household_latest_knock').select('*'),
    supabase.from('household_knock_summary').select('*'),
  ])
  if (addressesRes.error) throw addressesRes.error
  applyStatusAndSummary(statusRes.data, summaryRes.data)
  return (addressesRes.data ?? []) as AddressWithRoster[]
}

function applyStatusAndSummary(
  statusData: HouseholdLatestKnock[] | null,
  summaryData: HouseholdKnockSummary[] | null,
) {
  statusByHousehold.value = new Map((statusData ?? []).map((s) => [s.household_id, s.outcome]))
  summaryByHousehold.value = new Map((summaryData ?? []).map((s) => [s.household_id, s]))
}

/** Dynamic pin size: shrinks as you zoom out, grows as you zoom in, so the
 * map doesn't get cluttered with oversized dots when many doors are close
 * together. Located pin always stands out a bit larger than its neighbors. */
function baseScale(zoom: number): number {
  return Math.max(3, Math.min(8, zoom - 9))
}

function pinIcon(addressId: string): google.maps.Symbol {
  const outcome = statusByHousehold.value.get(addressId)
  const isLocated = addressId === locatedAddressId.value
  const scale = baseScale(currentZoom)
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: isLocated ? scale + 4 : scale,
    fillColor: outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX,
    fillOpacity: 1,
    strokeColor: isLocated ? '#111' : '#ffffff',
    strokeWeight: isLocated ? 3 : 1.5,
  }
}

function refreshAllPinScales() {
  for (const [id, marker] of markersByAddress) marker.setIcon(pinIcon(id))
}

function addOrUpdateMarker(a: AddressWithRoster) {
  if (a.lat == null || a.lng == null || !map) return
  let marker = markersByAddress.get(a.id)
  if (!marker) {
    marker = new google.maps.Marker({
      position: { lat: a.lat, lng: a.lng },
      title: `${a.street}${a.unit ? ' ' + a.unit : ''}`,
    })
    marker.addListener('click', () => void locateAddress(a))
    markersByAddress.set(a.id, marker)
    clusterer?.addMarker(marker)
  } else {
    marker.setPosition({ lat: a.lat, lng: a.lng })
  }
  marker.setIcon(pinIcon(a.id))
}

async function initialize() {
  let mapAddresses: AddressWithRoster[] = []
  try {
    ;[mapAddresses] = await Promise.all([fetchMapData(), loadMaps()])
  } catch {
    loadError.value = 'Could not load the map or address data. Check your connection.'
    initStarted = false
    return
  }
  if (!mapEl.value) return

  map = new google.maps.Map(mapEl.value, {
    center: FALLBACK_CENTER,
    zoom: currentZoom,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
  })
  map.addListener('zoom_changed', () => {
    currentZoom = map!.getZoom() ?? currentZoom
    refreshAllPinScales()
  })
  clusterer = new MarkerClusterer({ map, markers: [] })

  const bounds = new google.maps.LatLngBounds()
  for (const a of mapAddresses) {
    if (a.lat == null || a.lng == null) continue
    addOrUpdateMarker(a)
    bounds.extend({ lat: a.lat, lng: a.lng })
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
}

/** Re-pull statuses/summaries and recolor existing pins (cheap: two view
 * queries). Called whenever Hunt is revisited after logging knocks. */
async function refreshStatuses() {
  const [statusRes, summaryRes] = await Promise.all([
    supabase.from('household_latest_knock').select('*'),
    supabase.from('household_knock_summary').select('*'),
  ])
  applyStatusAndSummary(statusRes.data, summaryRes.data)
  refreshAllPinScales()
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

/** Knock button color reflects the latest outcome at that door — same data
 * already driving the map pins (household_latest_knock), just re-bucketed
 * into 4 colors instead of the pins' 6. */
function knockColorFor(addressId: string | null | undefined): string {
  if (!addressId) return knockButtonHex(null)
  return knockButtonHex(statusByHousehold.value.get(addressId))
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
    locatedAddressId.value = address.id
    locatedAddress.value = address
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

onUnmounted(() => {
  clusterer?.clearMarkers()
  markersByAddress.clear()
})
</script>

<template>
  <div class="hunt">
    <!-- Whatever was last clicked — a pin on the map or a result below —
         always surfaces here, whether or not it matches the current search. -->
    <div v-if="locatedAddress" class="card located-card" :class="locatedStatusClass">
      <span class="result-left">
        <span class="result-name">
          {{ locatedAddress.street }}{{ locatedAddress.unit ? ' ' + locatedAddress.unit : '' }}
        </span>
      </span>
      <OutcomeIndicatorGrid
        :summary="summaryFor(locatedAddress.id)"
        :household-size="householdSize(locatedAddress)"
      />
      <button
        class="btn btn-sm knock-btn"
        :style="{ background: knockColorFor(locatedAddress.id), color: 'var(--accent-contrast)' }"
        @click="knock(locatedAddress.id)"
      >
        Knock
      </button>
    </div>

    <div ref="mapEl" class="map"></div>
    <p v-if="loadError" class="muted map-error">{{ loadError }}</p>
    <p v-if="locating" class="muted map-error">Locating nearby doors…</p>

    <input
      :value="listQuery"
      class="street-search"
      type="search"
      placeholder="Search a name or street…"
      aria-label="Search people or addresses"
      @input="onListInput(($event.target as HTMLInputElement).value)"
    />

    <!-- Governs Talk mode's "Next" auto-advance — which way to walk a
         street once you start logging outcomes. -->
    <div class="walk-order">
      <span class="muted walk-label">Next house:</span>
      <select
        class="walk-select"
        :value="talk.walkDirection"
        aria-label="Walk direction"
        @change="talk.setWalkDirection(($event.target as HTMLSelectElement).value as 'ascending' | 'descending')"
      >
        <option value="ascending">Ascending</option>
        <option value="descending">Descending</option>
      </select>
      <select
        class="walk-select"
        :value="talk.walkParity"
        aria-label="Walk side of street"
        @change="talk.setWalkParity(($event.target as HTMLSelectElement).value as 'both' | 'even' | 'odd')"
      >
        <option value="both">Both sides</option>
        <option value="even">Evens only</option>
        <option value="odd">Odds only</option>
      </select>
    </div>

    <div class="results-list">
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
          </span>
          <OutcomeIndicatorGrid
            :summary="summaryFor(p.household_id)"
            :household-size="householdSize(p.addresses)"
          />
          <button
            v-if="p.household_id"
            class="btn btn-sm knock-btn"
            :style="{ background: knockColorFor(p.household_id), color: 'var(--accent-contrast)' }"
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
          </span>
          <OutcomeIndicatorGrid :summary="summaryFor(a.id)" :household-size="householdSize(a)" />
          <button
            class="btn btn-sm knock-btn"
            :style="{ background: knockColorFor(a.id), color: 'var(--accent-contrast)' }"
            @click.stop="knock(a.id)"
          >
            Knock
          </button>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.hunt {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.map {
  height: min(45dvh, 420px);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
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
}

.street-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.walk-order {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.walk-label {
  font-size: 0.85rem;
  flex-shrink: 0;
}

.walk-select {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  padding: 0.4rem 0.5rem;
  font-size: 0.88rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
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

.results-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 40dvh;
  overflow-y: auto;
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

.empty {
  font-size: 0.9rem;
  padding: 0.4rem 0.1rem;
}
</style>
