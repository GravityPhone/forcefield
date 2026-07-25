/** Parsing for the AI chat's fenced blocks — ```infographic (a chart spec) and
 * ```turfplan (a suggested turf; see turfPlan.ts). The assistant embeds a small
 * JSON spec, documented in the chat function's system prompt; the chat view
 * splits each reply into segments and renders each with its own card. A block
 * that fails to parse falls back to a text segment so nothing silently
 * disappears. */

import { parseTurfPlan, type TurfPlanSpec } from './turfPlan'

export interface InfographicDatum {
  label: string
  value: number
  color?: string
}

export interface InfographicSpec {
  type: 'bar' | 'line' | 'pie' | 'stat'
  title?: string
  data: InfographicDatum[]
}

export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'infographic'; spec: InfographicSpec }
  | { kind: 'turfplan'; spec: TurfPlanSpec }

/** Chart palette for data points without an explicit color. Starts from the
 * app's pin blue / outcome hues so charts feel native. */
const PALETTE = ['#2f6fed', '#2e9e5b', '#e0a02e', '#d64545', '#6b4fd8', '#1f9e9e', '#8a90a5', '#7a2e2e']

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

const TYPES = new Set(['bar', 'line', 'pie', 'stat'])
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const MAX_POINTS = 10

function parseInfographic(raw: string): InfographicSpec | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const { type, title, data } = obj as Record<string, unknown>
  if (typeof type !== 'string' || !TYPES.has(type)) return null
  if (!Array.isArray(data) || data.length === 0) return null

  const points: InfographicDatum[] = []
  for (const item of data.slice(0, MAX_POINTS)) {
    if (!item || typeof item !== 'object') continue
    const { label, value, color } = item as Record<string, unknown>
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) continue
    points.push({
      label: String(label ?? '').slice(0, 60),
      value: num,
      color: typeof color === 'string' && HEX_RE.test(color.trim()) ? color.trim() : undefined,
    })
  }
  if (!points.length) return null

  return {
    type: type as InfographicSpec['type'],
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : undefined,
    data: points,
  }
}

const BLOCK_RE = /```(infographic|turfplan)\s*\n?([\s\S]*?)```/g

/** Split an assistant reply into renderable segments. */
export function splitSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let last = 0
  for (const match of text.matchAll(BLOCK_RE)) {
    const before = text.slice(last, match.index)
    if (before.trim()) segments.push({ kind: 'text', text: before })
    const body = match[2].trim()
    if (match[1] === 'turfplan') {
      const plan = parseTurfPlan(body)
      if (plan) segments.push({ kind: 'turfplan', spec: plan })
      else if (body) segments.push({ kind: 'text', text: body })
    } else {
      const spec = parseInfographic(body)
      if (spec) segments.push({ kind: 'infographic', spec })
      else if (body) segments.push({ kind: 'text', text: body })
    }
    last = match.index + match[0].length
  }
  const rest = text.slice(last)
  if (rest.trim()) segments.push({ kind: 'text', text: rest })
  if (!segments.length) segments.push({ kind: 'text', text })
  return segments
}
