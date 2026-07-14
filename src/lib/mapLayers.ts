// Shared map overlay layers for Hunt mode and the turf cutter:
//
// - TurfAreasLayer — shades each turf as a translucent colored area. The
//   shape is a "highlighter swath": member doors are grouped into per-street
//   runs, each run becomes a line buffered ~45m (turf.js), and the buffers
//   union into one polygon per turf. Reads as "this block of streets is
//   ours" at any zoom, unlike pixel-width strokes.
// - CityLimitsLayer — incorporated-place boundaries (city/village limits)
//   from Census TIGERweb, bundled at public/boundaries/ by
//   scripts/fetch-city-limits.mjs. The borders around here are heavily
//   gerrymandered — city, then township, then city again along one road —
//   and petition rules care about the difference.
//
// turf.js is dynamically imported so neither map pays its weight until an
// area actually needs drawing.
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson'
import { houseNumber, streetNameOf } from './streetWalk'

export interface DoorPoint {
  lat: number
  lng: number
  street: string
}

const CORRIDOR_METERS = 45

async function turfLibs() {
  const [{ buffer }, { union }, { featureCollection, lineString, point }] = await Promise.all([
    import('@turf/buffer'),
    import('@turf/union'),
    import('@turf/helpers'),
  ])
  return { buffer, union, featureCollection, lineString, point }
}

/** One merged polygon shading the streets these doors sit on, or null when
 * nothing is geocoded. */
export async function corridorFor(doors: DoorPoint[]): Promise<Feature<Polygon | MultiPolygon> | null> {
  if (!doors.length) return null
  const { buffer, union, featureCollection, lineString, point } = await turfLibs()

  // Group into per-street runs sorted by house number so lines follow the
  // street instead of zig-zagging between streets.
  const byStreet = new Map<string, DoorPoint[]>()
  for (const d of doors) {
    const key = streetNameOf(d.street)
    const list = byStreet.get(key)
    if (list) list.push(d)
    else byStreet.set(key, [d])
  }

  const shapes: Feature<LineString | Point>[] = []
  for (const run of byStreet.values()) {
    run.sort((a, b) => houseNumber(a.street) - houseNumber(b.street))
    const coords = run.map((d) => [d.lng, d.lat])
    shapes.push(coords.length >= 2 ? lineString(coords) : point(coords[0]))
  }

  const buffered = buffer(featureCollection(shapes), CORRIDOR_METERS, { units: 'meters' })
  const polys = (buffered?.features ?? []).filter(
    (f): f is Feature<Polygon | MultiPolygon> => f?.geometry != null,
  )
  if (!polys.length) return null
  if (polys.length === 1) return polys[0]
  return union(featureCollection(polys))
}

export interface TurfAreaSource {
  id: string
  color: string
  doors: DoorPoint[]
  /** Stronger fill — "this one is yours" on the Hunt map. */
  emphasis?: boolean
}

/** Google Data layer holding one shaded polygon per turf. */
export class TurfAreasLayer {
  private data: google.maps.Data
  private map: google.maps.Map
  private visible = true
  /** Guards against an older async rebuild landing after a newer one. */
  private buildSeq = 0

  constructor(map: google.maps.Map) {
    this.map = map
    this.data = new google.maps.Data({ map })
    this.data.setStyle((f) => ({
      fillColor: (f.getGeometry() && (f.getProperty('color') as string)) || '#7c3aed',
      fillOpacity: f.getProperty('emphasis') ? 0.28 : 0.14,
      strokeColor: (f.getProperty('color') as string) || '#7c3aed',
      strokeOpacity: 0.55,
      strokeWeight: 1.5,
      // Never eat taps meant for the pins under the shading.
      clickable: false,
      zIndex: 0,
    }))
  }

  async setTurfs(turfs: TurfAreaSource[]) {
    const seq = ++this.buildSeq
    const features: { turf: TurfAreaSource; shape: Feature<Polygon | MultiPolygon> }[] = []
    for (const turf of turfs) {
      const shape = await corridorFor(turf.doors)
      if (shape) features.push({ turf, shape })
    }
    if (seq !== this.buildSeq) return
    this.data.forEach((f) => this.data.remove(f))
    for (const { turf, shape } of features) {
      this.data.addGeoJson({
        type: 'Feature',
        geometry: shape.geometry,
        properties: { color: turf.color, emphasis: !!turf.emphasis },
      })
    }
  }

  setVisible(visible: boolean) {
    this.visible = visible
    this.data.setMap(visible ? this.map : null)
  }

  isVisible() {
    return this.visible
  }

  dispose() {
    this.data.setMap(null)
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

/** The density dot itself — a circle that grows with how many pins it stands
 * for, no count text (the default clusterer numbers read like house numbers
 * next to number-mode pins, which was confusing). The translucent halo is
 * the "this stands for an area" cue. Shared by the clusterer renderer below
 * (Squad, Turf) and Hunt's zoomed-out density layer. */
export function densityDotElement(count: number, color = '#2f6fed'): HTMLElement {
  const el = document.createElement('div')
  const size = Math.round(Math.min(44, 16 + Math.sqrt(count) * 2.8))
  const s = el.style
  s.boxSizing = 'border-box'
  s.width = `${size}px`
  s.height = `${size}px`
  s.borderRadius = '50%'
  s.background = color
  s.border = '2px solid #fff'
  s.boxShadow = `0 0 0 ${Math.max(4, Math.round(size / 5))}px ${color}40, 0 0 4px rgba(0, 0, 0, 0.4)`
  s.cursor = 'pointer'
  return el
}

/** Cluster bubbles as plain density dots. */
export function dotClusterRenderer(color = '#2f6fed') {
  return {
    render({ count, position }: { count: number; position: google.maps.LatLng }) {
      return new google.maps.marker.AdvancedMarkerElement({
        position,
        content: densityDotElement(count, color),
        // Above single pins, below anything intentionally raised (anchors,
        // member avatars).
        zIndex: 300,
      })
    },
  }
}

// --- Per-device layer preferences (same pattern as Hunt's pin mode). ---

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
