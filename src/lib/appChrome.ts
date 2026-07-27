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

/** Gap between verification passes. */
const VERIFY_EVERY_MS = 120
/** How long a still-locked page is waited out before giving up entirely. */
const LOCK_GRACE_MS = 1500
/** Anything from a real hand ends the hold — never fight a live gesture. */
const HAND_BACK_EVENTS = ['touchstart', 'wheel', 'keydown'] as const

/**
 * True while a modal has the page scroll-locked, which makes every
 * programmatic scroll a silent no-op. The one place that knows which style
 * Reka writes — see afterScrollUnlock for the measurements.
 */
export function isScrollLocked(): boolean {
  return document.body.style.overflow === 'hidden'
}

/**
 * HOLD `el` inside the safe band for a moment — undoing anything that moves it
 * out, and moving nothing when it's already there.
 *
 * This is a hold, not a scroll, and that distinction is the whole third pass at
 * the /squad assign landing (2026-07-26). What a sheet does to the page offset
 * is engine-specific and can't be relied on either way: measured here in
 * desktop Chrome, `body { overflow: hidden }` collapses the document and CLAMPS
 * the offset to 0, and it stays at 0 on unlock — which happens to leave the map
 * on screen, so nothing needs to move at all. On the reporter's phone the
 * clamp happens too but the offset IS put back on unlock, so the page pans down
 * to where the tap was and something has to put it back. Both were reported as
 * bugs, in opposite directions: first "it snapped to the bottom" (the restore
 * won a race against a one-shot scroll), then "it pans down to the bottom and
 * back up" (the restore won, then a smooth correction visibly dragged the page
 * up again).
 *
 * So: never animate — an animation IS the visible pan, and the page is usually
 * already showing the target anyway. Correct inside the `scroll` event, which
 * runs before the frame is painted, so a restore is undone without ever being
 * seen. Keep a timer as well, because the target can move rather than the page
 * (assign mode inserts its bar INSIDE the map card, above the map) and because
 * an engine needn't fire a scroll event for a clamp — measured: this Chrome
 * fires none for either the clamp or the unlock. A locked page is waited out
 * rather than scrolled at; an attempt made under the lock isn't slow, it's lost.
 *
 * Corrections fire only when the element is genuinely outside the band
 * (`scrollDeltaInto` returns 0 otherwise), so a page that was already right
 * never moves — and any touch, wheel or key hands the page straight back.
 */
export function keepInSafeView(el: HTMLElement, holdMs = 700): void {
  let finished = false
  const correct = (): void => {
    if (finished) return
    // Re-read the rect every time: the element may have moved rather than the
    // page, which is exactly the assign-bar case.
    const delta = scrollDeltaInto(el.getBoundingClientRect())
    // Instant, deliberately. Correcting inside the scroll event lands before
    // paint, so the position being undone is never shown; a smooth scroll would
    // put it on screen and then animate away from it. The correction settles on
    // itself — the scroll it causes re-enters here with a delta of 0.
    if (delta !== 0) window.scrollBy({ top: delta, behavior: 'auto' })
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    window.removeEventListener('scroll', correct)
    for (const ev of HAND_BACK_EVENTS) window.removeEventListener(ev, finish)
  }
  window.addEventListener('scroll', correct, { passive: true })
  for (const ev of HAND_BACK_EVENTS) window.addEventListener(ev, finish, { passive: true })

  // The hold window opens on the first tick that can actually scroll, so a slow
  // or stalled sheet close spends the grace period, not the window.
  let deadline = 0
  const hardStop = performance.now() + holdMs + LOCK_GRACE_MS
  const tick = (): void => {
    if (finished) return
    const now = performance.now()
    if (now > hardStop) return finish()
    if (isScrollLocked()) {
      setTimeout(tick, VERIFY_EVERY_MS)
      return
    }
    if (!deadline) deadline = now + holdMs
    correct()
    if (now < deadline) setTimeout(tick, VERIFY_EVERY_MS)
    else finish()
  }
  if (!isScrollLocked()) correct()
  setTimeout(tick, VERIFY_EVERY_MS)
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

/**
 * HOLD THE PAGE STILL across a Reka scroll lock, and put the offset back after.
 * Call the instant something opens, BEFORE the lock lands; call the returned
 * release when it closes.
 *
 * The lock is `body { overflow: hidden }`, which collapses the document to
 * viewport height and therefore CLAMPS the scroll offset to 0. For a sheet
 * that's survivable — it's anchored to the bottom of the screen either way.
 * For anything anchored to its TRIGGER it is fatal, and that's what this is
 * for: measured live on /appearance at a 593px viewport, opening the font
 * dropdown 2015px down the page moved its trigger from viewport top 268 to
 * top 2282, so the menu rendered at 1955..2269 with exactly ZERO pixels on
 * screen — while the same lock made it impossible to scroll to. It reads as
 * the page freezing, and only a route change (which unmounts the lock) gets
 * you out. That is one tap on the longest page in the app.
 *
 * `position: fixed` with a negative `top` is the classic answer and the point
 * is that it changes nothing visually: the offset still clamps, but the page
 * has been lifted by exactly the amount it is about to lose, so the trigger
 * keeps its place on screen and the menu opens under the finger. Body being
 * fixed does NOT reparent the app's fixed chrome, which stays viewport-
 * relative absent a transform on the ancestor.
 *
 * Reka's own `padding-right` scrollbar compensation is deliberately left
 * alone: the scrollbar really does go away here, so that padding is
 * preventing a shift rather than causing one.
 *
 * `height: auto` is the other half and it is NOT optional — without it the
 * page behind the menu goes completely blank. style.css sets
 * `html, body { height: 100% }`, and the moment body is `position: fixed`
 * that 100% resolves against the VIEWPORT instead of the document; Reka's
 * `overflow: hidden` then turns that short box into a CLIP RECT, and the pin
 * has just lifted it off screen. Measured at 375x812 with the font menu open
 * 1731px down: body's clip rect ran -1731..-919 against a 0..812 viewport, so
 * nothing whatsoever was painted, the app reappearing only once the menu
 * closed. It never bit before the pin because an in-flow body's 812px box sat
 * at document y 0 and the lock clamped the scroll to 0, so box and viewport
 * coincided. Auto is safe to hand back on close, and is always at least the
 * viewport's height, since `#app` carries `min-height: 100dvh`.
 *
 * Restoring waits out the lock, because a scroll issued under it is not
 * delayed, it is lost. Removing the pin and restoring the offset happen in
 * one synchronous block so no frame is ever painted between them.
 */
export function pinScrollThroughLock(): () => void {
  // Already locked means a sheet owns the page and the offset is already
  // clamped: there is no true position to capture and nothing to put back.
  // A select inside a sheet takes this path.
  if (isScrollLocked()) return () => {}

  const y = window.scrollY
  const s = document.body.style
  const prev = {
    position: s.position,
    top: s.top,
    left: s.left,
    right: s.right,
    height: s.height,
  }
  s.position = 'fixed'
  s.top = `-${y}px`
  s.left = '0'
  s.right = '0'
  s.height = 'auto'

  let released = false
  return () => {
    if (released) return
    released = true
    const restore = () => {
      s.position = prev.position
      s.top = prev.top
      s.left = prev.left
      s.right = prev.right
      s.height = prev.height
      window.scrollTo(0, y)
    }
    if (isScrollLocked()) afterScrollUnlock(restore)
    else restore()
  }
}
