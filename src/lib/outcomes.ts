import type { KnockOutcome } from '@/types'

/** The six fixed Talk-mode outcome buttons, in display order (2×3 grid).
 * `hex` is a literal color, deliberately NOT a theme token — these buttons,
 * the Hunt-mode indicator grid, and map pins must read the same regardless
 * of the user's chosen color scheme, so the outcome<->color mapping stays
 * fixed while everything else in the app is themable.
 *
 * `requiresPerson`: a real outcome (signed/didn't sign/maybe) must be tied to
 * an actual person on the roster — you can't credit or reject a signature
 * for "the household" in the abstract. Not Home / Skip / Hostile describe
 * the door interaction itself, not any one resident, so those only need a
 * household loaded, same as before.
 *
 * `ink`: legible text color OVER a surface filled with `hex` (Talk-mode
 * roster bubbles, the household banner). Fixed literals like the fills
 * themselves — picked per hex by contrast, not by theme. */
export const OUTCOMES: { value: KnockOutcome; label: string; hex: string; ink: string; requiresPerson: boolean }[] = [
  { value: 'signed', label: 'Signed', hex: '#2e9e5b', ink: '#181c26', requiresPerson: true },
  { value: 'didnt_sign', label: "Didn't Sign", hex: '#d64545', ink: '#ffffff', requiresPerson: true },
  { value: 'maybe', label: 'Maybe', hex: '#e0a02e', ink: '#181c26', requiresPerson: true },
  { value: 'not_home', label: 'Not Home', hex: '#8a90a5', ink: '#181c26', requiresPerson: false },
  // Skip and Hostile share Didn't Sign's red ON PURPOSE (2026-07-14): to a
  // canvasser all three mean the same thing — "this door is a no, don't come
  // back". The labels/positions tell them apart where it matters.
  { value: 'skip', label: 'Skip', hex: '#d64545', ink: '#ffffff', requiresPerson: false },
  { value: 'hostile', label: 'Hostile', hex: '#d64545', ink: '#ffffff', requiresPerson: false },
]

export const OUTCOME_LABELS: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.label]),
) as Record<KnockOutcome, string>

export const OUTCOME_HEX: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.hex]),
) as Record<KnockOutcome, string>

/** Text color that stays readable on top of the matching OUTCOME_HEX fill. */
export const OUTCOME_INK: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.ink]),
) as Record<KnockOutcome, string>

export const OUTCOME_REQUIRES_PERSON: Record<KnockOutcome, boolean> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.requiresPerson]),
) as Record<KnockOutcome, boolean>

/** Pin color for addresses with no knock logged yet. */
export const PIN_DEFAULT_HEX = '#2f6fed'

/** Effective door status for map pins / status coloring (2026-07-14), from
 * the door's latest outcome plus how many of its residents have signed
 * (household_latest_knock's signed_count/person_count). The rules, in
 * precedence order:
 *
 *  1. EVERYONE living there signed → 'signed' (green — door complete).
 *  2. Latest outcome is Skip or Hostile → that outcome (red). These are
 *     door-level "don't come back" calls, so they close even a partly-signed
 *     door — hitting Skip is exactly how a canvasser retires a yellow door
 *     whose remaining names turn out to be stale.
 *  3. Somebody signed but not everybody → 'maybe' (yellow — worth another
 *     look). Person-level outcomes (e.g. one resident's Didn't Sign) do NOT
 *     override this: other residents are still gettable.
 *  4. Otherwise the latest outcome as-is (or null = never knocked → blue).
 */
export function doorStatusOutcome(
  latest: KnockOutcome | null | undefined,
  signedCount: number | null | undefined,
  personCount: number | null | undefined,
): KnockOutcome | null {
  const signed = signedCount ?? 0
  const total = personCount ?? 0
  if (signed > 0 && total > 0 && signed >= total) return 'signed'
  if (latest === 'skip' || latest === 'hostile') return latest
  if (signed > 0) return 'maybe'
  return latest ?? null
}

/** Coarse 4-bucket status color for the Hunt "Knock" button — green once
 * signed, yellow while still a maybe, red once it's a closed no (didn't
 * sign / skip / hostile), blue for not-home or never-visited (nothing
 * useful learned yet). Distinct from OUTCOME_HEX, which gives each of the
 * six outcomes its own color for the pins/indicator grid. */
export function knockButtonHex(outcome: KnockOutcome | null | undefined): string {
  switch (outcome) {
    case 'signed':
      return '#2e9e5b'
    case 'maybe':
      return '#e0a02e'
    case 'didnt_sign':
    case 'skip':
    case 'hostile':
      return '#d64545'
    case 'not_home':
    default:
      return '#2f6fed'
  }
}
