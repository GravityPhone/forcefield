// Leaving a page and coming back to it exactly as you left it (2026-07-27,
// user call: "when I leave the scout page or really when I leave any page at
// all, I wanna come back to it and have it looking exactly the same so that I
// can pick up my work where it was rather than start it fresh… I find it
// annoying when I'm having to zoom into the map again or select something
// again").
//
// THE TRICK IS `<keep-alive>` AND ITS `max`, AND IT IS THE WHOLE MECHANISM.
// Vue does not destroy a cached component: its refs, its DOM, its Google Map,
// its open panels and its scroll containers all stay exactly as they were, and
// coming back is a re-insert rather than a fresh mount. So there is deliberately
// no per-screen "save these five toggles" code anywhere in the app — every ref
// in every view is preserved by construction, which is the only version of this
// that can't rot as screens grow new controls.
//
// `max` is the answer to the other half of the ask ("we don't have to keep them
// all in memory because we still wanna keep things performing well"): KeepAlive
// runs a least-recently-used cache, so the page you haven't touched in five
// screens is the one that gets thrown away, and it is thrown away properly —
// unmounted, with every onUnmounted hook run.
//
// Two things keep-alive does NOT do, which is what the rest of this module is:
// it doesn't restore the window's scroll offset (the DOM comes back scrolled,
// the window doesn't), and it doesn't stop a hidden page from acting like it's
// still on screen. See the two composables at the bottom for the second one.

import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { isScrollLocked } from './appChrome'

/**
 * How many pages hold their instance at once.
 *
 * The heavy four are /canvass (Scout's map plus ~10k doors), /squad (a map and
 * the crew's doors), /turf (a map and the whole 22.7k-row county index) and
 * /admin/analytics (~11k knocks plus every address id). A canvasser only ever
 * touches the first two; a campaign manager can have all four cached at this
 * size, which is the deliberate ceiling.
 *
 * Five rather than three because the flows that prompted this are short round
 * trips — squad to analytics and back, canvass to squad and back — and the
 * point is that the page you bounced off is still there. LRU means /canvass
 * survives on its own merits for a canvasser: it's the most-visited screen in
 * the app, so it is never the least-recently-used one.
 *
 * Turn this down before reaching for anything cleverer if memory ever bites.
 */
export const KEPT_PAGES = 5

/**
 * Views that must NOT be cached, by component name.
 *
 * The sign-in screens: caching a login form means a typed username survives a
 * log out, and the campaign chooser is a gate you pass through once. None of
 * them has state worth coming back to.
 *
 * Each of these views carries an explicit `export default { name }` block so
 * this list matches something real rather than a name inferred from a filename.
 */
export const NEVER_KEPT = ['LandingView', 'LoginView', 'SignUpView', 'ChooseCampaignView']

// --- Where the page was scrolled to ---
//
// Keyed by route PATH, not fullPath: `/squad?squad=x` and `/squad` are one
// cached SquadView, so they're one scroll position too. Paths also give
// /member/:id the behaviour you'd want for free — a different member is a
// different key, so it opens at the top instead of inheriting the last one's
// offset.

/** Enough for a long session's worth of routes; /member/:id is the only path
 *  family that grows without bound. */
const MAX_REMEMBERED = 40

const scrollTops = new Map<string, number>()

export function rememberScroll(key: string, top: number): void {
  // Re-inserting moves the key to the end, so insertion order IS the LRU order
  // and the oldest entry is always the first one out.
  scrollTops.delete(key)
  scrollTops.set(key, top)
  if (scrollTops.size > MAX_REMEMBERED) {
    const oldest = scrollTops.keys().next().value
    if (oldest !== undefined) scrollTops.delete(oldest)
  }
}

export function recallScroll(key: string): number | undefined {
  return scrollTops.get(key)
}

/** Signing out is the one moment that plainly means "this isn't my phone any
 *  more" — same reasoning as the offline door cache. */
export function forgetPageState(): void {
  scrollTops.clear()
}

/**
 * Record where the page is, ready for the next visit. Called as a navigation
 * starts, while the offset still belongs to the page being left.
 *
 * Skipped while a modal has the page scroll-locked: Reka's `overflow: hidden`
 * collapses the document and clamps the offset to 0 (measured at length in
 * appChrome.ts), so a link tapped from inside a bottom sheet would otherwise
 * record 0 and throw away a real position. Leaving the previous value in place
 * is strictly better than replacing it with a lie.
 */
