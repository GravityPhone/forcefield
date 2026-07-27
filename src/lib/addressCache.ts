/**
 * The county street table, kept on the device (2026-07-27).
 *
 * The turf cutter is built on an in-memory index of every address in the
 * county: street sweeps, door counts, the search box and every claim check run
 * out of it, which is what makes cutting feel instant once the page is up.
 * Getting it there was the problem. 22,746 rows is 23 pages past PostgREST's
 * 1000-row cap, and the cutter paid all 23 round trips on every single visit,
 * while the Maps SDK was initialising alongside them. The page worked; it just
 * took far too long to arrive.
 *
 * So the rows are stored here after the first load, and the next visit indexes
 * from IndexedDB instead of the network.
 *
 * THE CACHE IS A HEAD START, NEVER AN AUTHORITY, and the way that rule is kept
 * is worth stating plainly: the caller paints from the cache and then refetches
 * the whole table anyway, every time, in the background. Nothing is served
 * stale for longer than one network read, which is exactly as long as the page
 * used to show nothing at all. That is also why there's no maximum age here: a
 * copy is either replaced within seconds, or the device has no signal, in which
 * case an old street index beats a blank map (the same call offlineCache.ts
 * makes about door history).
 *
 * `turf_id` is the field that actually moves — it's rewritten server-side every
 * time anyone saves a turf, and turf colour is the whole point of that page —
 * so the refetch is unconditional and `reloadAll` refreshes the copy after
 * every save.
 *
 * It rides in the SAME Dexie database as the knock queue, whose schema lives in
 * knockQueue.ts: two Dexie instances opening one database at different versions
 * fight over the upgrade and one ends up blocked.
 */

import { db } from './knockQueue'

const META_KEY = 'addresses'

/** Bump when the SHAPE of a cached row changes: a column added to (or dropped
 *  from) the cutter's address select. An older copy is then thrown away rather
 *  than served with a field missing that nothing downstream checks for. */
const SHAPE = 1

/** Rows per stored record. The set is only ever read and written whole, so the
 *  only thing chunking buys is bounding each individual structured clone;
 *  ~6 records for the current county table is the right side of both trades. */
const CHUNK = 4000

/** A wedged IndexedDB must not hold the page hostage. This read sits directly
 *  in front of the map, so it degrades to the network path rather than hanging
 *  on a database that never answers. */
const READ_TIMEOUT_MS = 2500

/**
 * The stored copy of the address table, or null when there isn't a complete
 * one. Never throws: no cache and a broken cache are the same answer, and the
 * caller's fallback for both is the network.
 *
 * The caller owns the row shape; SHAPE above is the contract between the two.
 */
export async function readCachedAddresses<T>(): Promise<T[] | null> {
  try {
    return await Promise.race([
      read<T>(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS)),
    ])
  } catch {
    return null
  }
}

async function read<T>(): Promise<T[] | null> {
  const meta = await db.cacheMeta.get(META_KEY)
  if (!meta || meta.shape !== SHAPE) return null
  const chunks = await db.cachedAddresses.toArray()
  if (!chunks.length) return null
  chunks.sort((a, b) => a.seq - b.seq)
  const rows = chunks.flatMap((c) => c.rows) as T[]
  // Belt and braces against a torn copy: the meta is written last and inside
  // the same transaction as the chunks, so a count that disagrees with it means
  // something went wrong that Dexie didn't report. Refetch rather than index a
  // street table with holes in it.
  if (rows.length !== meta.doors) return null
  return rows
}

/**
 * Replace the stored copy. Fire and forget: a failed write costs the next visit
 * its head start and nothing else.
 *
 * Wholesale, in one transaction, meta last. Clearing first matters because a
 * smaller table would otherwise leave trailing chunks from the old one behind,
 * and those would read back as real rows.
 */
export async function writeCachedAddresses(rows: unknown[]): Promise<void> {
  if (!rows.length) return
  try {
    const chunks: { seq: number; rows: unknown[] }[] = []
    for (let i = 0; i < rows.length; i += CHUNK) {
      chunks.push({ seq: chunks.length, rows: rows.slice(i, i + CHUNK) })
    }
    await db.transaction('rw', db.cachedAddresses, db.cacheMeta, async () => {
      await db.cachedAddresses.clear()
      await db.cachedAddresses.bulkPut(chunks)
      await db.cacheMeta.put({
        key: META_KEY,
        cachedAt: new Date().toISOString(),
        doors: rows.length,
        shape: SHAPE,
      })
    })
  } catch {
    // Storage full, private mode, IndexedDB unavailable — the page already has
    // its data, this only ever bought the NEXT load.
  }
}

/** Signing out is the one moment that plainly means "this isn't my phone any
 *  more" — same reasoning as the turf cache, which is cleared alongside it. */
export async function clearAddressCache(): Promise<void> {
  try {
    await db.transaction('rw', db.cachedAddresses, db.cacheMeta, async () => {
      await db.cachedAddresses.clear()
      await db.cacheMeta.delete(META_KEY)
    })
  } catch {
    // Nothing stored to clear either.
  }
}

/** Run when the main thread is free, with a hard backstop. Used for both the
 *  background refetch and the write, so neither competes with the map the user
 *  is already looking at. requestIdleCallback is missing on older Safari, where
 *  the timeout is the whole mechanism rather than a backstop. */
export function whenIdle(fn: () => void, timeout = 2000): void {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout })
  else setTimeout(fn, Math.min(timeout, 1200))
}
