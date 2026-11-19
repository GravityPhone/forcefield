/**
 * Reading a site plan out of a spreadsheet (2026-11-19).
 *
 * Nobody's sheet looks like anybody else's, so this does not expect a format.
 * It reads a table (pasted straight from Google Sheets, which arrives as
 * tab-separated text, or a .csv file), GUESSES which column is which from the
 * headers, and lets a person correct the guess before anything is saved.
 *
 * It assumes one thing only: one row per site per day. A calendar grid (days
 * across the top, sites down the side) is a different shape and is not
 * handled here.
 *
 * Pure functions, no Supabase: the sheet that calls these owns the writes.
 */

/** Parse delimited text into rows of cells. Tabs when the text has any
 * (a paste from a spreadsheet), commas otherwise (a CSV). Quoted cells may
 * hold the delimiter, newlines and doubled quotes. Blank rows are dropped. */
export function parseTable(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n')
  const firstLine = src.split('\n', 1)[0] ?? ''
  const delim = firstLine.includes('\t') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === delim) {
      row.push(cell.trim())
      cell = ''
    } else if (ch === '\n') {
      row.push(cell.trim())
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell.trim())
  rows.push(row)
  return rows.filter((r) => r.some((c) => c !== ''))
}

export type PlanField = 'site' | 'address' | 'date' | 'start' | 'end' | 'goal' | 'crew' | 'notes'

export const PLAN_FIELDS: { key: PlanField; label: string; required: boolean }[] = [
  { key: 'site', label: 'Site name', required: true },
  { key: 'date', label: 'Date', required: true },
  { key: 'address', label: 'Address', required: false },
  { key: 'start', label: 'Start time', required: false },
  { key: 'end', label: 'End time', required: false },
  { key: 'goal', label: 'Goal', required: false },
  { key: 'crew', label: 'Crew', required: false },
  { key: 'notes', label: 'Notes', required: false },
]

/** Header patterns, tried in this order so the specific words win before the
 * vague ones ("Site address" is an address, not a site). */
const GUESSES: [PlanField, RegExp][] = [
  ['address', /address|addr\b|street/],
  ['date', /date|\bday\b/],
  ['end', /\bend|finish|until|\bout\b/],
  ['start', /start|begin|\bfrom\b|\btime|shift|hours/],
  ['goal', /goal|target|quota/],
  ['crew', /crew|staff|canvasser|team|\bwho\b|assign|people|names|registrar/],
  ['notes', /note|comment|contact|permission|detail/],
  ['site', /site|location|venue|store|place|name/],
]

/** Column index per field, or -1 when no header looks like it. */
export function guessColumns(headers: string[]): Record<PlanField, number> {
  const out: Record<PlanField, number> = {
    site: -1,
    address: -1,
    date: -1,
    start: -1,
    end: -1,
    goal: -1,
    crew: -1,
    notes: -1,
  }
  const taken = new Set<number>()
  for (const [field, re] of GUESSES) {
    const i = headers.findIndex((h, idx) => !taken.has(idx) && re.test(h.toLowerCase()))
    if (i >= 0) {
      out[field] = i
      taken.add(i)
    }
  }
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const probe = new Date(y, m - 1, d)
  if (probe.getMonth() !== m - 1) return null // Feb 30 and friends
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** A date with no year means the next time that date comes around: a plan
 * written in November with a "1/5" row is about January. Anything more than
 * about two months back is read as next year. */
function inferYear(m: number, d: number, now: Date): number {
  const y = now.getFullYear()
  const candidate = new Date(y, m - 1, d)
  return now.getTime() - candidate.getTime() > 60 * 86_400_000 ? y + 1 : y
}

/** YYYY-MM-DD from the ways people type a date in a sheet, or null.
 * US month-first for slashes, since that is what these plans use. */
export function parseDate(raw: string, now = new Date()): string | null {
  const s = raw.trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/)
  if (m) {
    const mo = +m[1]
    const d = +m[2]
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : inferYear(mo, d, now)
    return ymd(y, mo, d)
  }
  // "Nov 20", "Thursday, November 20, 2026", "20 Nov 2026"
  const lower = s.toLowerCase()
  const mi = MONTHS.findIndex((name) => new RegExp(`\\b${name}`).test(lower))
  if (mi >= 0) {
    const nums = lower.match(/\d+/g)?.map(Number) ?? []
    const day = nums.find((n) => n >= 1 && n <= 31)
    const year = nums.find((n) => n >= 2000)
    if (day) return ymd(year ?? inferYear(mi + 1, day, now), mi + 1, day)
  }
  return null
}

