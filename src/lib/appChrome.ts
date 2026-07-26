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
    if (document.body.style.overflow !== 'hidden' || performance.now() >= deadline) {
      cb()
      return
    }
    setTimeout(tick, 24)
  }
  setTimeout(tick, 24)
}
