/**
 * Take today's turf with you (2026-07-26).
 *
 * Knocks have queued offline since the first week (lib/knockQueue.ts), but
 * everything you need in order to knock — the door, who lives there, what
 * happened last time — was still a live query. So in a dead zone the WRITE
 * path worked perfectly and the door opened blank, which is the half of
 * offline that actually loses conversations.
 *
 * This caches the crew's assignment before you walk out: the doors, their
 * rosters, and each door's recent history. Read-through only — nothing here
 * ever writes to the server, and `submitKnock` remains the single write path.
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

export interface CacheState {
  cachedAt: string | null
  doors: number
}

/** How many visits back each door keeps, and when the cache was filled. */
export async function cacheState(): Promise<CacheState> {
  try {
    const meta = await db.cacheMeta.get(META_KEY)
    return { cachedAt: meta?.cachedAt ?? null, doors: meta?.doors ?? 0 }
  } catch {
    return { cachedAt: null, doors: 0 }
  }
}

/**
 * Download the crew's turf for offline use. Returns how many doors landed, or
 * null if it couldn't (no turf today, or no signal to fetch with).
 *
 * Scoped to `mine` — the CREW's whole assignment, the same set "My turf" means
 * everywhere else — not the narrower `own`. You walk your crew's ground and
 * pick up a neighbour's stretch all the time; caching only your own slice
 * would blank exactly those doors.
 */
export async function cacheTodaysTurf(userId: string): Promise<number | null> {
  try {
    const turf = await fetchMyTurf(userId)
    const turfIds = [...turf.mine]
    if (!turfIds.length) return null

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
          db.cacheMeta.clear(),
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
