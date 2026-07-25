// One rule for how a map behaves inside a scrolling page — shared by Scout,
// the Squad map, and the turf cutter (2026-07-24, user call: "make sure I can
// scroll the map always with one finger… dragging around in there will just
// scroll the map, never scroll the screen. And that's how I wanna work with
// it on all the screens").
//
// Two things go wrong with a map embedded in a page, and both feel like the
// app is fighting you:
//
//  1. The browser steals the drag. `gestureHandling: 'greedy'` tells Maps to
//     pan on one finger, but the PAGE can still scroll from the same gesture
//     unless the element opts out of browser panning. That's the "finicky"
//     part — sometimes you pan the map, sometimes the page slides. Setting
//     touch-action: none on the wrapper hands every touch to Maps, which does
//     its own panning and pinching in JS.
//
//  2. You're reading the member cards, the map is half off the top of the
//     screen, and you reach up to grab it — panning a map you can only half
//     see is useless. So while the map is substantially off-screen, the FIRST
//     touch doesn't reach the map at all: it scrolls the map back into view
//     and stops there. Once it's on screen, gestures are the map's again.
//
// Fullscreen is exempt from (2) — the map IS the screen, nothing to scroll.

export interface MapScrollGuard {
  dispose(): void
}

export interface MapScrollGuardOptions {
  /** Element to bring into view — usually the map's card, so its chrome
   * comes along. Defaults to the wrapper itself. */
  scrollTarget?: () => HTMLElement | null
  /** True while the map is fullscreen: the scroll-into-view rule sits out. */
  isFullscreen?: () => boolean
}

/** Fraction of the map's height that must be on screen for gestures to reach
 * it. Below this a touch means "let me see the map" instead. */
const VISIBLE_ENOUGH = 0.9

function offScreen(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0) return false
  const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
  return visible / rect.height < VISIBLE_ENOUGH
}

/**
 * Attach the guard to a map wrapper. Returns a disposer — call it on unmount
 * (or when the wrapper is replaced).
 */
export function attachMapScrollGuard(
  wrap: HTMLElement,
  opts: MapScrollGuardOptions = {},
): MapScrollGuard {
  const previousTouchAction = wrap.style.touchAction
  // Drags inside the map are the map's, never the page's.
  wrap.style.touchAction = 'none'
  wrap.style.overscrollBehavior = 'contain'

  const onStart = (e: Event) => {
    if (opts.isFullscreen?.()) return
    // The map's own chrome (layer buttons, fullscreen, the assign bar) sits
    // inside the wrapper and stays live wherever the page is scrolled — this
    // rule is about the MAP surface, not the controls floating over it.
    const hit = e.target as HTMLElement | null
    if (hit?.closest?.('button, a, input, select, label')) return
    if (!offScreen(wrap)) return
    // Swallow the whole gesture: Maps never sees it, so the map doesn't pan
    // or drop a pin tap while it's sliding into place.
    e.preventDefault()
    e.stopPropagation()
    const target = opts.scrollTarget?.() ?? wrap
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Capture phase, non-passive: both are required to beat the Maps API's own
  // listeners to the gesture and to be allowed to preventDefault at all.
  const options: AddEventListenerOptions = { capture: true, passive: false }
  wrap.addEventListener('touchstart', onStart, options)
  wrap.addEventListener('pointerdown', onStart, options)
  wrap.addEventListener('mousedown', onStart, options)

  return {
    dispose() {
      wrap.style.touchAction = previousTouchAction
      wrap.style.overscrollBehavior = ''
      wrap.removeEventListener('touchstart', onStart, options)
      wrap.removeEventListener('pointerdown', onStart, options)
      wrap.removeEventListener('mousedown', onStart, options)
    },
  }
}