interface LooseTime {
  h: number
  min: number
  /** Whether the text said AM or PM itself. */
  explicit: boolean
}

function looseTime(raw: string): LooseTime | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (s === 'noon') return { h: 12, min: 0, explicit: true }
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?m?\.?$/)
  if (!m) return null
  let h = +m[1]
  const min = m[2] ? +m[2] : 0
  if (h > 23 || min > 59) return null
  if (m[3]) {
    if (h > 12) return null
    if (m[3] === 'p' && h < 12) h += 12
    if (m[3] === 'a' && h === 12) h = 0
    return { h, min, explicit: true }
  }
  return { h, min, explicit: h > 12 || h === 0 }
}

/** A bare hour with no AM/PM is read the way a shift would mean it: 8 to 11
 * is morning, 12 to 7 is afternoon. Nobody tables at 3 AM. */
function settle(t: LooseTime): string {
  let h = t.h
  if (!t.explicit && h >= 1 && h <= 7) h += 12
  return `${String(h).padStart(2, '0')}:${String(t.min).padStart(2, '0')}`
}

/** HH:MM from "9", "9am", "9:30 AM", "14:00" or "noon", or null. */
export function parseTime(raw: string): string | null {
  const t = looseTime(raw)
  return t ? settle(t) : null
}

/** A cell holding both ends, "10am-2pm" or "10 to 2": [start, end]. A single
 * time comes back as [time, null]. When only the END says AM or PM ("10-2pm")
 * the start takes whichever half of the day puts it before the end. */
export function parseTimeRange(raw: string): [string | null, string | null] {
  const parts = raw.split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean)
  if (parts.length < 2) return [parseTime(raw), null]
  const a = looseTime(parts[0])
  const b = looseTime(parts[1])
  if (!a || !b) return [a ? settle(a) : null, b ? settle(b) : null]
  if (!a.explicit && b.explicit) {
    const sameHalf = b.h >= 12 && a.h < 12 ? a.h + 12 : a.h
    const start = sameHalf * 60 + a.min < b.h * 60 + b.min ? sameHalf : a.h
    return [settle({ h: start, min: a.min, explicit: true }), settle(b)]
  }
  return [settle(a), settle(b)]
}

export interface PlanRow {
  site: string
  address: string | null
  date: string
  start: string | null
  end: string | null
  goal: number | null
  /** Names as typed, split on commas, semicolons, slashes, "&" and "and". */
  crew: string[]
  notes: string | null
}

export interface PlanParse {
  rows: PlanRow[]
  /** Rows dropped for lacking a site name or a readable date. */
  skipped: number
}

/** Apply a column mapping to the data rows (everything under the header). */
export function readPlan(
  data: string[][],
  cols: Record<PlanField, number>,
  now = new Date(),
): PlanParse {
  const at = (r: string[], f: PlanField) => (cols[f] >= 0 ? (r[cols[f]] ?? '').trim() : '')
  const rows: PlanRow[] = []
  let skipped = 0
  for (const r of data) {
    const site = at(r, 'site')
    const date = parseDate(at(r, 'date'), now)
    if (!site || !date) {
      skipped++
      continue
    }
    // One "Time" column holding "10am-2pm" fills both ends; a separate End
    // column, when mapped, wins for the end.
    const [rangeStart, rangeEnd] = parseTimeRange(at(r, 'start'))
    const end = parseTime(at(r, 'end')) ?? rangeEnd
    const goalNum = parseInt(at(r, 'goal').replace(/[^\d]/g, ''), 10)
    rows.push({
      site,
      address: at(r, 'address') || null,
      date,
      start: rangeStart,
      end,
      goal: Number.isFinite(goalNum) ? goalNum : null,
      crew: at(r, 'crew')
        .split(/\s*(?:,|;|\/|&|\band\b)\s*/i)
        .map((n) => n.trim())
        .filter(Boolean),
      notes: at(r, 'notes') || null,
    })
  }
  return { rows, skipped }
}
