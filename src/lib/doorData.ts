/**
 * How the three maps read the addresses table (2026-07-27).
 *
 * Scout, Squad and the turf cutter have shared ONE canvas renderer since the
 * 2026-07-24 unification (doorCanvas.ts, next door), but each still had its own
 * copy of the paging, the geocoded/ungeocoded split and the streaming callback.
 * Three copies of a load order that took several attempts to get right is three
 * places for it to quietly drift. This module owns it once.
 *
 * THE LOAD ORDER IS THE POINT, and it is not obvious, so: rows WITH coordinates
 * come first, then the rest. A door with no lat/lng cannot be painted, so it
 * must not sit in the queue in front of one that can — pulling the located rows
 * first puts every pin the map can draw on screen after about 14 pages instead
 * of all 23. The ungeocoded remainder still matters (it completes the street
 * index, and those are exactly the streets somebody looks up by name), it just
 * matters second. Scout has worked this way for a while and was measurably the
 * faster page for it, despite selecting heavier rows than the cutter.
 *
 * Known cost of the split, measured: 32 requests where one undivided read would
 * be 24, because fetchAllRows always issues a full batch of concurrent pages
 * and two reads have two ragged final batches instead of one. Worth it while
 * the cold path is a once-per-device event (see addressCache.ts). If that ever
 * stops being true, dropping the `located` option restores the single read.
 *
 * WHAT IS DELIBERATELY NOT SHARED: whether a caller CACHES its rows. Squad's
 * crew-scoped read is a few hundred rows behind an `.in('turf_id', …)` whose
 * key would churn every morning, and its org-wide read is background and
 * unawaited — neither is worth a third copy of the county on a phone. They
 * share the paging and nothing else, which is the honest amount.
 */

import { supabase, fetchAllRows } from './supabase'

/** A lat/lng box, as a map's bounds give it. */
export interface DoorBox {
  south: number
  north: number
  west: number
  east: number
}

export interface DoorQuery {
  /** The caller's own column list. Kept per-map on purpose — Scout needs the
   *  roster count, the cutter needs `unit`/`zip` for the geocoder, Squad needs
   *  neither — and it pairs with that map's cache shape stamp. */
  select: string
  /** true = only rows that can be drawn, false = only the ones that can't,
   *  undefined = the whole table in one pass. */
  located?: boolean
  /** Restrict to these turfs (Squad's crew-scoped read). An empty array is a
   *  caller bug rather than "no filter", so it returns nothing. */
  turfIds?: string[]
  /** Restrict to a map viewport. */
  box?: DoorBox
  /** One street's doors: `street` is "123 GROVE ST", so a street is everything
   *  ending in its name. Deliberately a superset — "MAIN ST" also matches
   *  "N MAIN ST" — because the caller re-filters with the client's own
   *  streetNameOf, which stays the single authority on what a street is. */
  streetEndsWith?: string
}

/** LIKE treats these as wildcards, and a street name is data, not a pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Above this many doors in one viewport the box read is truncated by
 *  PostgREST's row cap. That's fine — it's a head start, never the set of
 *  record — but it's ordered so the truncation is at least deterministic. */
const BOX_LIMIT = 1000

function build(q: DoorQuery) {
  let query = supabase.from('addresses').select(q.select)
  if (q.located === true) query = query.not('lat', 'is', null)
  if (q.located === false) query = query.is('lat', null)
  if (q.turfIds) query = query.in('turf_id', q.turfIds)
  if (q.streetEndsWith) query = query.ilike('street', `%${escapeLike(q.streetEndsWith)}`)
  if (q.box) {
    query = query
      .gte('lat', q.box.south)
      .lte('lat', q.box.north)
      .gte('lng', q.box.west)
      .lte('lng', q.box.east)
  }
  // A stable order is not optional: fetchAllRows pages with .range(), and
  // without it rows repeat or vanish across page boundaries.
  return query.order('id')
}

/**
 * A whole set of doors, paged past PostgREST's 1000-row cap.
 *
 * `onPage` fires per page as it lands, so a caller can index and paint what it
 * has instead of holding everything back until the last one — the county table
 * is several seconds of paging even on a good connection.
 */
export function fetchDoors<T>(
  q: DoorQuery,
  onPage?: (rows: T[]) => void,
  concurrency = 8,
): Promise<T[]> {
  if (q.turfIds && !q.turfIds.length) return Promise.resolve([])
  return fetchAllRows<T>(
    (from, to) => build(q).range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    1000,
    concurrency,
    onPage,
  )
}

/**
 * The whole table in load order: drawable rows first, then the rest, streaming
 * each page. Resolves with everything, so the caller can hand the complete set
 * to its cache.
 *
 * `onPage` is told which stage a page belongs to, because the two mean
 * different things to a map: the first paints pins, the second only completes
 * the street index.
 */
export async function fetchDoorsStaged<T>(
  q: Omit<DoorQuery, 'located'>,
  onPage: (rows: T[], stage: 'located' | 'unlocated') => void,
): Promise<{ located: T[]; unlocated: T[] }> {
  const located = await fetchDoors<T>({ ...q, located: true }, (rows) => onPage(rows, 'located'))
  const unlocated = await fetchDoors<T>({ ...q, located: false }, (rows) =>
    onPage(rows, 'unlocated'),
  )
  return { located, unlocated }
}

/**
 * The doors inside a map viewport, in ONE request.
 *
 * This exists so a cold load can paint the neighbourhood somebody is actually
 * looking at before the county arrives: the paged read comes back ordered by
 * id, which is scattered geographically, so the few hundred doors on screen
 * would otherwise dribble in across every page of it.
 *
 * There is no index on addresses.lat/lng and it doesn't need one — at 22.7k
 * rows the scan is a few milliseconds server-side, and the win here is
 * transferring hundreds of rows instead of tens of thousands, not query time.
 */
export async function fetchDoorsInBox<T>(q: DoorQuery & { box: DoorBox }): Promise<T[]> {
  const { data, error } = await build(q).limit(BOX_LIMIT)
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

/** One row per street, straight from the database. */
export interface StreetSummary {
  street_name: string
  city: string
  count: number
  lo: number
  hi: number
}

/**
 * The street search list, without downloading a single door.
 *
 * DISPLAY ONLY — see the header of migration 20260727120000. The view
 * re-implements the client's street-name parsing in SQL, so it may seed the
 * search box and nothing else: door claiming, segments and turf membership all
 * keep going through the client parsing and the set_turf_segments RPC, which
 * means any drift between the two shows up as a cosmetic search row rather
 * than a wrong turf cut. Equivalence is verified over the whole table by
 * scripts/verify-street-summary.mjs.
 *
 * About 1,244 streets today, so it pages: two requests instead of twenty-three.
 */
export function fetchStreetSummaries(): Promise<StreetSummary[]> {
  return fetchAllRows<StreetSummary>((from, to) =>
    supabase
      .from('street_summary')
      .select('street_name, city, door_count, lo, hi')
      .order('street_name')
      .order('city')
      .range(from, to)
      .then(({ data, error }) => ({
        // door_count is the view's name for it; `count` is what every consumer
        // of a summary in this app already calls it.
        data: (data ?? []).map((r) => ({
          street_name: r.street_name as string,
          city: r.city as string,
          count: r.door_count as number,
          lo: r.lo as number,
          hi: r.hi as number,
        })),
        error,
      })),
  )
}
