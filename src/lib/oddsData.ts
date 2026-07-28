/**
 * Feeding the next-knock model outside the Analytics page (2026-07-27).
 *
 * src/lib/odds.ts is pure: hand it knocks and doors and it answers. The
 * Analytics tab already holds both, so it builds its own model directly. Talk,
 * Scout and the turf cutter do not, which is what this is for.
 *
 * IT IS LOADED ON A TAP, NEVER ON A DOOR OPENING. Opening a door is the
 * hottest path in the app and the one a canvasser does forty times a shift;
 * hanging a whole knock history and address table off it would be indefensible
 * even for a manager. So the odds panel on those screens starts as a button,
 * and the first tap pays for the load. Every door after that is instant,
 * because the model is a module singleton for the rest of the session.
 *
 * Same reasoning as `appointments.ts`: several unrelated consumers, none of
 * them the owner, so the shared state lives in the module rather than in
 * whichever screen happened to ask first.
 *
 * MANAGERS ONLY, and that is checked here as well as in the components. The
 * odds are a planning tool: a canvasser standing on a porch does not need to
 * be told the house is unlikely to sign, and telling them would change how the
 * conversation starts, which is the opposite of what this app is for.
 *
 * WHAT IS CACHED AND WHAT IS NOT. The door rows go through addressCache under
 * their own name, exactly like Scout's and the cutter's, so the second time a
 * manager opens the panel the county does not come down the wire again. The
 * KNOCKS are deliberately never cached: they are the thing that changes every
 * few minutes, they are what the model is actually about, and a stale copy
 * would quietly answer with yesterday's campaign.
 */

import { ref, computed } from 'vue'
import { fetchAllRows, supabase } from './supabase'
import { fetchDoors } from './doorData'
import { doorCache } from './addressCache'
import { useAuthStore } from '@/stores/auth'
import { buildOddsModel, type OddsDoor, type OddsKnock, type OddsModel } from './odds'
import type { KnockOutcome } from '@/types'

/** Bump when the select below changes, or an older copy is served with a
 *  column silently missing. */
const CACHE_SHAPE = 1
const DOOR_SELECT = 'id, street, city, lat, lng, persons(count)'
const doors = doorCache('odds', CACHE_SHAPE)

interface DoorRow {
  id: string
  street: string
  city: string
  lat: number | null
  lng: number | null
  persons?: { count: number }[]
}

export const oddsModel = ref<OddsModel | null>(null)
export const oddsLoading = ref(false)
export const oddsError = ref('')

/** Whoever may see this at all. Planning, not knocking. */
export function useOddsAllowed() {
  const auth = useAuthStore()
  return computed(
    () => auth.profile?.role === 'admin' || auth.profile?.role === 'campaign_manager',
  )
}

let inFlight: Promise<OddsModel | null> | null = null

/**
 * Build the model, once per session, sharing one load between however many
 * screens ask while it is running.
 */
export function ensureOddsModel(): Promise<OddsModel | null> {
  if (oddsModel.value) return Promise.resolve(oddsModel.value)
  if (inFlight) return inFlight
  oddsLoading.value = true
  oddsError.value = ''
  inFlight = load()
    .then((m) => {
      oddsModel.value = m
      return m
    })
    .catch((e) => {
      oddsError.value = e instanceof Error ? e.message : String(e)
      return null
    })
    .finally(() => {
      oddsLoading.value = false
      inFlight = null
    })
  return inFlight
}

async function load(): Promise<OddsModel> {
  const [knocks, rows] = await Promise.all([loadKnocks(), loadDoors()])
  // rank: false — the percentile yardstick scores every door in the county and
  // is only read by the Analytics tab. One door's odds do not need it.
  return buildOddsModel(knocks, rows, { rank: false })
}

async function loadKnocks(): Promise<OddsKnock[]> {
  const rows = await fetchAllRows<{
    household_id: string | null
    occurred_at: string
    outcome: KnockOutcome
  }>((from, to) =>
    supabase
      .from('knock_logs')
      .select('household_id, occurred_at, outcome')
      .not('household_id', 'is', null)
      .order('id')
      .range(from, to),
  )
  return rows
    .filter((r) => r.household_id)
    .map((r) => ({
      household: r.household_id!,
      ts: new Date(r.occurred_at).getTime(),
      outcome: r.outcome,
    }))
}

async function loadDoors(): Promise<OddsDoor[]> {
  const cached = await doors.read<DoorRow>()
  if (cached?.length) {
    // Refresh behind the panel, same rule as the map caches: a head start,
    // never an authority. A turf re-cut does not move any of these columns, so
    // an old copy is only ever wrong about doors added since an import.
    void refresh()
    return cached.map(toDoor)
  }
  const rows = await fetchDoors<DoorRow>({ select: DOOR_SELECT })
  void doors.write(rows)
  return rows.map(toDoor)
}

async function refresh(): Promise<void> {
  try {
    const rows = await fetchDoors<DoorRow>({ select: DOOR_SELECT })
    void doors.write(rows)
  } catch {
    // The panel already has a copy; this only ever bought the next open.
  }
}

const toDoor = (r: DoorRow): OddsDoor => ({
  id: r.id,
  street: r.street,
  city: r.city,
  lat: r.lat,
  lng: r.lng,
  residents: r.persons?.[0]?.count ?? 0,
})
