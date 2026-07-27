/**
 * The crew's turf, always on the phone (2026-07-26).
 *
 * Knocks have queued offline since the first week (lib/knockQueue.ts), but
 * everything you need in order to knock — the door, who lives there, what
 * happened last time — was still a live query. So in a dead zone the WRITE
 * path worked perfectly and the door opened blank, which is the half of
 * offline that actually loses conversations.
 *
 * This caches the crew's assignment: the doors, their rosters, and each door's
 * recent history. Read-through only — nothing here ever writes to the server,
 * and `submitKnock` remains the single write path.
 *
 * IT IS AUTOMATIC, AND THAT WAS A DELIBERATE CORRECTION. It shipped as a "Save
 * today's turf for offline" button at the bottom of /squad and lasted a day
 * (user call: "I just want regular offline/online syncing so the door is always
 * saved on the client side for whatever turf we're currently in"). The reasoning
 * is the button's own failure mode: it had to be pressed BEFORE losing signal,
 * which is the one moment nobody is thinking about it — and a canvasser who
 * forgets gets exactly the blank door this module exists to prevent. So
 * `syncTurfCache` is kicked from AppShell instead, on load and on every resume,
 * and there is no UI at all. Don't add one back.
 *
 * APPOINTMENTS ARE DELIBERATELY NOT CACHED OR QUEUED. That's a standing
 * decision from the appointments work: a knock can be replayed silently, but
 * a promise to come back is worth saying out loud when it fails. Don't fold
 * them in here.
 *
 * The cache is a CONVENIENCE, never an authority: every reader is a fallback
 * behind the live query, so a door with signal always shows the truth. Stale
 * cached history is better than an empty screen, and worse than the network —
 * which is exactly the order the callers try them in.
 */

import { db } from './knockQueue'
import { fetchAllRows, supabase } from './supabase'
import { fetchMyTurf } from './myTurf'
import type { Address, Person } from '@/types'

const META_KEY = 'turf'
/** Per door — enough to see the last few visits without hauling the whole
 *  history of a street that's been worked for a month. */
const HISTORY_PER_DOOR = 8
/** A cache of the same turf this recent is left alone. Doors and rosters barely
 *  move; the only thing that ages is the visit history, and that's the least
 *  load-bearing part of what's stored. Long enough that opening the app five
 *  times in a morning costs one refill, short enough that turf handed over at
 *  9am is on the phone before the crew reaches it. */
const REFRESH_AFTER_MS = 15 * 60 * 1000

/** One fill at a time, however many screens ask. */
let inFlight: Promise<number | null> | null = null

/**
 * Make sure the crew's turf is on the device, refilling only when it's stale or
 * the assignment has changed. Safe and cheap to call on every app load and
 * resume — that's the intended use, and repeat calls share one fill.
 *
 * Returns the number of cached doors, or null when there's nothing to do (no
 * turf today, or no signal to fetch with). Never throws.
 */
export function syncTurfCache(userId: string): Promise<number | null> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      // Cheap first: which turf, and is what we hold still it?
      const turf = await fetchMyTurf(userId)
      const turfIds = [...turf.mine].sort()
      // No turf today leaves the cache ALONE rather than clearing it. Every
      // read is a per-door fallback behind the network, so a door still sitting
      // there can only help someone who's lost signal; wiping it the moment a
      // squad dissolves would take the ground away mid-shift.
      if (!turfIds.length) return null
      const meta = await db.cacheMeta.get(META_KEY).catch(() => undefined)
      const sameTurf =
        !!meta?.turfIds &&
        meta.turfIds.length === turfIds.length &&
        meta.turfIds.every((id, i) => id === turfIds[i])
      const fresh = !!meta && Date.now() - Date.parse(meta.cachedAt) < REFRESH_AFTER_MS
      if (sameTurf && fresh) return meta.doors
      return await fillTurfCache(turfIds)
    } catch {
      return null
    }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Download a turf set for offline use. Returns how many doors landed.
 *
 * The set is `mine` — the CREW's whole assignment, the same set "My turf" means
 * everywhere else — not the narrower `own`. You walk your crew's ground and
 * pick up a neighbour's stretch all the time; caching only your own slice
 * would blank exactly those doors.
 */
