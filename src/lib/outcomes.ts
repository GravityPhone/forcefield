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
 * themselves — picked per hex by contrast, not by theme.
 *
 * `short`: the same outcome for chrome that has no room for a sentence —
 * chart axis labels (130px), filter chips, uppercase status pills, compact
 * rows. All six are identical to `label` since the 'maybe' rename to
 * "Return" (2026-07-26) — the split stays because the two questions are
 * still different ones, and the next long label shouldn't have to re-thread
 * itself through every chart gutter and chip in the app. Use OUTCOME_LABELS
 * for prose lines and buttons, OUTCOME_SHORT where the label is a tag. */
export const OUTCOMES: {
  value: KnockOutcome
  label: string
  short: string
  hex: string
  ink: string
  requiresPerson: boolean
  doorLevel: boolean
}[] = [
  { value: 'signed', label: 'Signed', short: 'Signed', hex: '#2e9e5b', ink: '#181c26', requiresPerson: true, doorLevel: false },
  // The stored value stays `didnt_sign` — only the label changed (2026-07-25,
  // user call): "Not Interested" is what the canvasser actually heard, and it
  // reads as "don't come back here" rather than as a scorekeeping loss. No
  // behavior moved with it; this outcome closes a door for the walk exactly as
  // it always did (CLOSED_OUTCOMES in streetWalk.ts).
  { value: 'didnt_sign', label: 'Not Interested', short: 'Not Interested', hex: '#d64545', ink: '#ffffff', requiresPerson: false, doorLevel: false },
  // "Maybe" → "Come back another time" → "Return" (both 2026-07-26, user
  // calls). Same stored value, same color, same walk behavior throughout —
  // only the wording moved, twice: "Maybe" described the canvasser's guess
  // rather than what to do about it, and "Come back another time" said the
  // right thing in five words where one does. It's also the one button that
  // asks a follow-up: with appointments enabled, tapping it offers a window
  // to come back in (src/lib/appointments.ts, AppointmentSheet.vue).
  { value: 'maybe', label: 'Return', short: 'Return', hex: '#e0a02e', ink: '#181c26', requiresPerson: false, doorLevel: false },
  { value: 'not_home', label: 'Not Home', short: 'Not Home', hex: '#8a90a5', ink: '#181c26', requiresPerson: false, doorLevel: true },
  // Skip and Hostile share Not Interested's red ON PURPOSE (2026-07-14): to a
  // canvasser all three mean the same thing — "this door is a no, don't come
  // back". The labels/positions tell them apart where it matters.
  { value: 'skip', label: 'Skip', short: 'Skip', hex: '#d64545', ink: '#ffffff', requiresPerson: false, doorLevel: true },
  { value: 'hostile', label: 'Hostile', short: 'Hostile', hex: '#d64545', ink: '#ffffff', requiresPerson: false, doorLevel: true },
]

export const OUTCOME_LABELS: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.label]),
) as Record<KnockOutcome, string>

/** Tag-sized outcome names — see `short` above. */
export const OUTCOME_SHORT: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.short]),
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

/** OUTCOME_INK's missing seventh entry: legible text over PIN_DEFAULT_HEX.
 * A never-knocked door has no outcome, so it has no row in that table — but
 * anything that FILLS a surface with a door's status (doorPaint) can land on
 * this blue and still need a label on top of it. */
export const PIN_DEFAULT_INK = '#ffffff'

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

/** The colors a door is painted with, from one call: the fill every surface
 * uses, plus the yellow inset band a partly-signed door wears over its green.
 * Same pair the map pins draw (doorCanvas's fill + innerRing) and the same
 * pair the list rows show as a square — HuntTab had two copies of this
 * three-line dance before it lived here.
 *
 * `ink` is the third, for surfaces that put a LABEL on the fill rather than
 * just showing it (Scout's Knock button). It's resolved from the same branch
 * as the fill, so the two can't drift: pick a fill by hand and you have to
 * remember which of the six needs dark text; take the pair and you don't. */
export function doorPaint(
  latest: KnockOutcome | null | undefined,
  signedCount: number | null | undefined,
  personCount: number | null | undefined,
): { fill: string; band: string | null; ink: string } {
  const partly = doorPartlySigned(latest, signedCount, personCount)
  const outcome = doorStatusOutcome(latest, signedCount, personCount)
  return {
    fill: partly ? OUTCOME_HEX.signed : outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX,
    band: partly ? OUTCOME_HEX.maybe : null,
    ink: partly ? OUTCOME_INK.signed : outcome ? OUTCOME_INK[outcome] : PIN_DEFAULT_INK,
  }
}

/** Wash a whole list row in a subdued version of its status color (2026-07-26,
 * user call — "shades the entire bar in a similar color, but a lighter, more
 * subdued shade, and then also puts a square, so it's really obvious").
 *
 * Returns CSS variables rather than a `background`, for two reasons: an inline
 * `background` would beat every `:hover` and `.active` rule in the sheet, and
 * a row's resting surface differs by screen (a card, a bottom sheet, a
 * transparent list). Rows read `var(--row-tint, <their own default>)`, so a
 * row with no status looks exactly as it did before.
 *
 * Mixed against `var(--surface)` rather than `transparent` so the result is
 * opaque: it then composites identically over a card, a sheet or a striped
 * list, and it follows the theme — the same green is a pale wash on a day
 * scheme and a deep one at night, with no second palette to maintain. */
export function outcomeRowTint(hex: string | null | undefined): Record<string, string> {
  if (!hex) return {}
  return {
    '--row-tint': `color-mix(in srgb, ${hex} 15%, var(--surface))`,
    '--row-tint-hover': `color-mix(in srgb, ${hex} 26%, var(--surface))`,
  }
}

/* knockButtonHex() lived here until 2026-07-26 and is deliberately gone.
 *
 * It was a private 4-bucket copy of the color table for Scout's Knock button,
 * and it disagreed with OUTCOME_HEX on exactly one outcome: it painted
 * `not_home` BLUE, reasoning that not-home and never-visited both mean
 * "nothing useful learned yet". On screen that read as a gray pin with a blue
 * Knock button beside it — two things on one screen disagreeing about one
 * door, the same class of bug as the located card's stripe (2026-07-25).
 *
 * Not-home is not the same as never-knocked to the person deciding whether to
 * walk up: somebody has already been here and got no answer. The map has
 * always said so in gray, so the button says gray too.
 *
 * Everything that fills a surface with a door's status now calls doorPaint().
 * Don't reintroduce a per-surface table — resolve the fill from the shared
 * helper and take its ink with it. */
