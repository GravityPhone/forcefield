// One-canvas door renderer for the turf cutter (2026-07-23).
//
// The cutter used to build a DOM AdvancedMarker per visible door (Scout-style
// viewport virtualization, capped at 2000) and restyle them all on every
// gesture — panning into a dense town meant thousands of DOM node creations,
// and every tap meant tens of thousands of style writes. That is exactly the
// architecture the mapping industry avoids: VAN/Felt/Mapbox-class tools draw
// point sets on ONE canvas and repaint, keeping DOM elements only for
// singleton widgets. This layer does that for Google Maps:
//
// - Every door paints as a dot (or house-number pill) on a single canvas
//   sized ~2× the viewport, positioned in an OverlayView pane so it rides
//   map pans for free. A full repaint of 20k doors is a few milliseconds —
//   so selection state changes just repaint (rAF-coalesced), and there is no
//   pin cap and no marker churn at all.
// - Hit testing is done in Web-Mercator "world" coordinates (precomputed per
//   door), not via per-door event listeners. The map's own click/dblclick
//   events plus pointer events on the container drive all gestures.
//
// The canvas never intercepts pointer events; callers translate container
// pixels to LatLng through containerToLatLng() when they need geometry.

export interface CanvasDoor {
  id: string
  lat: number
  lng: number
  /** Leading house number as text, '' when none. */
  house: string
}

export interface DoorPaintState {
  /** Dot fill — knock status color. */
  fill: string
  /** Turf-membership ring color (draft or saved turf), null for none. */
  ring: string | null
  /** Door is in the current draft — drawn bigger, above plain doors. */
  inDraft: boolean
  /** The armed sweep anchor — biggest, dark-ringed, drawn last. */
  anchor: boolean
}

export interface DoorCanvasOptions {
  /** Below this zoom doors draw as tiny density dots (no numbers). */
  minPinZoom: number
  /** Numbers mode needs at least this zoom to draw pills. */
  numbersMinZoom: number
  paintFor(id: string): DoorPaintState
  /** House-number pills instead of dots (when zoomed in enough)? */
  showNumbers(): boolean
}

interface InternalDoor extends CanvasDoor {
  wx: number
  wy: number
}

/** Web-Mercator world coords, 256-unit world (Google's tile space, zoom 0). */
function worldX(lng: number): number {
  return ((lng + 180) / 360) * 256
}
function worldY(lat: number): number {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256
}

/** How far past the viewport the canvas paints, as a fraction of the view
 * span per side. Pans within the margin cost nothing. */
const PAD = 0.5

export class DoorCanvasLayer {
  private overlay: google.maps.OverlayView
  private map: google.maps.Map
  private opts: DoorCanvasOptions
  private canvas: HTMLCanvasElement | null = null
  private doors = new Map<string, InternalDoor>()
  private raf = 0
  private disposed = false
  // Painted-region state: reposition is valid while zoom matches and the
  // view stays inside the painted world-coordinate box.
  private paintedZoom = -1
  private paintedNW: google.maps.LatLng | null = null
  private painted = { wxMin: 0, wxMax: 0, wyMin: 0, wyMax: 0 }

  constructor(map: google.maps.Map, opts: DoorCanvasOptions) {
    this.map = map
    this.opts = opts
    this.overlay = new google.maps.OverlayView()
    this.overlay.onAdd = () => {
      const c = document.createElement('canvas')
      c.style.position = 'absolute'
      c.style.pointerEvents = 'none'
      this.overlay.getPanes()?.overlayLayer.appendChild(c)
      this.canvas = c
    }
    this.overlay.onRemove = () => {
      this.canvas?.remove()
      this.canvas = null
    }
    this.overlay.draw = () => {
      // Called by the API on zoom changes and coordinate re-bases. Reposition
      // is always cheap; repaint only when the painted region no longer fits.
      if (this.reposition()) this.requestRepaint()
    }
    this.overlay.setMap(map)
  }

  setDoors(list: Iterable<CanvasDoor>) {
    this.doors.clear()
    for (const d of list) this.upsertDoor(d)
    this.requestRepaint()
  }

  upsertDoor(d: CanvasDoor) {
    this.doors.set(d.id, { ...d, wx: worldX(d.lng), wy: worldY(d.lat) })
  }

