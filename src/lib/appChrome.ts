// The app's fixed chrome, and the strip of screen left between it (2026-07-25,
// user call: "I want the Forcefield and help and everything at the top to be
// always visible… so we got the static thing at the top and at the bottom").
//
// The header is sticky and the phone tab bar is fixed, which means the window
// is no longer the thing content gets scrolled into — the band between them
// is. Every "bring this into view" calculation in the app has to use that band
// or it lands things underneath the chrome: `scrollIntoView({block:'start'})`
// parks an element's top at y=0, which is behind the header.
//
// AppShell measures both pieces (they change with text size, the notch, and
// which role's tab bar is showing) and publishes them here; everyone else
// reads. The CSS custom properties are written from the same call so
// stylesheets can use them too — `scroll-padding-top` on the document, and
// any page-level `position: sticky` element that needs to sit below the
// header rather than under it.

let top = 0
let bottom = 0

/** Called by AppShell whenever the chrome is measured. */
export function setChromeInsets(next: { top?: number; bottom?: number }): void {
  if (next.top !== undefined) top = Math.max(0, Math.round(next.top))
  if (next.bottom !== undefined) bottom = Math.max(0, Math.round(next.bottom))
  const root = document.documentElement
  root.style.setProperty('--app-top-h', `${top}px`)
  root.style.setProperty('--app-bottom-h', `${bottom}px`)
}

/** Height of the sticky header block (header + desktop nav row). */
export function topInset(): number {
  return top
}

/** Height of the fixed bottom tab bar — 0 on desktop, where it isn't shown. */
export function bottomInset(): number {
  return bottom
}

export interface SafeViewport {
  /** Screen y of the first pixel below the header. */
  top: number
  /** Screen y of the first pixel behind the tab bar. */
  bottom: number
  height: number
}

/** The band of screen a user can actually see content in, right now. */
export function safeViewport(): SafeViewport {
  const winTop = top
  const winBottom = Math.max(winTop + 1, window.innerHeight - bottom)
  return { top: winTop, bottom: winBottom, height: winBottom - winTop }
}

/**
 * The SMALLEST page scroll that brings `rect` into the safe band — positive
 * scrolls the page down, negative up, 0 means it's already there.
 *
 * Minimal on purpose (2026-07-25, user call): jumping an element's top to the
 * top of the screen moves the page a long way for something that only needed
 * a nudge, and the ground you were reading goes with it.
 */
export function scrollDeltaInto(rect: DOMRect, safe: SafeViewport = safeViewport()): number {
  const overTop = safe.top - rect.top
  const overBottom = rect.bottom - safe.bottom
  if (overTop <= 0 && overBottom <= 0) return 0
  // Hanging off the top: bring it down until its top edge clears the header.
  if (overTop > 0) return -overTop
  // Hanging off the bottom, and too tall to fit anyway (a map usually is):
  // line its TOP up rather than its bottom, or the framing you get is the
  // last screenful of it with the top pushed off.
  if (rect.height >= safe.height) return rect.top - safe.top
  return overBottom
}

/** Scroll the page the least amount that puts `el` in the safe band. */
export function scrollIntoSafeView(el: HTMLElement, behavior: ScrollBehavior = 'smooth'): void {
  const delta = scrollDeltaInto(el.getBoundingClientRect())
  if (delta === 0) return
  window.scrollBy({ top: delta, behavior })
}

/** How long to let a smooth scroll run before judging where it landed. Chrome
 * and Safari both finish well inside this for a screenful or two; measuring
 * earlier just reads "not there yet" and cuts the animation off. */
const SMOOTH_SETTLE_MS = 600
/** Gap between verification passes. */
const VERIFY_EVERY_MS = 120
/** How long a still-locked page is waited out before giving up entirely. */
const LOCK_GRACE_MS = 1500

/**
 * True while a modal has the page scroll-locked, which makes every
 * programmatic scroll a silent no-op. The one place that knows which style
 * Reka writes — see afterScrollUnlock for the measurements.
 */
export function isScrollLocked(): boolean {
  return document.body.style.overflow === 'hidden'
}

