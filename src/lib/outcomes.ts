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
 * household loaded, same as before. */
export const OUTCOMES: { value: KnockOutcome; label: string; hex: string; requiresPerson: boolean }[] = [
  { value: 'signed', label: 'Signed', hex: '#2e9e5b', requiresPerson: true },
  { value: 'didnt_sign', label: "Didn't Sign", hex: '#d64545', requiresPerson: true },
  { value: 'maybe', label: 'Maybe', hex: '#e0a02e', requiresPerson: true },
  { value: 'not_home', label: 'Not Home', hex: '#8a90a5', requiresPerson: false },
  { value: 'skip', label: 'Skip', hex: '#b9bdcc', requiresPerson: false },
  { value: 'hostile', label: 'Hostile', hex: '#7a2e2e', requiresPerson: false },
]

export const OUTCOME_LABELS: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.label]),
) as Record<KnockOutcome, string>

export const OUTCOME_HEX: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.hex]),
) as Record<KnockOutcome, string>

/** Pin color for addresses with no knock logged yet. */
export const PIN_DEFAULT_HEX = '#2f6fed'

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
