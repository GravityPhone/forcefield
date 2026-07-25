// One-canvas door renderer — the shared rendering engine for ALL THREE maps
// (Scout / Squad / Turf cutter) since 2026-07-24. Born in the turf cutter
// (2026-07-23) and generalized outward once it was clear the cutter was the
// only map that felt fast.
//
// WHY ONE CANVAS AND NOT MARKERS: an AdvancedMarkerElement is a custom
// element wrapping your content div — 2-3 DOM nodes each — and Google writes
// a fresh transform to every one of them on every frame of every pan and
// zoom. At a couple thousand doors that's thousands of per-frame style
// writes plus layout, which is what made Scout crawl on phones (and what
// the density-blob decluttering was working around). Here EVERY door paints
// onto ONE canvas sized ~2x the viewport, positioned in an OverlayView pane
// so it rides map pans for free. Google moves one DOM node. A full repaint
// is a few milliseconds, so paint-state changes just repaint (rAF-coalesced)
// and there is no pin cap at all.
//
// Doors paint ONLY when the view's paintFor returns a state for them, and an
// unpainted door is also untappable — that's how the cutter shows just the
// located/trimmed street while Scout and Squad simply return a state for
// everything. Hit testing runs in Web-Mercator "world" coordinates
// (precomputed per door) off the map's own click events; the canvas never
// intercepts pointer events.
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

/** Below this zoom every map drops to tiny dots — no house numbers, no
 * tap-sized pins. Shared so all three maps change scale at the same moment. */
export const PINS_MIN_ZOOM = 15
/** House-number pills need at least this zoom (AND pinMode() === 'numbers').
 * Numbers only mean something once you're looking at one street. */
export const NUMBERS_MIN_ZOOM = 16
/** How close a tap must land to count as hitting a door. */
export const TAP_RADIUS_PX = 22

/** Fixed red accent for the taken-door symbol — matches the outcomes' "no"
 * red, but only ever drawn as a ring/glyph, never a fill. */
const TAKEN_ACCENT = '#d64545'
/** The one canvas font (house-number pills) — restored after any glyph draw
 * that changes it, since repaint() sets it once up front. */
const PILL_FONT = '700 11px system-ui, sans-serif'

export interface CanvasDoor {
  id: string
  lat: number
  lng: number
  /** Leading house number as text, '' when none. */
  house: string
}

/** An avatar/initial chip drawn ON a door — Squad's "who covered this today"
 * marker, and the glyph inside the cutter's taken symbol. */
export interface DoorBadge {
  /** Single letter fallback while the image loads (or when there's none). */
  initial: string
  /** Decoded avatar bitmap, or null. Call requestRepaint() from its onload. */
  img: HTMLImageElement | null
  /** Backing color behind the initial fallback. */
  color?: string
}

export interface DoorPaintState {
  /** Dot fill — the door's status color (white/blue when there's nothing to
   * say, depending on the map). */
  fill: string
  /** Membership ring just outside the white gap: the cutter's draft ring, a
   * turf's identity color, Scout's located highlight. Null for none. */
  ring: string | null
  /** Outermost hairline ring, outside `ring` — Scout's "somebody already
   * knocked here today" halo. */
  halo?: string | null
  /** Thin status ring tight around the fill — the partly-signed yellow
   * around a green center. */
  innerRing?: string | null
  /** Hairline outline so light (white) fills stay visible on the basemap. */
  outline?: string | null
  /** House-number pill text color (defaults to white). */
  ink?: string
  /** Draw bigger and above plain doors — the cutter's draft members, Scout's
   * located door, Squad's assign selection. */
  emphasis: boolean
  /** Fade the whole door (Squad greys doors it can't hand out). 0-1. */
  alpha?: number
  /** Breathing ring — Squad's assign-mode walk anchor. Costs an animation
   * loop while any painted door asks for it, so use it for transient modes
   * only, never as a resting state. */
  pulse?: boolean
  /** Avatar chip carried BY the door (Squad: the squadmate who knocked it
   * today). Drawn inside the pill / as the dot's center; the status color
   * stays legible as the surrounding ring. */
  badge?: DoorBadge | null
  /** Door belongs to a DIFFERENT turf: draw the uniform "taken" symbol — a
   * hollow red-ringed disc carrying the owner-assignee's avatar/initial (or
   * a slash when unassigned) — INSTEAD of a status dot. Deliberately a
   * symbol, never a solid red fill, so it can't be read as a closed door. */
  taken?: DoorBadge | null
}

