import { supabase } from '@/lib/supabase'
import { localToday } from '@/lib/day'

/** The turf columns every map and the walk filter actually read. */
export interface TurfLite {
  id: string
  name: string
  color: string
  squad_id: string | null
  assignee_id: string | null
  parent_turf_id: string | null
}

export interface MyTurf {
  /** Every turf in the campaign — the maps ring foreign doors with these. */
  all: TurfLite[]
  /** Turf that's mine TODAY: my CREW's whole assignment — dispatched to a
   * squad I'm on, or handed to one of us by name — sub-turfs included, whoever
   * they were cut for. This is what "My turf" means everywhere in the app. */
  mine: Set<string>
  /** The narrower slice: turf carrying MY name (what I claimed or was handed
   * on the squad page), as opposed to my crew's shared ground. */
  own: Set<string>
  /** The squads I'm on today — callers use it for squadmate lookups. */
  squadIds: Set<string>
  /** Everyone on those squads, me included. */
  squadmateIds: Set<string>
}

/** Which turf is mine right now.
 *
 * "Mine" is the CREW's ground, not my personal share (2026-07-25, user call:
 * "my turf should be all of the turf that is assigned to our squad that you're
 * in… my doors get more granular"). The rule is SquadView's "Our turf",
 * deliberately verbatim so the two screens can never disagree about a street:
 * top-level turf dispatched to a squad I'm on today OR handed to one of us by
 * name, PLUS every sub-turf carved out of those — whoever the leader cut them
 * for. That last clause is the fix: splitting the crew's turf re-stamps its
 * doors onto per-member sub-turfs, so counting only MY sub-turf made a
 * squadmate's stretch vanish from Scout while the squad map still showed it.
 *
 * Turf left pointing at a past day's squad is nobody's until a campaign
 * manager re-dispatches it; a sub-turf with my name on it is the one thing
 * that survives its parent going to another crew — it's still my slice.
 *
 * Shared by Scout's map filter and Talk's walk filter so both answer "is this
 * door mine" the same way. */
export async function fetchMyTurf(userId: string): Promise<MyTurf> {
  const today = localToday()
  const [mineRes, crewRes, turfRes] = await Promise.all([
    supabase
      .from('squad_members')
      .select('squad_id, squads!inner(squad_date)')
      .eq('user_id', userId)
      .eq('squads.squad_date', today),
    // Everyone out today, filtered to my squads below. One query rather than a
    // second round trip that waits on the first — today's rosters are dozens
    // of rows, nowhere near the 1000-row response cap.
    supabase
      .from('squad_members')
      .select('squad_id, user_id, squads!inner(squad_date)')
      .eq('squads.squad_date', today),
    supabase.from('turfs').select('id, name, color, squad_id, assignee_id, parent_turf_id'),
  ])
  const squadIds = new Set((mineRes.data ?? []).map((r) => r.squad_id as string))
  const squadmateIds = new Set<string>([userId])
  for (const r of crewRes.data ?? []) {
    if (squadIds.has(r.squad_id as string)) squadmateIds.add(r.user_id as string)
  }

  const all = (turfRes.data ?? []) as TurfLite[]
  const byId = new Map(all.map((t) => [t.id, t]))
  // The crew's own ground, top level only — sub-turfs ride in via their parent.
  const directIds = new Set(
    all
      .filter(
        (t) =>
          t.parent_turf_id == null &&
          ((t.squad_id != null && squadIds.has(t.squad_id)) ||
            (t.assignee_id != null && squadmateIds.has(t.assignee_id))),
      )
      .map((t) => t.id),
  )
  const mine = new Set(directIds)
  for (const t of all) {
    if (t.parent_turf_id == null || mine.has(t.id)) continue
    // Any slice of the crew's turf, plus my own slice of somebody else's —
    // the latter only while its parent isn't parked on a past day's squad.
    if (directIds.has(t.parent_turf_id)) mine.add(t.id)
    else if (t.assignee_id === userId) {
      const parent = byId.get(t.parent_turf_id)
      if (parent && (parent.squad_id == null || squadIds.has(parent.squad_id))) mine.add(t.id)
    }
  }
  const own = new Set(
    all.filter((t) => t.assignee_id === userId && mine.has(t.id)).map((t) => t.id),
  )
  return { all, mine, own, squadIds, squadmateIds }
}