  /** True when the current view escaped the painted region (or zoom moved)
   * and a repaint is due. Also re-anchors the canvas to the pane transform. */
  private reposition(): boolean {
    if (!this.canvas || !this.paintedNW) return true
    const proj = this.overlay.getProjection()
    if (!proj) return false
    const p = proj.fromLatLngToDivPixel(this.paintedNW)
    if (p) {
      this.canvas.style.left = `${p.x}px`
      this.canvas.style.top = `${p.y}px`
    }
    const zoom = this.map.getZoom() ?? -1
    if (zoom !== this.paintedZoom) return true
    const b = this.map.getBounds()
    if (!b) return false
    const ne = b.getNorthEast()
    const sw = b.getSouthWest()
    return (
      worldX(sw.lng()) < this.painted.wxMin ||
      worldX(ne.lng()) > this.painted.wxMax ||
      worldY(ne.lat()) < this.painted.wyMin ||
      worldY(sw.lat()) > this.painted.wyMax
    )
  }

  /** Coalesced repaint — call whenever door paint state changed. */
  requestRepaint() {
    if (this.raf || this.disposed) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.repaint()
    })
  }

  /** For map 'idle': repaint if the settled view outgrew the painted box. */
  checkView() {
    if (this.reposition()) this.requestRepaint()
  }

  containerToLatLng(x: number, y: number): google.maps.LatLng | null {
    const proj = this.overlay.getProjection()
    return proj?.fromContainerPixelToLatLng(new google.maps.Point(x, y)) ?? null
  }

  /** Nearest door within `pxRadius` screen pixels of the point, or null. */
  doorAt(latLng: google.maps.LatLng, pxRadius: number): string | null {
    const zoom = this.map.getZoom()
    if (zoom == null) return null
    const scale = 2 ** zoom
    const rw = pxRadius / scale
    const tx = worldX(latLng.lng())
    const ty = worldY(latLng.lat())
    let best: string | null = null
    let bestD = rw * rw
    for (const d of this.doors.values()) {
      const dx = d.wx - tx
      if (dx > rw || dx < -rw) continue
      const dy = d.wy - ty
      if (dy > rw || dy < -rw) continue
      const dist = dx * dx + dy * dy
      if (dist <= bestD) {
        bestD = dist
        best = d.id
      }
    }
    return best
  }

  /** Ids of doors inside a closed container-pixel polygon (the lasso). */
  doorsInPolygon(path: { x: number; y: number }[]): string[] {
    if (path.length < 3) return []
    const world: [number, number][] = []
    for (const p of path) {
      const ll = this.containerToLatLng(p.x, p.y)
      if (!ll) return []
      world.push([worldX(ll.lng()), worldY(ll.lat())])
    }
    let wxMin = Infinity
    let wxMax = -Infinity
    let wyMin = Infinity
    let wyMax = -Infinity
    for (const [x, y] of world) {
      if (x < wxMin) wxMin = x
      if (x > wxMax) wxMax = x
      if (y < wyMin) wyMin = y
      if (y > wyMax) wyMax = y
    }
    const inside = (x: number, y: number) => {
      let ins = false
      for (let i = 0, j = world.length - 1; i < world.length; j = i++) {
        const [xi, yi] = world[i]
        const [xj, yj] = world[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins
      }
      return ins
    }
    const out: string[] = []
    for (const d of this.doors.values()) {
      if (d.wx < wxMin || d.wx > wxMax || d.wy < wyMin || d.wy > wyMax) continue
      if (inside(d.wx, d.wy)) out.push(d.id)
    }
    return out
  }

  private repaint() {
    const canvas = this.canvas
    const proj = this.overlay.getProjection()
    if (!canvas || !proj || this.disposed) return
    const bounds = this.map.getBounds()
    const zoom = this.map.getZoom()
    const mapDiv = this.map.getDiv() as HTMLElement
    if (!bounds || zoom == null) return

    const viewW = mapDiv.clientWidth
    const viewH = mapDiv.clientHeight
    const cssW = Math.ceil(viewW * (1 + 2 * PAD))
    const cssH = Math.ceil(viewH * (1 + 2 * PAD))
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const scale = 2 ** zoom
    const ne = bounds.getNorthEast()
    const sw = bounds.getSouthWest()
    const wxView = worldX(sw.lng())
    const wyView = worldY(ne.lat())
    // Painted box: the viewport expanded by PAD on each side, in world units.
    const wxMin = wxView - (viewW * PAD) / scale
    const wyMin = wyView - (viewH * PAD) / scale
    this.painted = {
      wxMin,
      wxMax: wxMin + cssW / scale,
      wyMin,
      wyMax: wyMin + cssH / scale,
    }
    this.paintedZoom = zoom
    this.paintedNW = worldToLatLng(wxMin, wyMin)
    const p = proj.fromLatLngToDivPixel(this.paintedNW)
    if (!p) return

    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    canvas.style.left = `${p.x}px`
    canvas.style.top = `${p.y}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const { wxMax, wyMax } = this.painted
    const tiny = zoom < this.opts.minPinZoom
    const numbers = !tiny && zoom >= this.opts.numbersMinZoom && this.opts.showNumbers()
    const px = (wx: number) => (wx - wxMin) * scale
    const py = (wy: number) => (wy - wyMin) * scale

    const dot = (x: number, y: number, r: number, fill: string) => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
    }
    const pill = (x: number, y: number, text: string, h: number, fill: string, ring: string | null, ringW: number) => {
      const w = Math.max(h, 10 + text.length * 7)
      if (ring) {
        rounded(ctx, x - w / 2 - ringW, y - h / 2 - ringW, w + ringW * 2, h + ringW * 2, 9)
        ctx.fillStyle = ring
        ctx.fill()
      }
      rounded(ctx, x - w / 2 - 1.5, y - h / 2 - 1.5, w + 3, h + 3, 8)
      ctx.fillStyle = '#fff'
      ctx.fill()
      rounded(ctx, x - w / 2, y - h / 2, w, h, 7)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(text, x, y + 0.5)
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '700 11px system-ui, sans-serif'

    // Painter's order: plain doors, then draft members, then the anchor.
    const late: InternalDoor[] = []
    let anchorDoor: InternalDoor | null = null
    for (const d of this.doors.values()) {
      if (d.wx < wxMin || d.wx > wxMax || d.wy < wyMin || d.wy > wyMax) continue
      const paint = this.opts.paintFor(d.id)
      if (paint.anchor) {
        anchorDoor = d
        continue
      }
      if (paint.inDraft) {
        late.push(d)
        continue
      }
      this.paintDoor(ctx, px(d.wx), py(d.wy), d, paint, tiny, numbers, dot, pill)
    }
    for (const d of late) {
      this.paintDoor(ctx, px(d.wx), py(d.wy), d, this.opts.paintFor(d.id), tiny, numbers, dot, pill)
    }
    if (anchorDoor) {
      this.paintDoor(
        ctx,
        px(anchorDoor.wx),
        py(anchorDoor.wy),
        anchorDoor,
        this.opts.paintFor(anchorDoor.id),
        tiny,
        numbers,
        dot,
        pill,
      )
    }
  }

  private paintDoor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    d: InternalDoor,
    paint: DoorPaintState,
    tiny: boolean,
    numbers: boolean,
    dot: (x: number, y: number, r: number, fill: string) => void,
    pill: (x: number, y: number, text: string, h: number, fill: string, ring: string | null, ringW: number) => void,
  ) {
    if (tiny) {
      // Zoomed out: tiny dots; turf rings still show so the county-wide cut
      // reads as colored coverage.
      if (paint.ring) dot(x, y, 4, paint.ring)
      dot(x, y, 2.5, paint.fill)
      return
    }
    if (numbers && d.house) {
      const h = paint.anchor ? 24 : paint.inDraft ? 20 : 19
      pill(x, y, d.house, h, paint.fill, paint.anchor ? '#111' : paint.ring, paint.anchor ? 3 : 2.5)
      return
    }
    if (paint.anchor) {
      dot(x, y, 12 + 5, '#111')
      dot(x, y, 12 + 2, '#fff')
      dot(x, y, 12, paint.fill)
      if (paint.ring) dot(x, y, 5, paint.ring)
      return
    }
    const r = paint.inDraft ? 8.5 : 6.5
    if (paint.ring) dot(x, y, r + 4, paint.ring)
    dot(x, y, r + 1.5, '#fff')
    dot(x, y, r, paint.fill)
  }

  dispose() {
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.overlay.setMap(null)
  }
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function worldToLatLng(wx: number, wy: number): google.maps.LatLng {
  const lng = (wx / 256) * 360 - 180
  const n = Math.PI - (2 * Math.PI * wy) / 256
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return new google.maps.LatLng(lat, lng)
}
