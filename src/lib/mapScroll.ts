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
//
// Rule (2) was too eager and too violent about it (2026-07-25, user call:
// "I'm scrolling a whole page just when I tap at the top… it needs to be
// respective of what is in view"). Two changes:
//
//   * A map with a working amount of itself on screen is a map you can use.
//     The bar used to be 90% visible — with the top of the map under the
//     header and the house list up from the bottom, an entirely usable map
//     kept eating taps.
//   * When it does fire, it scrolls the LEAST it can rather than parking the
//     map's top at the top of the screen. Nudging a map down 80px to uncover
//     its top edge is a different thing from throwing the page a screenful.
//
// Both measure against the band between the sticky header and the tab bar,
// not the raw window — chrome sits over both ends of the screen now.

import { safeViewport, scrollDeltaInto } from './appChrome'

export interface MapScrollGuard {
  dispose(): void
}

export interface MapScrollGuardOptions {
  /** A wrapping card to bring along with the map, so its chrome arrives too —
   * honored only when it costs little extra travel. Defaults to the map. */
  scrollTarget?: () => HTMLElement | null
  /** True while the map is fullscreen: the scroll-into-view rule sits out. */
  isFullscreen?: () => boolean
}

/** Fraction of the map that has to be on screen for gestures to reach it. */
const VISIBLE_ENOUGH = 0.6
/** …but past this many pixels it's a usable map whatever the fraction says.
 * A tall map at 55% is still more map than most phones show at all. */
const VISIBLE_ENOUGH_PX = 220
/** Below this the scroll isn't worth stealing the tap for — just let the map
 * have it. */
const WORTH_SCROLLING_PX = 24
/** Extra travel we'll spend to bring a nominated card's top along with the
 * map. More than this and the card isn't what the tap was about. */
const CARD_HEADROOM_PX = 140

/** How far the page would have to move to put `el` properly on screen, and
 * whether it's currently too hidden to be worth touching. */
function hiddenBy(el: HTMLElement): number {
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0) return 0
  const safe = safeViewport()
  const visible = Math.min(rect.bottom, safe.bottom) - Math.max(rect.top, safe.top)
  const enough = Math.min(rect.height * VISIBLE_ENOUGH, VISIBLE_ENOUGH_PX)
  if (visible >= enough) return 0
  return scrollDeltaInto(rect, safe)
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
    // The MAP is what decides whether this fires and how far it has to move.
    let delta = hiddenBy(wrap)
    if (delta === 0) return
    // A caller can nominate a wrapping card so the map's chrome comes along —
    // worth a few more pixels of travel, never worth a screenful.
    const target = opts.scrollTarget?.()
    if (target && target !== wrap) {
      const withCard = scrollDeltaInto(target.getBoundingClientRect())
      if (Math.abs(withCard - delta) <= CARD_HEADROOM_PX) delta = withCard
    }
    if (Math.abs(delta) < WORTH_SCROLLING_PX) return
    // Swallow the whole gesture: Maps never sees it, so the map doesn't pan
    // or drop a pin tap while it's sliding into place.
    e.preventDefault()
    e.stopPropagation()
    window.scrollBy({ top: delta, behavior: 'smooth' })
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
