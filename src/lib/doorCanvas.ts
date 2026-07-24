// One-canvas door renderer for the turf cutter (2026-07-23; slimmed to
// doors-only 2026-07-24 when the derived street lines came out as squiggles
// that didn't sit on the real roads — the map now stays blank except for
// the doors of the street being located/trimmed).
//
// Doors paint ONLY when the view's paintFor returns a state for them (the
// located street and the street being trimmed); everything else is
// invisible AND untappable. The lasso still hit-tests every door — it
// selects data, not pixels.
//
// Rendering stays the VAN/Felt/Mapbox-class approach: everything paints on
// ONE canvas sized ~2× the viewport, positioned in an OverlayView pane so it
// rides map pans for free. A full repaint is a few milliseconds, so state
// changes just repaint (rAF-coalesced). Hit testing runs in Web-Mercator
// "world" coordinates (precomputed per door) off the map's own click events
// — the canvas never intercepts pointer events.
//
// Zoom fix (the "dots drift while zooming" bug): during a zoom animation the
// painted bitmap is at the OLD scale, and repositioning only its top-left
// corner made everything slide relative to the basemap. reposition() now
// projects BOTH painted corners each draw() and stretches the canvas with a
// CSS scale transform to match the live projection — content tracks the
// animation exactly (slightly soft mid-zoom), then the settled 'idle'
// repaint redraws it crisp. Never repaint mid-animation: getZoom() returns
// the TARGET zoom while getBounds() still animates, so a mid-zoom repaint
// computes a misregistered box.

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
}

export interface DoorCanvasOptions {
  /** Below this zoom painted doors draw as tiny dots (no numbers). */
  minPinZoom: number
  /** House-number pills need at least this zoom. */
  numbersMinZoom: number
  /** Paint state for a door, or null to skip it entirely — unpainted doors
   * are also invisible to doorAt(), so only the located/trimmed street is
   * tappable door-by-door. */
  paintFor(id: string): DoorPaintState | null
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
  // Painted-region state: reposition is valid while the view stays inside
  // the painted world-coordinate box (zoom drift is absorbed by the CSS
  // scale transform until the next settled repaint).
  private paintedZoom = -1
  private paintedNW: google.maps.LatLng | null = null
  private paintedSE: google.maps.LatLng | null = null
  private paintedCssW = 0
  private painted = { wxMin: 0, wxMax: 0, wyMin: 0, wyMax: 0 }

  constructor(map: google.maps.Map, opts: DoorCanvasOptions) {
    this.map = map
    this.opts = opts
    this.overlay = new google.maps.OverlayView()
    this.overlay.onAdd = () => {
      const c = document.createElement('canvas')
      c.style.position = 'absolute'
      c.style.pointerEvents = 'none'
      c.style.transformOrigin = '0 0'
      this.overlay.getPanes()?.overlayLayer.appendChild(c)
      this.canvas = c
    }
    this.overlay.onRemove = () => {
      this.canvas?.remove()
      this.canvas = null
    }
    // Called by the API on every frame of pans/zooms and on coordinate
    // re-bases. Repaint right away when a PAN escapes the painted margin
    // (bounds are accurate mid-pan), but never mid-zoom — getZoom() reports
    // the target zoom while getBounds() still animates, so a mid-zoom
    // repaint would misregister; the scale transform covers until 'idle'.
    this.overlay.draw = () => {
      if (this.reposition() && (this.map.getZoom() ?? -1) === this.paintedZoom) {
        this.requestRepaint()
      }
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

  /** Re-anchor (and mid-zoom, re-scale) the canvas to the live projection.
   * Returns true when a repaint is due: zoom settled somewhere new, or the
   * view escaped the painted region. */
  private reposition(): boolean {
    if (!this.canvas || !this.paintedNW || !this.paintedSE) return true
    const proj = this.overlay.getProjection()
    if (!proj) return false
    const p1 = proj.fromLatLngToDivPixel(this.paintedNW)
    const p2 = proj.fromLatLngToDivPixel(this.paintedSE)
    if (p1 && p2) {
      this.canvas.style.left = `${p1.x}px`
      this.canvas.style.top = `${p1.y}px`
      const s = this.paintedCssW ? (p2.x - p1.x) / this.paintedCssW : 1
      this.canvas.style.transform = Math.abs(s - 1) < 0.001 ? '' : `scale(${s})`
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

  /** Coalesced repaint — call whenever paint state changed. */
  requestRepaint() {
    if (this.raf || this.disposed) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.repaint()
    })
  }

  /** For map 'idle': repaint if the settled view outgrew the painted box or
   * arrived at a new zoom. */
  checkView() {
    if (this.reposition()) this.requestRepaint()
  }

  containerToLatLng(x: number, y: number): google.maps.LatLng | null {
    const proj = this.overlay.getProjection()
    return proj?.fromContainerPixelToLatLng(new google.maps.Point(x, y)) ?? null
  }

  /** Nearest PAINTED door within `pxRadius` screen pixels, or null. Doors
   * whose paintFor is null don't count. */
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
      if (!this.opts.paintFor(d.id)) continue
      const dist = dx * dx + dy * dy
      if (dist <= bestD) {
        bestD = dist
        best = d.id
      }
    }
    return best
  }

  /** Ids of doors inside a closed container-pixel polygon (the lasso). All
   * doors count here, painted or not — the lasso selects data, not pixels. */
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
    this.paintedCssW = cssW
    this.paintedNW = worldToLatLng(wxMin, wyMin)
    this.paintedSE = worldToLatLng(this.painted.wxMax, this.painted.wyMax)
    const p = proj.fromLatLngToDivPixel(this.paintedNW)
    if (!p) return

    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    canvas.style.left = `${p.x}px`
    canvas.style.top = `${p.y}px`
    canvas.style.transform = ''

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const { wxMax, wyMax } = this.painted
    const tiny = zoom < this.opts.minPinZoom
    const numbers = !tiny && zoom >= this.opts.numbersMinZoom
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

    // Painter's order: excluded doors first, draft members above them.
    const late: InternalDoor[] = []
    for (const d of this.doors.values()) {
      if (d.wx < wxMin || d.wx > wxMax || d.wy < wyMin || d.wy > wyMax) continue
      const paint = this.opts.paintFor(d.id)
      if (!paint) continue
      if (paint.inDraft) {
        late.push(d)
        continue
      }
      this.paintDoor(ctx, px(d.wx), py(d.wy), d, paint, tiny, numbers, dot, pill)
    }
    for (const d of late) {
      const paint = this.opts.paintFor(d.id)
      if (paint) this.paintDoor(ctx, px(d.wx), py(d.wy), d, paint, tiny, numbers, dot, pill)
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
      if (paint.ring) dot(x, y, 4, paint.ring)
      dot(x, y, 2.5, paint.fill)
      return
    }
    if (numbers && d.house) {
      const h = paint.inDraft ? 20 : 19
      pill(x, y, d.house, h, paint.fill, paint.ring, 2.5)
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
