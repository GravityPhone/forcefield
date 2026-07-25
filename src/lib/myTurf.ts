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
  /** Turf that's mine TODAY: dispatched to me by name, or to a squad I'm on
   * today. This is what "My turf" means everywhere in the app. */
  mine: Set<string>
  /** The narrower slice: turf carrying MY name (what I claimed or was handed
   * on the squad page), as opposed to my crew's shared ground. */
  own: Set<string>
  /** The squads I'm on today — callers use it for squadmate lookups. */
  squadIds: Set<string>
}

/** Which turf is mine right now. A sub-turf of mine (my slice of a crew's
 * split) counts only while its parent is still pointed at one of my
 * today-squads — or at a person, which is durable. Turf left pointing at a
 * past day's squad is nobody's until a campaign manager re-dispatches it.
 *
 * Shared by Scout's map filter and Talk's "My doors" walk filter so both
 * answer "is this door mine" the same way. */
export async function fetchMyTurf(userId: string): Promise<MyTurf> {
  const [smRes, turfRes] = await Promise.all([
    supabase
      .from('squad_members')
      .select('squad_id, squads!inner(squad_date)')
      .eq('user_id', userId)
      .eq('squads.squad_date', localToday()),
    supabase.from('turfs').select('id, name, color, squad_id, assignee_id, parent_turf_id'),
  ])
  const squadIds = new Set((smRes.data ?? []).map((r) => r.squad_id as string))
  const all = (turfRes.data ?? []) as TurfLite[]
  const byId = new Map(all.map((t) => [t.id, t]))
  const topMine = (t: TurfLite) =>
    t.parent_turf_id == null &&
    (t.assignee_id === userId || (t.squad_id != null && squadIds.has(t.squad_id)))
  const mine = new Set(
    all
      .filter((t) => {
        if (topMine(t)) return true
        if (t.parent_turf_id == null || t.assignee_id !== userId) return false
        const parent = byId.get(t.parent_turf_id)
        return !!parent && (parent.squad_id == null || squadIds.has(parent.squad_id))
      })
      .map((t) => t.id),
  )
  const own = new Set(
    all.filter((t) => t.assignee_id === userId && mine.has(t.id)).map((t) => t.id),
  )
  return { all, mine, own, squadIds }
}
