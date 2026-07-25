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
//
// TurfOutlineLayer below is NOT that coming back. It is stroke-only — zero
// fill — so two turfs whose hulls overlap read as two lines crossing rather
// than as a third muddy color, which was the entire problem. It answers a
// different question too: not "which turf owns this door" (the door rings
// already say that) but "where is each turf, roughly, at a glance" — the
// 2026-07-25 ask for turf shapes "irrespective of doors".

export interface TurfOutline {
  id: string
  color: string
  points: { lat: number; lng: number }[]
}

/** Convex hull (Andrew's monotone chain). O(n log n), no dependencies. The
 * hull is deliberately coarse: a turf is a handful of streets and the point
 * is its rough footprint, not a faithful boundary. */
function convexHull(pts: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  if (pts.length < 3) return pts
  const p = [...pts].sort((a, b) => a.lng - b.lng || a.lat - b.lat)
  const cross = (
    o: { lat: number; lng: number },
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
  ) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)
  const half = (src: typeof p) => {
    const out: typeof p = []
    for (const pt of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 0) out.pop()
      out.push(pt)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

/** Rough per-turf footprints, drawn as colored outlines with no fill. */
export class TurfOutlineLayer {
  private map: google.maps.Map
  private shapes: google.maps.Polygon[] = []
  private visible = false

  constructor(map: google.maps.Map) {
    this.map = map
  }

  setVisible(v: boolean) {
    if (this.visible === v) return
    this.visible = v
    for (const s of this.shapes) s.setMap(v ? this.map : null)
  }

  /** Replaces every outline. Turfs with fewer than 3 located doors are
   * skipped — a hull needs a triangle, and one or two dots is already
   * legible as dots. */
  setTurfs(turfs: TurfOutline[]) {
    for (const s of this.shapes) s.setMap(null)
    this.shapes = []
    for (const t of turfs) {
      const hull = convexHull(t.points)
      if (hull.length < 3) continue
      this.shapes.push(
        new google.maps.Polygon({
          paths: hull,
          map: this.visible ? this.map : null,
          strokeColor: t.color,
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillOpacity: 0,
          // The outline is scenery: taps must reach the door canvas beneath.
          clickable: false,
          zIndex: 1,
        }),
      )
    }
  }

  dispose() {
    for (const s of this.shapes) s.setMap(null)
    this.shapes = []
  }
}

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
 * - 'off'   every door, plain status colors. THE DEFAULT on every map
 *           (2026-07-25, user call): nothing toggled means you see the whole
 *           county exactly as the outcome colors describe it, and a layer is
 *           something you reach for rather than something you switch off.
 * - 'mine'  filter to your crew's whole assignment — the turf your squad is
 *           out on today, sub-turfs and all (lib/myTurf.ts owns that rule).
 *           Not your personal share; that's 'doors'.
 * - 'doors' Scout only: filter to the doors assigned to YOU personally — the
 *           share you claimed (or were handed) on the squad page. The
 *           narrowest reading of the map there is: this is my list.
 * - 'all'   every turf's doors in its own color.
 *
 * Scout and the cutter share one key (`map-turf-shading`); the Squad map
 * keeps its own, since only it has to fetch the campaign-wide door set. The
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