export interface DoorCanvasOptions {
  /** Below this zoom painted doors draw as tiny dots (no numbers). */
  minPinZoom?: number
  /** House-number pills need at least this zoom (AND pinMode() === 'numbers'). */
  numbersMinZoom?: number
  /** Live pin-style pref, read fresh each repaint like paintFor — 'numbers'
   * still falls back to dots below numbersMinZoom. */
  pinMode(): 'dots' | 'numbers'
  /** Paint state for a door, or null to skip it entirely — unpainted doors
   * are also invisible to doorAt(). */
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

/** One "plink" — the pop a door makes as a live knock lands on it. */
interface Plink {
  start: number
  duration: number
  peak: number
}

export class DoorCanvasLayer {
  private overlay: google.maps.OverlayView
  private map: google.maps.Map
  private opts: Required<Pick<DoorCanvasOptions, 'minPinZoom' | 'numbersMinZoom'>> &
    DoorCanvasOptions
  private canvas: HTMLCanvasElement | null = null
  private doors = new Map<string, InternalDoor>()
  private raf = 0
  private disposed = false
  // Animation state — a self-limiting rAF loop runs ONLY while a plink is in
  // flight or a painted door asked to pulse, then stops on its own.
  private plinks = new Map<string, Plink>()
  private wantsPulse = false
  private animRaf = 0
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
    this.opts = {
      minPinZoom: opts.minPinZoom ?? PINS_MIN_ZOOM,
      numbersMinZoom: opts.numbersMinZoom ?? NUMBERS_MIN_ZOOM,
      ...opts,
    }
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

  removeDoor(id: string) {
    this.doors.delete(id)
  }

  hasDoor(id: string): boolean {
    return this.doors.has(id)
  }

