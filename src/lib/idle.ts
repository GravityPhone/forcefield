/**
 * Run something when the main thread is free.
 *
 * This lived in addressCache.ts, which is where its first two callers were, and
 * moved out the moment a third one appeared somewhere else: addressCache pulls
 * in knockQueue and therefore Dexie, so importing it for a five-line scheduling
 * helper drags 32 kB gzipped of IndexedDB wrapper onto a page that has no
 * business touching storage. AdminAnalyticsView was that third caller.
 * addressCache re-exports this so nothing that already imported it from there
 * had to change.
 *
 * requestIdleCallback is missing on older Safari, where the timeout is the
 * whole mechanism rather than a backstop.
 */
export function whenIdle(fn: () => void, timeout = 2000): void {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout })
  else setTimeout(fn, Math.min(timeout, 1200))
}
