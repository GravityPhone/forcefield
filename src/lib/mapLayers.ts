// Shared map overlay layers for Hunt mode, the Squad map, and the turf cutter:
//
// - TurfAreasLayer — shades each turf as a translucent colored area. The
//   shape is ANGULAR on purpose (2026-07-23, user call): member doors mark
//   cells of a fixed ~44m grid (plus connecting cells along each street run),
//   and the region's cell-boundary outline becomes the polygon — sharp
//   rectangular edges hugging exactly the doors that are in the turf, instead
//   of the old turf.js 45m round-capped buffers whose blobs overlapped
//   neighboring turfs and read as "this door is in two turfs". The grid is
//   absolute (anchored to lat/lng 0), so adjacent turfs' shapes tile against
//   each other without overlapping. Zero dependencies — turf.js is gone.
// - CityLimitsLayer — incorporated-place boundaries (city/village limits)
//   from Census TIGERweb, bundled at public/boundaries/ by
//   scripts/fetch-city-limits.mjs. The borders around here are heavily
//   gerrymandered — city, then township, then city again along one road —
//   and petition rules care about the difference.
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson'
import { houseNumber, streetNameOf } from './streetWalk'

export interface DoorPoint {
  lat: number
  lng: number
  street: string
}

/** Grid cell edge, meters. Small enough to hug single streets tightly,
 * big enough that neighboring houses land in the same or adjacent cells. */
const CELL_METERS = 44
/** Doors within this distance of a cell edge also claim the neighbor cell,
 * so no door ever sits exactly on the shading boundary. */
const DOOR_PAD_METERS = 14
/** Consecutive doors (by house number) farther apart than this don't get a
 * connecting corridor — a numbering gap that jumps blocks shouldn't shade
 * the empty land between. */
const MAX_LINK_METERS = 150

const M_PER_DEG_LAT = 111_320

type GridRing = { ring: [number, number][]; area: number }

/** Trace the boundary of a set of occupied grid cells into closed rings.
 * Directed edges (interior on the left) from each cell cancel where two
 * cells touch; what remains chains into rings — outer boundaries come out
 * counter-clockwise (positive area), holes clockwise (negative). At pinch
 * vertices (two cells touching only at a corner) the sharpest-left-turn rule
 * keeps each ring on its own region. */
function traceCellBoundaries(cells: Set<string>): GridRing[] {
  const directed = new Set<string>()
  const toggle = (x1: number, y1: number, x2: number, y2: number) => {
    const rev = `${x2},${y2}>${x1},${y1}`
    if (directed.has(rev)) directed.delete(rev)
    else directed.add(`${x1},${y1}>${x2},${y2}`)
  }
  for (const key of cells) {
    const sep = key.indexOf(':')
    const x = Number(key.slice(0, sep))
    const y = Number(key.slice(sep + 1))
    toggle(x, y, x + 1, y)
    toggle(x + 1, y, x + 1, y + 1)
    toggle(x + 1, y + 1, x, y + 1)
    toggle(x, y + 1, x, y)
  }

  // start vertex -> list of end vertices, for the ring walk.
  const out = new Map<string, [number, number][]>()
  for (const key of directed) {
    const gt = key.indexOf('>')
    const start = key.slice(0, gt)
    const [ex, ey] = key.slice(gt + 1).split(',').map(Number)
    const list = out.get(start)
    if (list) list.push([ex, ey])
    else out.set(start, [[ex, ey]])
  }

  const rings: GridRing[] = []
  while (out.size) {
    const first = out.entries().next().value as [string, [number, number][]]
    const [sx, sy] = first[0].split(',').map(Number)
    const ring: [number, number][] = [[sx, sy]]
    let cx = sx
    let cy = sy
    let dx = 0
    let dy = 0
    for (;;) {
      const key = `${cx},${cy}`
      const cands = out.get(key)
      if (!cands || !cands.length) break // degenerate — shouldn't happen
      let pick = 0
      if (cands.length > 1 && (dx !== 0 || dy !== 0)) {
        // Prefer left turn, then straight, then right — hugs this region.
        const prefs = [
          [-dy, dx],
          [dx, dy],
          [dy, -dx],
        ]
        outer: for (const [px, py] of prefs) {
          for (let i = 0; i < cands.length; i++) {
            if (cands[i][0] - cx === px && cands[i][1] - cy === py) {
              pick = i
              break outer
            }
          }
        }
      }
      const [nx, ny] = cands[pick]
      cands.splice(pick, 1)
      if (!cands.length) out.delete(key)
      dx = nx - cx
      dy = ny - cy
      cx = nx
      cy = ny
      if (cx === sx && cy === sy) break
      ring.push([cx, cy])
    }
    if (ring.length < 4) continue
    // Merge collinear runs — long straight edges become single segments.
    const slim: [number, number][] = []
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i + ring.length - 1) % ring.length]
      const next = ring[(i + 1) % ring.length]
      const v = ring[i]
      const straight =
        (v[0] - prev[0] === next[0] - v[0] && v[1] - prev[1] === next[1] - v[1])
      if (!straight) slim.push(v)
    }
    if (slim.length < 4) continue
    let area = 0
    for (let i = 0; i < slim.length; i++) {
      const [x1, y1] = slim[i]
      const [x2, y2] = slim[(i + 1) % slim.length]
      area += x1 * y2 - x2 * y1
    }
    rings.push({ ring: slim, area: area / 2 })
  }
  return rings
}

