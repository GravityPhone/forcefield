/** Parsing + URL transport for the AI chat's ```turfplan blocks.
 *
 * The assistant can't cut turf — it's read-only, and deciding which ground a
 * crew walks is a human call made by someone who knows the neighborhood. So a
 * plan is a SUGGESTION: the chat renders it as a card, tapping the card opens
 * /turf?plan=… , and the cutter pre-builds a draft the human reviews and saves.
 * The AI's entire output is a URL; every write still goes through the same
 * Save button a hand-cut draft uses.
 *
 * A block that fails to parse falls back to plain text, exactly like
 * infographics — machinery never leaks into a reply bubble. */

export interface TurfPlanStreet {
  street: string
  city: string | null
  /** House-number range. Both absent = take the whole street. */
  from?: number
  to?: number
}

export interface TurfPlanSpec {
  name?: string
  /** One short line shown above the pre-built draft. */
  note?: string
  streets: TurfPlanStreet[]
}

const MAX_STREETS = 8
const MAX_NAME = 60
const MAX_NOTE = 140

export function parseTurfPlan(raw: string): TurfPlanSpec | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const { name, note, streets } = obj as Record<string, unknown>
  if (!Array.isArray(streets) || streets.length === 0) return null

  const out: TurfPlanStreet[] = []
  for (const item of streets.slice(0, MAX_STREETS)) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const street = typeof s.street === 'string' ? s.street.trim() : ''
    if (!street) continue
    const from = Number(s.from)
    const to = Number(s.to)
    out.push({
      street: street.slice(0, 80),
      city: typeof s.city === 'string' && s.city.trim() ? s.city.trim().slice(0, 60) : null,
      from: Number.isFinite(from) && from > 0 ? Math.floor(from) : undefined,
      to: Number.isFinite(to) && to > 0 ? Math.floor(to) : undefined,
    })
  }
  if (!out.length) return null

  return {
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : undefined,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, MAX_NOTE) : undefined,
    streets: out,
  }
}

/** Compact encoding — this rides a URL, so keys are single letters and each
 * street is a positional tuple rather than an object. */
export function encodeTurfPlan(spec: TurfPlanSpec): string {
  return encodeURIComponent(
    JSON.stringify({
      n: spec.name,
      m: spec.note,
      s: spec.streets.map((s) => [s.street, s.city, s.from ?? null, s.to ?? null]),
    }),
  )
}

export function decodeTurfPlan(raw: string): TurfPlanSpec | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    const rows = Array.isArray(o.s) ? o.s : []
    const streets: TurfPlanStreet[] = []
    for (const r of rows.slice(0, MAX_STREETS)) {
      if (!Array.isArray(r) || typeof r[0] !== 'string' || !r[0].trim()) continue
      streets.push({
        street: r[0].slice(0, 80),
        city: typeof r[1] === 'string' && r[1].trim() ? r[1] : null,
        from: typeof r[2] === 'number' && r[2] > 0 ? r[2] : undefined,
        to: typeof r[3] === 'number' && r[3] > 0 ? r[3] : undefined,
      })
    }
    if (!streets.length) return null
    return {
      name: typeof o.n === 'string' ? o.n.slice(0, MAX_NAME) : undefined,
      note: typeof o.m === 'string' ? o.m.slice(0, MAX_NOTE) : undefined,
      streets,
    }
  } catch {
    return null
  }
}

/** "100–298" / "from 100" / "whole street" — the range as a human reads it. */
export function planRangeLabel(s: TurfPlanStreet): string {
  if (s.from != null && s.to != null) return `${s.from} to ${s.to}`
  if (s.from != null) return `${s.from} and up`
  if (s.to != null) return `up to ${s.to}`
  return 'whole street'
}
