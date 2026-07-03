import { supabase } from '@/lib/supabase'
import type { Address } from '@/types'

export type WalkDirection = 'ascending' | 'descending'
export type WalkParity = 'both' | 'even' | 'odd'

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

/** Next house on the same street, in walk order — used by Talk mode's "Next"
 * button to auto-advance instead of leaving the canvasser to search again.
 * Direction/parity mimic real walk patterns (one side of the street, then
 * the other; ascending or descending house numbers). Returns null at the
 * end of the street or if nothing else on it matches the filter. */
export async function findNextOnStreet(
  current: Address,
  direction: WalkDirection,
  parity: WalkParity,
): Promise<Address | null> {
  const targetName = streetNameOf(current.street)
  const currentNumber = houseNumber(current.street)
  const { data } = await supabase.from('addresses').select('*').ilike('street', `%${targetName}`)
  const rows = ((data ?? []) as Address[]).filter(
    (a) =>
      a.id !== current.id &&
      streetNameOf(a.street) === targetName &&
      matchesParity(houseNumber(a.street), parity),
  )

  const ahead =
    direction === 'ascending'
      ? rows.filter((a) => houseNumber(a.street) > currentNumber)
      : rows.filter((a) => houseNumber(a.street) < currentNumber)

  if (!ahead.length) return null

  ahead.sort((a, b) =>
    direction === 'ascending'
      ? houseNumber(a.street) - houseNumber(b.street)
      : houseNumber(b.street) - houseNumber(a.street),
  )
  return ahead[0]
}
