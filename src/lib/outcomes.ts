import type { KnockOutcome } from '@/types'

/** The six fixed Talk-mode outcome buttons, in display order (2×3 grid).
 * `color` uses theme tokens for UI elements; `hex` is for map pin SVGs,
 * which can't resolve CSS variables. */
export const OUTCOMES: { value: KnockOutcome; label: string; color: string; hex: string }[] = [
  { value: 'signed', label: 'Signed', color: 'var(--success)', hex: '#2e9e5b' },
  { value: 'didnt_sign', label: "Didn't Sign", color: 'var(--danger)', hex: '#d64545' },
  { value: 'maybe', label: 'Maybe', color: 'var(--warning)', hex: '#e0a02e' },
  { value: 'not_home', label: 'Not Home', color: '#8a90a5', hex: '#8a90a5' },
  { value: 'skip', label: 'Skip', color: '#b9bdcc', hex: '#b9bdcc' },
  { value: 'hostile', label: 'Hostile', color: '#7a2e2e', hex: '#7a2e2e' },
]

export const OUTCOME_LABELS: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.label]),
) as Record<KnockOutcome, string>

export const OUTCOME_HEX: Record<KnockOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.hex]),
) as Record<KnockOutcome, string>

/** Pin color for addresses with no knock logged yet. */
export const PIN_DEFAULT_HEX = '#2f6fed'