async function fillTurfCache(turfIds: string[]): Promise<number | null> {
  try {
    // Whole-set reads, so they page — PostgREST silently caps at 1000 rows and
    // a crew's turf is routinely several hundred doors.
    const doors = await fetchAllRows<Address>((from, to) =>
      supabase.from('addresses').select('*').in('turf_id', turfIds).order('id').range(from, to),
    )
    if (!doors.length) return 0
    const doorIds = doors.map((d) => d.id)

    const [persons, visits] = await Promise.all([
      chunked(doorIds, (ids) =>
        fetchAllRows<Person>((from, to) =>
          supabase
            .from('persons')
            .select('*')
            .in('household_id', ids)
            .order('id')
            .range(from, to),
        ),
      ),
      chunked(doorIds, (ids) =>
        fetchAllRows<VisitRow>((from, to) =>
          supabase
            .from('knock_logs')
            .select(
              'id, household_id, person_id, canvasser_id, occurred_at, outcome, notes, ' +
                'person:persons(name), canvasser:profiles(username, display_name)',
            )
            .in('household_id', ids)
            .order('occurred_at', { ascending: false })
            .order('id')
            .range(from, to) as unknown as PromiseLike<{
            data: VisitRow[] | null
            error: { message: string } | null
          }>,
        ),
      ),
    ])

    // Trim per door client-side: asking Postgres for "the latest 8 per
    // household" across hundreds of households is a lateral join and a view we
    // don't have, and this set is already in memory.
    const perDoor = new Map<string, VisitRow[]>()
    for (const v of visits) {
      if (!v.household_id) continue
      const list = perDoor.get(v.household_id) ?? []
      if (list.length < HISTORY_PER_DOOR) {
        list.push(v)
        perDoor.set(v.household_id, list)
      }
    }
    const keptVisits = [...perDoor.values()].flat()

    await db.transaction(
      'rw',
      db.cachedDoors,
      db.cachedPersons,
      db.cachedVisits,
      db.cacheMeta,
      async () => {
        // Replace wholesale — yesterday's turf isn't yours today, and a merge
        // would quietly keep serving doors the crew handed back.
        await Promise.all([db.cachedDoors.clear(), db.cachedPersons.clear(), db.cachedVisits.clear()])
        await db.cachedDoors.bulkPut(doors.map((d) => ({ id: d.id, row: d })))
        await db.cachedPersons.bulkPut(
          persons
            .filter((p) => p.household_id)
            .map((p) => ({ id: p.id, household_id: p.household_id as string, row: p })),
        )
        await db.cachedVisits.bulkPut(
          keptVisits.map((v) => ({ id: v.id, household_id: v.household_id as string, row: v })),
        )
        await db.cacheMeta.put({
          key: META_KEY,
          cachedAt: new Date().toISOString(),
          doors: doors.length,
          // What this copy is OF — so the next sync can tell "same turf, still
          // fresh" from "the crew's ground changed under us".
          turfIds,
        })
      },
    )
    return doors.length
  } catch {
    return null
  }
}

export async function clearTurfCache(): Promise<void> {
  try {
    await db.transaction(
      'rw',
      db.cachedDoors,
      db.cachedPersons,
      db.cachedVisits,
      db.cacheMeta,
      async () => {
        await Promise.all([
          db.cachedDoors.clear(),
          db.cachedPersons.clear(),
          db.cachedVisits.clear(),
          // This key, not the whole store: cacheMeta is shared with the
          // cutter's address cache (lib/addressCache.ts), which clears its own
          // on the same sign-out. A .clear() here would strand that copy's
          // chunks with no meta describing them.
          db.cacheMeta.delete(META_KEY),
        ])
      },
    )
  } catch {
    // IndexedDB unavailable — nothing cached to clear either.
  }
}

interface VisitRow {
  id: string
  household_id: string | null
  [key: string]: unknown
}

/** Everything one door needs, or null when it isn't cached. Callers use this
 *  ONLY after the live query has failed. */
export async function cachedDoor(
  addressId: string,
): Promise<{ address: Address; roster: Person[]; history: unknown[] } | null> {
  try {
    const door = await db.cachedDoors.get(addressId)
    if (!door) return null
    const [people, visits] = await Promise.all([
      db.cachedPersons.where('household_id').equals(addressId).toArray(),
      db.cachedVisits.where('household_id').equals(addressId).toArray(),
    ])
    const roster = people.map((p) => p.row as Person)
    roster.sort((a, b) => a.name.localeCompare(b.name))
    const history = visits.map((v) => v.row as { occurred_at: string })
    history.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    return { address: door.row as Address, roster, history }
  } catch {
    return null
  }
}

/** Run an `.in()` query in batches — Postgres takes a long IN list, but a URL
 *  has a length limit and PostgREST puts the whole filter in the query string. */
async function chunked<T>(ids: string[], run: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  const SIZE = 200
  const out: T[] = []
  for (let i = 0; i < ids.length; i += SIZE) {
    out.push(...(await run(ids.slice(i, i + SIZE))))
  }
  return out
}
