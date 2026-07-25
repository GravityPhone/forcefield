// Shared map chrome for Scout, the Squad map, and the turf cutter. Doors
// themselves are NOT here — all three paint them on one canvas, see
// src/lib/doorCanvas.ts.
//
// - CityLimitsLayer — incorporated-place boundaries (city/village limits)
//   from Census TIGERweb, bundled at public/boundaries/ by
//   scripts/fetch-city-limits.mjs. The borders around here are heavily
//   gerrymandered — city, then township, then city again along one road —
//   and petition rules care about the difference.
// - Per-device layer/pin preferences, at the bottom.
import type { FeatureCollection } from 'geojson'

export interface DoorPoint {
  lat: number
  lng: number
  street: string
}

// Turf AREA shading is gone (2026-07-24, user call). Both maps that had it
// — Scout and Squad — now ring the DOORS in their turf's color instead, and
// the cutter never had it. Why it went: the polygons could visibly overlap
// wherever two turfs met, because each door padded 14m into a ~44m grid and
// street runs bridged the cells between consecutive doors, so turfs facing
// each other across a street both claimed the ground in between and their
// translucent fills stacked. A door belongs to exactly one turf
// (addresses.turf_id is a single column), so painting membership on the
// doors makes overlap impossible to draw. TurfAreasLayer / turfAreaFor /
// the grid-boundary tracer went with it — see git history if area shading
// is ever wanted back.

/** City/village boundary overlay. GeoJSON is fetched lazily the first time
 * the layer turns on and kept for the map's lifetime. */
export class CityLimitsLayer {
  private data: google.maps.Data
  private map: google.maps.Map
  private loaded = false
  private loading: Promise<void> | null = null

  constructor(map: google.maps.Map) {
    this.map = map
    this.data = new google.maps.Data()
    this.data.setStyle({
      fillColor: '#0ea5e9',
      fillOpacity: 0.07,
      strokeColor: '#0369a1',
      strokeOpacity: 0.85,
      strokeWeight: 2,
      clickable: false,
      zIndex: 0,
    })
  }

  private async load() {
    if (this.loaded) return
    if (!this.loading) {
      this.loading = fetch('/boundaries/union-city-limits.geojson')
        .then((res) => {
          if (!res.ok) throw new Error(`boundaries HTTP ${res.status}`)
          return res.json()
        })
        .then((geojson: FeatureCollection) => {
          this.data.addGeoJson(geojson)
          this.loaded = true
        })
        .finally(() => {
          this.loading = null
        })
    }
    await this.loading
  }

  async setVisible(visible: boolean) {
    if (visible) {
      await this.load()
      this.data.setMap(this.map)
    } else {
      this.data.setMap(null)
    }
  }

  dispose() {
    this.data.setMap(null)
  }
}

// Density dots and the cluster renderer that used them are GONE (2026-07-24,
// the three-map unification): both existed to keep the DOM-marker count down,
// and the canvas renderer (src/lib/doorCanvas.ts) has no marker count to keep
// down. Below PINS_MIN_ZOOM every door simply paints as a tiny dot, which is
// a truer density picture than a bubble and costs less. Don't reintroduce
// clustering without a reason that isn't marker cost.

// --- Per-device layer preferences. ---

/** The turf layer on the Scout and Squad maps. Despite the historical name
 * nothing is SHADED any more — these pick which doors are painted and what
 * colors they wear:
 *
 * - 'off'   every door, plain status colors.
 * - 'mine'  filter to your crew's turf (Squad rings it in turf colors).
 * - 'doors' Scout only: filter to the doors assigned to YOU personally — the
 *           share you claimed (or were handed) on the squad page. The
 *           narrowest reading of the map there is: this is my list.
 * - 'all'   every turf's doors in its own color.
 *
 * Scout and the cutter share one key (`map-turf-shading`); the Squad map
 * keeps its own — its default is the crew's turf, so a plain squad-page load
 * never pays for the org-wide door download that "All turf" needs there. The
 * Squad map never writes 'doors', but reads tolerate it (a stored value from
 * one map must never wedge another). */
export type TurfShadeMode = 'off' | 'mine' | 'doors' | 'all'

export function readTurfShadeMode(key: string, fallback: TurfShadeMode): TurfShadeMode {
  try {
    const v = localStorage.getItem(key)
    if (v === 'off' || v === 'mine' || v === 'doors' || v === 'all') return v
  } catch {
    /* private mode — fall through */
  }
  return fallback
}

export function writeTurfShadeMode(key: string, mode: TurfShadeMode) {
  try {
    localStorage.setItem(key, mode)
  } catch {
    /* private mode — the toggle still works this session */
  }
}

export function readMapPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === 'true'
  } catch {
    return fallback
  }
}

export function writeMapPref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* private mode — the toggle still works this session */
  }
}

/** Every map flips its pins between colored dots and house-number chips
 * under its own key (Scout `hunt-pin-mode`, Squad `squad-pin-mode`, cutter
 * `turf-pin-mode`) — the control is identical, the DEFAULT is per-map
 * (Scout opens on dots, the other two on numbers, matching what each map
 * did before the toggles existed). */
export type PinMode = 'dots' | 'numbers'

export function readPinMode(key: string, fallback: PinMode): PinMode {
  try {
    const v = localStorage.getItem(key)
    if (v === 'dots' || v === 'numbers') return v
  } catch {
    /* private mode — fall through */
  }
  return fallback
}

export function writePinMode(key: string, mode: PinMode) {
  try {
    localStorage.setItem(key, mode)
  } catch {
    /* private mode — the toggle still works this session */
  }
}
