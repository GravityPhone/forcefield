import type { KnockOutcome } from '@/types'

/** The six fixed Talk-mode outcome buttons, in display order (2×3 grid).
 * `hex` is a literal color, deliberately NOT a theme token — these buttons,
 * the Hunt-mode indicator grid, and map pins must read the same regardless
 * of the user's chosen color scheme, so the outcome<->color mapping stays
 * fixed while everything else in the app is themable.
 *
 * Two flags, and they answer DIFFERENT questions (2026-07-25) — keep them
 * apart:
 *
 * `requiresPerson`: this outcome can't be logged without a name, so its
 * button stays disabled until someone's picked from the roster. Only
 * 'signed'. A petition signature is a particular person's; there's no such
 * thing as one belonging to "the household" in the abstract.
 *   Not Interested and Maybe USED to require a person too, and stopped on
 *   2026-07-25 (user call): you're standing at the door talking to somebody
 *   and often have no idea which of the roster names they are — or they're
 *   not on the roster at all. Forcing a guess to record what you were
 *   plainly told meant the answer went unlogged. With a person picked they
 *   still log against that person exactly as before; with nobody picked
 *   they log against the door.
 *
 * `doorLevel`: this outcome is about the VISIT, not any one resident (Not
 * Home / Skip / Hostile), so it speaks for the whole door even when a
 * person happened to be selected as it was logged. Separate from the above
 * because a Not Interested can now go either way: with no person_id it
 * speaks for the door (floods TalkTab's address banner); with one it's that
 * person's answer and stays on their roster bubble.
 *
 * `ink`: legible text color OVER a surface filled with `hex` (Talk-mode
 * roster bubbles, the household banner). Fixed literals like the fills
 * themselves — picked per hex by contrast, not by theme. */
export const OUTCOMES: {
  value: KnockOutcome
  label: string
  hex: string
  ink: string
  requiresPerson: boolean
  doorLevel: boolean
}[] = [
  { value: 'signed', label: 'Signed', hex: '#2e9e5b', ink: '#181c26', requiresPerson: true, doorLevel: false },
  // The stored value stays `didnt_sign` — only the label changed (2026-07-25,
  // user call): "Not Interested" is what the canvasser actually heard, and it
  // reads as "don't come back here" rather than as a scorekeeping loss. No
  // behavior moved with it; this outcome closes a door for the walk exactly as
  // it always did (CLOSED_OUTCOMES in streetWalk.ts).
  { value: 'didnt_sign', label: 'Not Interested', hex: '#d64545', ink: '#ffffff', requiresPerson: false, doorLevel: false },
  { value: 'maybe', label: 'Maybe', hex: '#e0a02e', ink: '#181c26', requiresPerson: false, doorLevel: false },
  { value: 'not_home', label: 'Not Home', hex: '#8a90a5', ink: '#181c26', requiresPerson: false, doorLevel: true },
  // Skip and Hostile share Not Interested's red ON PURPOSE (2026-07-14): to a
  // canvasser all three mean the same thing — "this door is a no, don't come
  // back". The labels/positions tell them apart where it matters.
  { value: 'skip', label: 'Skip', hex: '#d64545', ink: '#ffffff', requiresPerson: false, doorLevel: true },
  { value: 'hostile', label: 'Hostile', hex: '#d64545', ink: '#ffffff', requiresPerson: false, doorLevel: true },
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

/** Outcomes that describe the visit rather than a resident — true for a door
 * whoever answered it. Ask this (not requiresPerson) when the question is
 * "does this knock speak for the whole household?", and pair it with the
 * knock's own person_id: `doorLevel || !person_id`. */
export const OUTCOME_DOOR_LEVEL: Record<KnockOutcome, boolean> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.doorLevel]),
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

/** Is this door PARTLY signed — somebody living there signed, but not
 * everybody, and nothing has closed the door since? Exactly the condition
 * that makes rule 3 above fire, surfaced as its own state because the maps
 * paint it differently from a genuine latest-outcome 'maybe':
 *
 *   partly signed  → GREEN fill with a YELLOW ring (progress here, but
 *                    there are still names to get)
 *   latest 'maybe' → plain yellow fill (nobody has signed yet)
 *
 * doorStatusOutcome folds both into 'maybe', which is right for anything
 * that just needs one color; call this alongside it when you can draw two.
 * Every map does (2026-07-24); Talk's roster bubbles deliberately don't. */
export function doorPartlySigned(
  latest: KnockOutcome | null | undefined,
  signedCount: number | null | undefined,
  personCount: number | null | undefined,
): boolean {
  const signed = signedCount ?? 0
  const total = personCount ?? 0
  if (signed <= 0) return false
  if (total > 0 && signed >= total) return false
  return latest !== 'skip' && latest !== 'hostile'
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