/** Ray-cast point-in-ring test, grid coordinates. */
function ringContains(ring: [number, number][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** One angular polygon (with holes) covering the grid cells these doors
 * occupy, or null when nothing is geocoded. Synchronous and cheap — safe to
 * call on every draft change. */
export function turfAreaFor(doors: DoorPoint[]): Feature<MultiPolygon> | null {
  if (!doors.length) return null
  const lat0 = doors[0].lat
  const mPerDegLng = Math.max(1, M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180))
  const dLat = CELL_METERS / M_PER_DEG_LAT
  const dLng = CELL_METERS / mPerDegLng
  const padLat = DOOR_PAD_METERS / M_PER_DEG_LAT
  const padLng = DOOR_PAD_METERS / mPerDegLng

  const cells = new Set<string>()
  const mark = (ix: number, iy: number) => cells.add(`${ix}:${iy}`)

  for (const d of doors) {
    const x0 = Math.floor((d.lng - padLng) / dLng)
    const x1 = Math.floor((d.lng + padLng) / dLng)
    const y0 = Math.floor((d.lat - padLat) / dLat)
    const y1 = Math.floor((d.lat + padLat) / dLat)
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) mark(ix, iy)
  }

  // Bridge consecutive doors along each street run so sparse streets still
  // shade as one continuous strip.
  const byStreet = new Map<string, DoorPoint[]>()
  for (const d of doors) {
    const key = streetNameOf(d.street)
    const list = byStreet.get(key)
    if (list) list.push(d)
    else byStreet.set(key, [d])
  }
  for (const run of byStreet.values()) {
    run.sort((a, b) => houseNumber(a.street) - houseNumber(b.street))
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1]
      const b = run[i]
      const stepM = Math.hypot((b.lat - a.lat) * M_PER_DEG_LAT, (b.lng - a.lng) * mPerDegLng)
      if (stepM > MAX_LINK_METERS) continue
      const steps = Math.ceil(stepM / (CELL_METERS / 2))
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        mark(
          Math.floor((a.lng + (b.lng - a.lng) * t) / dLng),
          Math.floor((a.lat + (b.lat - a.lat) * t) / dLat),
        )
      }
    }
  }

  const rings = traceCellBoundaries(cells)
  if (!rings.length) return null
  const outers = rings.filter((r) => r.area > 0)
  const holes = rings.filter((r) => r.area < 0)

  const polys = outers.map((o) => ({ o, holes: [] as GridRing[] }))
  for (const h of holes) {
    // Sample a point just inside the cavity: midpoint of the first edge,
    // shifted half a cell to the RIGHT of travel (region interior is on the
    // left of every traced edge, so right = inside the hole).
    const [x1, y1] = h.ring[0]
    const [x2, y2] = h.ring[1]
    const px = (x1 + x2) / 2 + (y2 - y1) / 2
    const py = (y1 + y2) / 2 - (x2 - x1) / 2
    let best: { o: GridRing; holes: GridRing[] } | null = null
    for (const p of polys) {
      if (ringContains(p.o.ring, px, py) && (!best || p.o.area < best.o.area)) best = p
    }
    best?.holes.push(h)
  }

  const toCoords = (r: GridRing) => {
    const coords = r.ring.map(([ix, iy]) => [ix * dLng, iy * dLat])
    coords.push(coords[0])
    return coords
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: polys.map((p) => [toCoords(p.o), ...p.holes.map(toCoords)]),
    },
  }
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

  setTurfs(turfs: TurfAreaSource[]) {
    this.data.forEach((f) => this.data.remove(f))
    for (const turf of turfs) {
      const shape = turfAreaFor(turf.doors)
      if (!shape) continue
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
 * (Squad) and Hunt's zoomed-out density layer. */
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

/** Turf shading is a tri-state on the Scout, Squad, and Turf maps: shade
 * only YOUR turf, shade ALL turf (yours emphasized), or none. Scout and the
 * cutter share one key (`map-turf-shading`); the Squad map keeps its own —
 * its default is the crew's turf, so a plain squad-page load never pays for
 * the org-wide door download that "All turf" needs there. */
export type TurfShadeMode = 'off' | 'mine' | 'all'

export function readTurfShadeMode(key: string, fallback: TurfShadeMode): TurfShadeMode {
  try {
    const v = localStorage.getItem(key)
    if (v === 'off' || v === 'mine' || v === 'all') return v
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