/**
 * Put `el` in the safe band and CHECK that it stayed — correcting instantly if
 * it didn't, for a short window.
 *
 * One scroll is not enough when the thing that moved the page was a modal
 * closing (2026-07-26, second pass at the /squad assign landing). Measured on
 * /squad at 375×812: while a sheet is up, Reka's `body { overflow: hidden }`
 * collapses the document to the viewport and the page offset is CLAMPED TO 0 —
 * and it is **not** put back on unlock, so where the page IS by the time we get
 * to move it is not where the tap left it. Three more things can undo a single
 * scroll: the layout behind the sheet is often still settling (assign mode
 * inserts a bar INSIDE its target card, above the map, which shifts the target
 * down after the scroll has started), a smooth scroll is an animation any stray
 * touch cancels, and the unlock can simply be detected late.
 *
 * So the landing is verified rather than assumed, and a locked page is waited
 * out instead of scrolled at — an attempt made under the lock is not slow, it
 * is lost. The first real move animates (the page is usually a long way off and
 * a jump loses the reader) and every correction after it is instant, because a
 * second smooth scroll would only race the first. Corrections fire only when
 * the element is genuinely outside the band — `scrollDeltaInto` returns 0
 * otherwise — so a page that landed right the first time never moves twice.
 */
export function keepInSafeView(el: HTMLElement, holdMs = 700): void {
  let animated = false
  const move = (): void => {
    // Re-read the rect every time: the element may have moved rather than the
    // page, which is exactly the assign-bar case.
    const delta = scrollDeltaInto(el.getBoundingClientRect())
    if (delta === 0) return
    window.scrollBy({ top: delta, behavior: animated ? 'auto' : 'smooth' })
    animated = true
  }
  if (!isScrollLocked()) move()
  // The settle window opens on the first tick that can actually scroll, so a
  // slow or stalled sheet close spends the grace period, not the window.
  let deadline = 0
  const hardStop = performance.now() + SMOOTH_SETTLE_MS + holdMs + LOCK_GRACE_MS
  const tick = (): void => {
    const now = performance.now()
    if (now > hardStop) return
    if (isScrollLocked()) {
      setTimeout(tick, VERIFY_EVERY_MS)
      return
    }
    if (!deadline) deadline = now + holdMs
    move()
    if (now < deadline) setTimeout(tick, VERIFY_EVERY_MS)
  }
  setTimeout(tick, SMOOTH_SETTLE_MS)
}

/**
 * Run `cb` once the modal scroll lock is off — i.e. once the last BottomSheet
 * is really gone, not merely closing.
 *
 * A sheet is a Reka UI dialog, and Reka locks the page by setting
 * `body { overflow: hidden }`. Measured 2026-07-26 on /squad: with the page
 * scrolled to 722, that one style collapses the document's scrollable height
 * from 1534 to the viewport's 812, clamps the offset to 0, and makes every
 * programmatic scroll a SILENT no-op — scrollTo, scrollBy and scrollIntoView
 * all return having done nothing. The offset is not restored on unlock, so a
 * scroll attempted during the lock isn't merely delayed; it's lost, and the
 * page settles back roughly where it was.
 *
 * The trap is that the lock outlives the close: it's released when
 * DialogContent UNMOUNTS, which waits out the 0.2s slide-down animation. So
 * "close the sheet, then scroll" has to actually wait, and a nextTick or a
 * frame is nowhere near long enough. Poll instead, with a deadline so a stuck
 * animation can't strand the callback forever. With no sheet open this costs
 * one tick.
 *
 * A timer rather than requestAnimationFrame, deliberately: frames stop
 * entirely while the page is hidden, so an rAF poll parks a half-finished
 * gesture until the canvasser comes back and then scrolls the page out from
 * under them. A throttled timer still resolves. When visible the two are
 * indistinguishable.
 */
export function afterScrollUnlock(cb: () => void, timeoutMs = 900): void {
  const deadline = performance.now() + timeoutMs
  const tick = () => {
    // The style Reka actually writes — the thing blocking the scroll — rather
    // than a guess at which element is a sheet. A second sheet still up keeps
    // it set, which is correct: we'd only no-op again.
    if (!isScrollLocked() || performance.now() >= deadline) {
      cb()
      return
    }
    setTimeout(tick, 24)
  }
  setTimeout(tick, 24)
}
