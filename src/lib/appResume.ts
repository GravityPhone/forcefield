/**
 * "The app just came back" — one place for the refreshes that a long-lived
 * page can't get any other way (2026-07-25, user call: "sometimes I load up
 * the app and I have to refresh").
 *
 * Two things make a screen go stale without anything visibly breaking:
 *
 *  1. The phone sleeps or the browser backgrounds the tab. Timers stop, the
 *     realtime websocket is torn down, and whatever was on screen when the
 *     screen went dark is still on screen when it comes back — an hour later,
 *     with an hour of missing knocks.
 *  2. Signal drops and comes back. Requests made in the gap failed silently
 *     (a caught fetch that kept the old colors rather than blanking them), so
 *     nothing retries on its own.
 *
 * `onAppResume` fires once per resume, not once per event: visibilitychange,
 * window focus and `online` all funnel through the same guard, and a resume
 * only counts after the page has actually been away for `minAwayMs` — so
 * tapping between apps for two seconds doesn't kick off a county-sized
 * refetch.
 */

export interface AppResumeOptions {
  /** How long the page must have been hidden/offline before a return counts
   * as a resume. Short trips away aren't worth a refetch. */
  minAwayMs?: number
}

/**
 * Run `cb` when the app comes back to life. Returns a dispose function —
 * call it from onUnmounted (and note that a kept-alive component's
 * onUnmounted may never run, which is exactly why this exists).
 */
export function onAppResume(cb: () => void, options: AppResumeOptions = {}): () => void {
  const minAway = options.minAwayMs ?? 20_000
  // Treat mount time as the last time we were awake, so a resume needs a real
  // gap after it rather than firing immediately.
  let awaySince: number | null = null
  let lastRun = Date.now()

  function maybeResume(force = false) {
    const now = Date.now()
    const away = awaySince == null ? 0 : now - awaySince
    awaySince = null
    if (!force && away < minAway) return
    // Two events for the same resume (visibilitychange then focus) must not
    // run the work twice.
    if (now - lastRun < 1_000) return
    lastRun = now
    cb()
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      awaySince = Date.now()
      return
    }
    maybeResume()
  }

  function onFocus() {
    if (document.visibilityState === 'visible') maybeResume()
  }

  // Signal coming back is worth a refresh regardless of how long it was out:
  // whatever failed while offline failed silently.
  function onOnline() {
    maybeResume(true)
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('online', onOnline)

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('online', onOnline)
  }
}