  /** Pop a door as a knock lands on it — the "plink" that makes a teammate's
   * live progress watchable. `peak` is the scale multiplier at the top of
   * the bounce (squadmates pop harder than the rest of the org).
   *
   * Skipped below minPinZoom: the door is a 2px dot there, so the pop is
   * invisible anyway — and animating means repainting every painted door at
   * 60fps, which at town zoom is the whole county. Falls back to a single
   * repaint so the new status color still lands. */
  plink(id: string, peak = 1.8, duration = 600) {
    if (!this.doors.has(id)) return
    if ((this.map.getZoom() ?? 0) < this.opts.minPinZoom) {
      this.requestRepaint()
      return
    }
    this.plinks.set(id, { start: performance.now(), duration, peak })
    this.runAnimation()
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

  /** Drives pulses and plinks. Self-limiting: the loop stops the moment no
   * plink is live and the last repaint saw no pulsing door. */
  private runAnimation() {
    if (this.animRaf || this.disposed) return
    this.animRaf = requestAnimationFrame(() => {
      this.animRaf = 0
      const now = performance.now()
      for (const [id, p] of this.plinks) {
        if (now - p.start >= p.duration) this.plinks.delete(id)
      }
      this.repaint()
      if (this.plinks.size || this.wantsPulse) this.runAnimation()
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
  doorAt(latLng: google.maps.LatLng, pxRadius: number = TAP_RADIUS_PX): string | null {
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

  /** Ids of doors inside a closed container-pixel polygon (the lasso), plus
   * — when `brushPx` is set — doors the lasso LINE passes within that many
   * screen pixels of: brushing over a dot counts, full enclosure isn't
   * required. All doors count here, painted or not — the lasso selects
   * data, not pixels. */
  doorsInPolygon(path: { x: number; y: number }[], brushPx = 0): string[] {
    if (path.length < 3) return []
    const world: [number, number][] = []
    for (const p of path) {
      const ll = this.containerToLatLng(p.x, p.y)
      if (!ll) return []
      world.push([worldX(ll.lng()), worldY(ll.lat())])
    }
    const zoom = this.map.getZoom()
    const rw = brushPx && zoom != null ? brushPx / 2 ** zoom : 0
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
    // Squared distance from a point to the path (closing segment included —
    // it's drawn, so it should brush too).
    const nearPath = (x: number, y: number) => {
      const r2 = rw * rw
      for (let i = 0, j = world.length - 1; i < world.length; j = i++) {
        const [ax, ay] = world[j]
        const [bx, by] = world[i]
        const dx = bx - ax
        const dy = by - ay
        const len2 = dx * dx + dy * dy
        const t = len2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
        const px = x - (ax + dx * t)
        const py = y - (ay + dy * t)
        if (px * px + py * py <= r2) return true
      }
      return false
    }
    const out: string[] = []
    for (const d of this.doors.values()) {
      if (d.wx < wxMin - rw || d.wx > wxMax + rw || d.wy < wyMin - rw || d.wy > wyMax + rw) continue
      if (inside(d.wx, d.wy) || (rw > 0 && nearPath(d.wx, d.wy))) out.push(d.id)
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

    // Assigning width/height also clears the bitmap — only do it when the
    // size actually changed, so a 60fps plink loop isn't reallocating.
    const wantW = Math.round(cssW * dpr)
    const wantH = Math.round(cssH * dpr)
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW
      canvas.height = wantH
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
    }
    canvas.style.left = `${p.x}px`
    canvas.style.top = `${p.y}px`
    canvas.style.transform = ''

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const { wxMax, wyMax } = this.painted
    const tiny = zoom < this.opts.minPinZoom
    const numbers = !tiny && zoom >= this.opts.numbersMinZoom && this.opts.pinMode() === 'numbers'
    const px = (wx: number) => (wx - wxMin) * scale
    const py = (wy: number) => (wy - wyMin) * scale

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = PILL_FONT

    // Animation clock: plink scale per door, and a shared 0-1 pulse phase.
    const now = performance.now()
    const pulsePhase = (now % 1100) / 1100
    this.wantsPulse = false
    const plinkScale = (id: string) => {
      const p2 = this.plinks.get(id)
      if (!p2) return 1
      const t = Math.min(1, (now - p2.start) / p2.duration)
      // Up fast, back down with an ease-out settle.
      const bump = Math.sin(t * Math.PI)
      return 1 + (p2.peak - 1) * bump * bump
    }

    // Painter's order: plain doors first, emphasized ones above them.
    const late: InternalDoor[] = []
    for (const d of this.doors.values()) {
      if (d.wx < wxMin || d.wx > wxMax || d.wy < wyMin || d.wy > wyMax) continue
      const paint = this.opts.paintFor(d.id)
      if (!paint) continue
      if (paint.emphasis) {
        late.push(d)
        continue
      }
      this.paintDoor(ctx, px(d.wx), py(d.wy), d, paint, tiny, numbers, plinkScale(d.id), pulsePhase)
    }
    for (const d of late) {
      const paint = this.opts.paintFor(d.id)
      if (paint) {
        this.paintDoor(ctx, px(d.wx), py(d.wy), d, paint, tiny, numbers, plinkScale(d.id), pulsePhase)
      }
    }
    // A pulsing door was painted this frame — keep the clock running.
    if (this.wantsPulse && !this.animRaf) this.runAnimation()
  }

  private paintDoor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    d: InternalDoor,
    paint: DoorPaintState,
    tiny: boolean,
    numbers: boolean,
    pop: number,
    pulsePhase: number,
  ) {
    const alpha = paint.alpha ?? 1
    const scaled = pop !== 1
    if (alpha !== 1 || scaled) {
      ctx.save()
      if (alpha !== 1) ctx.globalAlpha = alpha
      if (scaled) {
        ctx.translate(x, y)
        ctx.scale(pop, pop)
        ctx.translate(-x, -y)
      }
    }
    if (paint.pulse) {
      this.wantsPulse = true
      // Breathing ring around the door — the walk anchor's "tap another door
      // and everything between comes with it" cue.
      const r = (tiny ? 6 : 13) + pulsePhase * (tiny ? 4 : 9)
      ctx.save()
      ctx.globalAlpha = alpha * (1 - pulsePhase) * 0.9
      strokeCircle(ctx, x, y, r, paint.ring ?? paint.fill, 2.5)
      ctx.restore()
    }
    if (paint.taken) {
      // Taken doors stay a symbol at every zoom — their house number matters
      // less than "not yours", so no number pill.
      this.paintTaken(ctx, x, y, paint.taken, tiny)
    } else if (tiny) {
      if (paint.halo) dot(ctx, x, y, 5.6, paint.halo)
      if (paint.ring) dot(ctx, x, y, 4.5, paint.ring)
      if (paint.innerRing) dot(ctx, x, y, 3.2, paint.innerRing)
      dot(ctx, x, y, 2.2, paint.fill)
      if (paint.outline) strokeCircle(ctx, x, y, 2.2, paint.outline, 1)
    } else if (numbers && d.house) {
      this.paintPill(ctx, x, y, d.house, paint)
    } else {
      this.paintDot(ctx, x, y, paint)
    }
    if (alpha !== 1 || scaled) ctx.restore()
  }

  /** Round door: halo / membership ring / white gap / status fill, with the
   * badge avatar (when there is one) filling the center and the status color
   * demoted to a thick surrounding band so both still read. */
  private paintDot(ctx: CanvasRenderingContext2D, x: number, y: number, paint: DoorPaintState) {
    const badge = paint.badge
    const r = paint.emphasis || badge ? 8.5 : 6.5
    if (paint.halo) dot(ctx, x, y, r + 6, paint.halo)
    if (paint.ring) dot(ctx, x, y, r + 4, paint.ring)
    dot(ctx, x, y, r + 1.5, '#fff')
    if (badge) {
      dot(ctx, x, y, r, paint.fill)
      // With a badge the innerRing can't be a band (the avatar owns the
      // middle), so it strokes the fill's rim instead — a partly-signed door
      // someone covered today still shows its yellow edge.
      if (paint.innerRing) strokeCircle(ctx, x, y, r - 1, paint.innerRing, 2)
      drawBadge(ctx, x, y, r - 2.6, badge)
      return
    }
    if (paint.innerRing) {
      // Partly signed: yellow band around the green center.
      dot(ctx, x, y, r, paint.innerRing)
      dot(ctx, x, y, r - 2.5, paint.fill)
    } else {
      dot(ctx, x, y, r, paint.fill)
      if (paint.outline) strokeCircle(ctx, x, y, r, paint.outline, 1.2)
    }
  }

  /** House-number chip. With a badge the pill grows a leading avatar circle,
   * same shape the Squad map's DOM pins had. */
  private paintPill(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    paint: DoorPaintState,
  ) {
    const badge = paint.badge
    const h = badge ? 22 : paint.emphasis ? 21 : 19
    const badgeR = h / 2 - 2.5
    const w = Math.max(h, 10 + text.length * 7) + (badge ? badgeR * 2 + 3 : 0)
    const ringW = 2.5
    if (paint.halo) {
      rounded(ctx, x - w / 2 - ringW - 2, y - h / 2 - ringW - 2, w + (ringW + 2) * 2, h + (ringW + 2) * 2, 11)
      ctx.fillStyle = paint.halo
      ctx.fill()
    }
    if (paint.ring) {
      rounded(ctx, x - w / 2 - ringW, y - h / 2 - ringW, w + ringW * 2, h + ringW * 2, 9)
      ctx.fillStyle = paint.ring
      ctx.fill()
    }
    rounded(ctx, x - w / 2 - 1.5, y - h / 2 - 1.5, w + 3, h + 3, 8)
    ctx.fillStyle = '#fff'
    ctx.fill()
    rounded(ctx, x - w / 2, y - h / 2, w, h, 7)
    ctx.fillStyle = paint.fill
    ctx.fill()
    if (paint.outline) {
      rounded(ctx, x - w / 2, y - h / 2, w, h, 7)
      ctx.strokeStyle = paint.outline
      ctx.lineWidth = 1
      ctx.stroke()
    }
    if (paint.innerRing) {
      rounded(ctx, x - w / 2 + 1, y - h / 2 + 1, w - 2, h - 2, 6)
      ctx.strokeStyle = paint.innerRing
      ctx.lineWidth = 2
      ctx.stroke()
    }
    let textX = x
    if (badge) {
      const bx = x - w / 2 + badgeR + 2.5
      drawBadge(ctx, bx, y, badgeR, badge)
      textX = x + badgeR + 1.5
    }
    ctx.fillStyle = paint.ink ?? '#fff'
    ctx.fillText(text, textX, y + 0.5)
  }

  /** The "someone else's turf" symbol: a white disc in a red ring — clearly
   * a marker, never confusable with the solid red closed-door fill. Center:
   * the owning assignee's avatar (clipped round) or initial, else a slash. */
  private paintTaken(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    badge: DoorBadge,
    tiny: boolean,
  ) {
    if (tiny) {
      dot(ctx, x, y, 3.2, '#fff')
      strokeCircle(ctx, x, y, 3.2, TAKEN_ACCENT, 1.6)
      return
    }
    const r = 7.5
    dot(ctx, x, y, r, '#fff')
    const img = badge.img
    if (img && img.complete && img.naturalWidth > 0) {
      drawBadge(ctx, x, y, r - 1, badge)
    } else if (badge.initial) {
      ctx.fillStyle = TAKEN_ACCENT
      ctx.font = '800 9px system-ui, sans-serif'
      ctx.fillText(badge.initial, x, y + 0.5)
      ctx.font = PILL_FONT
    } else {
      ctx.beginPath()
      ctx.moveTo(x - r * 0.55, y + r * 0.55)
      ctx.lineTo(x + r * 0.55, y - r * 0.55)
      ctx.strokeStyle = TAKEN_ACCENT
      ctx.lineWidth = 2
      ctx.stroke()
    }
    strokeCircle(ctx, x, y, r, TAKEN_ACCENT, 2)
  }

  dispose() {
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.animRaf) cancelAnimationFrame(this.animRaf)
    this.plinks.clear()
    this.overlay.setMap(null)
  }
}

/** Avatar disc: the bitmap clipped round when it's decoded, else the
 * initial on the badge color (matching how the DOM markers degraded). */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, badge: DoorBadge) {
  const img = badge.img
  dot(ctx, x, y, r, badge.color ?? '#fff')
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2)
    ctx.restore()
    return
  }
  if (!badge.initial) return
  ctx.fillStyle = '#fff'
  ctx.font = `800 ${Math.round(r * 1.25)}px system-ui, sans-serif`
  ctx.fillText(badge.initial, x, y + 0.5)
  ctx.font = PILL_FONT
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

function strokeCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  width: number,
) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
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
  const lat = (180 / Math.PI) * (Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))))
  return new google.maps.LatLng(lat, lng)
}
