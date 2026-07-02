<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import { loadMaps } from '@/lib/googleMaps'
import { supabase } from '@/lib/supabase'
import { useTalkStore } from '@/stores/talk'
import { OUTCOME_HEX, PIN_DEFAULT_HEX } from '@/lib/outcomes'
import type { Address, HouseholdLatestKnock, KnockOutcome } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }

const talk = useTalkStore()

const mapEl = ref<HTMLElement | null>(null)
const listQuery = ref('')
const addresses = ref<Address[]>([])
const statusByHousehold = ref<Map<string, KnockOutcome>>(new Map())
const loadError = ref('')
const expandedStreet = ref<string | null>(null)

let map: google.maps.Map | null = null
let clusterer: MarkerClusterer | null = null
let markersByAddress = new Map<string, google.maps.Marker>()
let initStarted = false

// Hunt is the door-knocking helper: find an address here, log it on Talk.
// Lazy-init on first activation so the Maps script never loads for
// canvassers who stay on the Talk tab.
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

async function fetchData() {
  const [addressesRes, statusRes] = await Promise.all([
    supabase.from('addresses').select('*').order('street').limit(2000),
    supabase.from('household_latest_knock').select('*'),
  ])
  if (addressesRes.error) throw addressesRes.error
  addresses.value = (addressesRes.data ?? []) as Address[]
  statusByHousehold.value = new Map(
    ((statusRes.data ?? []) as HouseholdLatestKnock[]).map((s) => [s.household_id, s.outcome]),
  )
}

function pinIcon(addressId: string): google.maps.Symbol {
  const outcome = statusByHousehold.value.get(addressId)
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 9,
    fillColor: outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 1.5,
  }
}

async function initialize() {
  try {
    await Promise.all([fetchData(), loadMaps()])
  } catch {
    loadError.value = 'Could not load the map or address data. Check your connection.'
    initStarted = false
    return
  }
  if (!mapEl.value) return

  map = new google.maps.Map(mapEl.value, {
    center: FALLBACK_CENTER,
    zoom: 14,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
  })

  const bounds = new google.maps.LatLngBounds()
  const markers: google.maps.Marker[] = []
  for (const a of addresses.value) {
    if (a.lat == null || a.lng == null) continue // not geocoded → no pin
    const marker = new google.maps.Marker({
      position: { lat: a.lat, lng: a.lng },
      title: `${a.street}${a.unit ? ' ' + a.unit : ''}`,
      icon: pinIcon(a.id),
    })
    marker.addListener('click', () => void talk.loadAddress(a.id))
    markersByAddress.set(a.id, marker)
    markers.push(marker)
    bounds.extend({ lat: a.lat, lng: a.lng })
  }
  clusterer = new MarkerClusterer({ map, markers })
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
}

/** Re-color pins from the latest knock statuses (cheap: one view query). */
async function refreshStatuses() {
  const { data, error } = await supabase.from('household_latest_knock').select('*')
  if (error || !data) return
  statusByHousehold.value = new Map(
    (data as HouseholdLatestKnock[]).map((s) => [s.household_id, s.outcome]),
  )
  for (const [id, marker] of markersByAddress) marker.setIcon(pinIcon(id))
}

// Context-dependent list: street query → houses grouped by street; a street
// group with several units expands to its unit rows. Ungeocoded addresses
// still appear here even though they have no pin.
const streetGroups = computed(() => {
  const q = listQuery.value.trim().toLowerCase()
  const matches = q
    ? addresses.value.filter((a) => a.street.toLowerCase().includes(q))
    : addresses.value
  const groups = new Map<string, Address[]>()
  for (const a of matches) {
    const list = groups.get(a.street)
    if (list) list.push(a)
    else groups.set(a.street, [a])
  }
  return [...groups.entries()].slice(0, 50)
})

function pickGroup(street: string, rows: Address[]) {
  if (rows.length === 1) {
    void talk.loadAddress(rows[0].id) // flips to Talk with roster loaded
  } else {
    expandedStreet.value = expandedStreet.value === street ? null : street
  }
}

onUnmounted(() => {
  clusterer?.clearMarkers()
  markersByAddress.clear()
})
</script>

<template>
  <div class="hunt">
    <div ref="mapEl" class="map"></div>
    <p v-if="loadError" class="muted map-error">{{ loadError }}</p>

    <input
      v-model="listQuery"
      class="street-search"
      type="search"
      placeholder="Filter by street…"
      aria-label="Filter addresses by street"
    />

    <div class="street-list">
      <div v-for="[street, rows] in streetGroups" :key="street" class="street-group">
        <button class="street-row" @click="pickGroup(street, rows)">
          <span class="street-name">{{ street }}</span>
          <span class="muted unit-count">
            {{ rows.length === 1 ? rows[0].city : rows.length + ' units' }}
          </span>
        </button>
        <div v-if="expandedStreet === street && rows.length > 1" class="units">
          <button
            v-for="a in rows"
            :key="a.id"
            class="unit-row"
            @click="talk.loadAddress(a.id)"
          >
            {{ a.unit || '(main)' }} <span class="muted">{{ a.city }}</span>
          </button>
        </div>
      </div>
      <p v-if="!streetGroups.length" class="muted empty">No addresses match.</p>
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

.street-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 40dvh;
  overflow-y: auto;
}

.street-row,
.unit-row {
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

.street-name {
  font-weight: 600;
}

.unit-count {
  font-size: 0.85rem;
  white-space: nowrap;
}

.units {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0.25rem 0 0.25rem 1rem;
}

.unit-row {
  min-height: 44px;
}

.empty {
  font-size: 0.9rem;
}
</style>