export function captureScroll(key: string): void {
  if (isScrollLocked()) return
  rememberScroll(key, window.scrollY)
}

/** How long a restore waits for a still-loading page to grow tall enough. */
const SCROLL_SETTLE_MS = 500
const SCROLL_POLL_MS = 32
/** Anything from a real hand ends the wait — never yank a page someone has
 *  already started reading. Same list as appChrome's keepInSafeView. */
const HAND_BACK_EVENTS = ['touchstart', 'wheel', 'keydown'] as const

function scrollRoom(): number {
  const el = document.scrollingElement ?? document.documentElement
  return Math.max(0, el.scrollHeight - window.innerHeight)
}

/**
 * Wait, briefly, until the document is tall enough for `top` to be reachable.
 *
 * A cached page needs none of this — its DOM comes back whole, so the room is
 * already there and this returns on the spot. It's for the page that got
 * evicted: that one remounts empty and fills in when its fetch lands, and a
 * scroll issued against a 0px document silently clamps to the top. Bounded
 * hard, because a page that never grows that tall (rows got deleted, a filter
 * is narrower) must not leave the restore hanging.
 */
export function waitForScrollRoom(top: number): Promise<void> {
  if (top <= 0 || scrollRoom() >= top) return Promise.resolve()
  return new Promise((resolve) => {
    const deadline = performance.now() + SCROLL_SETTLE_MS
    let done = false
    const finish = () => {
      if (done) return
      done = true
      for (const ev of HAND_BACK_EVENTS) window.removeEventListener(ev, finish)
      resolve()
    }
    for (const ev of HAND_BACK_EVENTS) window.addEventListener(ev, finish, { passive: true })
    const tick = () => {
      if (done) return
      if (scrollRoom() >= top || performance.now() > deadline) return finish()
      setTimeout(tick, SCROLL_POLL_MS)
    }
    setTimeout(tick, SCROLL_POLL_MS)
  })
}

// --- The two hooks every cached view needs ---
//
// A cached page is hidden, not gone: `onUnmounted` does not run when you
// navigate away from it, only when it is finally evicted. Anything a view does
// to the world OUTSIDE itself — a realtime channel, a timer, a window listener,
// a store field other screens read — therefore has to hang off activate and
// deactivate instead, or a page you left keeps running while you're five
// screens away.
//
// Both of these work whether or not the view is actually inside a KeepAlive:
// onActivated/onDeactivated simply never fire for an excluded view, and the
// onMounted/onUnmounted half covers it. So a view can use them without knowing
// or caring which side of the `exclude` list it's on.

/**
 * Run `load` every time the page comes on screen: once on first mount, and
 * again on each return from the cache.
 *
 * This is the freshness half of caching a page. Coming back to a stale
 * leaderboard is a regression the user didn't ask for, so live screens re-read
 * on arrival — but the re-read replaces DATA only, and every scroll position,
 * open panel and filter chip around it survives, which is the whole point.
 *
 * `minIntervalMs` is for the reads that genuinely cost something: a page that
 * charges 30 seconds of network to open shouldn't charge it again because
 * somebody bounced off it and back.
 */
export function onPageEnter(load: () => unknown, minIntervalMs = 0): void {
  let lastRun = 0
  let freshlyMounted = false
  const run = () => {
    const now = Date.now()
    if (lastRun && now - lastRun < minIntervalMs) return
    lastRun = now
    void load()
  }
  onMounted(() => {
    freshlyMounted = true
    run()
  })
  onActivated(() => {
    // Vue fires onActivated immediately after onMounted the first time
    // through. Without this guard every first visit would load twice.
    if (freshlyMounted) {
      freshlyMounted = false
      return
    }
    run()
  })
}

/**
 * Keep something running only while the page is actually on screen.
 *
 * `start` and `stop` are called in strict alternation however the page comes
 * and goes — first mount, hide, show, and the eventual eviction (which fires
 * deactivate and then unmount, so the flag is what stops `stop` running twice).
 */
export function whileOnPage(start: () => void, stop: () => void): void {
  let running = false
  const begin = () => {
    if (running) return
    running = true
    start()
  }
  const end = () => {
    if (!running) return
    running = false
    stop()
  }
  onMounted(begin)
  onActivated(begin)
  onDeactivated(end)
  onUnmounted(end)
}
