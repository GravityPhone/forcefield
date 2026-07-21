import { supabase } from '@/lib/supabase'
import { startOfLocalDayISO } from '@/lib/day'
import type { Address, HouseholdKnockSummary, HouseholdLatestKnock, KnockOutcome } from '@/types'

export type WalkDirection = 'ascending' | 'descending'
export type WalkParity = 'both' | 'even' | 'odd'

/** Latest outcomes that mean "don't send the canvasser back to this door" —
 * a hostile household stays hostile, a flat refusal is a refusal, and Skip
 * is the canvasser's explicit "retire this door" call (2026-07-14: it's how
 * a partly-signed door whose remaining names are stale gets closed out, and
 * it colors red on the maps to match). Softer outcomes (not home, maybe)
 * stay in the rotation for another pass. */
const CLOSED_OUTCOMES: KnockOutcome[] = ['hostile', 'didnt_sign', 'skip']

export interface NextHouseOptions {
  /** Whether to stop at households where someone signed but other residents
   * haven't yet. Off = treat a partly-signed door as done and walk past it. */
  knockPartlySigned: boolean
}

/** `street` stores the FULL address line ("123 Walnut St"), so matching by
 * house-number-stripped name is required to find neighbors — matching the
 * raw `street` column directly only ever matches that one exact house. */
export function streetNameOf(line: string): string {
  return line.replace(/^\d+\s*/, '').trim().toUpperCase()
}

export function houseNumber(street: string): number {
  return parseInt(street.match(/^\d+/)?.[0] ?? '0', 10)
}

function matchesParity(n: number, parity: WalkParity): boolean {
  return parity === 'both' || (parity === 'even') === (n % 2 === 0)
}

type AddressWithRoster = Address & { persons?: { count: number }[] }

/** One door ahead on the walk, with the status its "Up next" chip wears:
 * 'maybe' once somebody-but-not-everybody there signed (the yellow
 * partly-signed rule from doorStatusOutcome), else the latest soft outcome
 * (not home / maybe), null for a door never knocked. */
export interface UpcomingDoor {
  address: Address
  status: KnockOutcome | null
}

/** The next houses on the same street, in walk order — Talk mode's "Next"
 * button advances to the first, and the "Up next" chips preview the first
 * few. Direction/parity mimic real walk patterns (one side of the street,
 * then the other; ascending or descending house numbers).
 *
 * Houses are walked PAST (not returned) when knocking again would waste
 * the door: someone already knocked it today (any canvasser — squads share
 * turf), its latest outcome closed it (hostile / didn't sign / skip),
 * everyone there has signed, or it's partly signed and the toggle says skip
 * those. Returns [] when nothing past the current house survives. */
export async function findUpcomingOnStreet(
  current: Address,
  direction: WalkDirection,
  parity: WalkParity,
  options: NextHouseOptions = { knockPartlySigned: true },
  limit = 1,
): Promise<UpcomingDoor[]> {
  const targetName = streetNameOf(current.street)
  const currentNumber = houseNumber(current.street)
  const { data } = await supabase
    .from('addresses')
    .select('*, persons(count)')
    .ilike('street', `%${targetName}`)
  const rows = ((data ?? []) as AddressWithRoster[]).filter(
    (a) =>
      a.id !== current.id &&
      streetNameOf(a.street) === targetName &&
      matchesParity(houseNumber(a.street), parity),
  )

  const ahead =
    direction === 'ascending'
      ? rows.filter((a) => houseNumber(a.street) > currentNumber)
      : rows.filter((a) => houseNumber(a.street) < currentNumber)

  if (!ahead.length) return []

  ahead.sort((a, b) =>
    direction === 'ascending'
      ? houseNumber(a.street) - houseNumber(b.street)
      : houseNumber(b.street) - houseNumber(a.street),
  )

  // One batch of knock context for every candidate on the street (streets
  // are small — tens of ids), then walk the sorted list and stop at the
  // first door still worth knocking.
  const ids = ahead.map((a) => a.id)
  const [latestRes, summaryRes, todayRes] = await Promise.all([
    supabase.from('household_latest_knock').select('*').in('household_id', ids),
    supabase.from('household_knock_summary').select('*').in('household_id', ids),
    supabase
      .from('knock_logs')
      .select('household_id')
      .in('household_id', ids)
      .gte('occurred_at', startOfLocalDayISO()),
  ])
  const latestBy = new Map(
    ((latestRes.data ?? []) as HouseholdLatestKnock[]).map((r) => [r.household_id, r.outcome]),
  )
  const summaryBy = new Map(
    ((summaryRes.data ?? []) as HouseholdKnockSummary[]).map((r) => [r.household_id, r]),
  )
  const knockedToday = new Set((todayRes.data ?? []).map((r) => r.household_id as string))

  const out: UpcomingDoor[] = []
  for (const candidate of ahead) {
    if (knockedToday.has(candidate.id)) continue

    const latest = latestBy.get(candidate.id)
    if (latest && CLOSED_OUTCOMES.includes(latest)) continue

    const signed = summaryBy.get(candidate.id)?.signed_count ?? 0
    if (signed > 0) {
      const rosterSize = candidate.persons?.[0]?.count ?? 0
      const everyoneSigned = rosterSize > 0 && signed >= rosterSize
      if (everyoneSigned || !options.knockPartlySigned) continue
    }

    out.push({ address: candidate, status: signed > 0 ? 'maybe' : (latest ?? null) })
    if (out.length >= limit) break
  }
  return out
}

/** First house the walk would visit next — see findUpcomingOnStreet. */
export async function findNextOnStreet(
  current: Address,
  direction: WalkDirection,
  parity: WalkParity,
  options: NextHouseOptions = { knockPartlySigned: true },
): Promise<Address | null> {
  const [next] = await findUpcomingOnStreet(current, direction, parity, options, 1)
  return next?.address ?? null
}
