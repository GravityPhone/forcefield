/** Local-day helpers: squads and "knocked today" both reset at the
 * canvasser's own midnight, so everything day-scoped keys off the device's
 * local date — not UTC, which would roll the day over mid-evening for US
 * timezones. */

/** A Date's LOCAL calendar day as YYYY-MM-DD. Use this to turn a stored
 * timestamptz into the day a person would say it happened on — reading the
 * ISO string's own date would give the UTC day, which is already tomorrow
 * for anything logged after 8pm in Ohio. */
export function localDayOf(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Today as a YYYY-MM-DD date string in local time (matches Postgres
 * `date` literals, so it's usable directly in eq() filters and RPC args). */
export function localToday(): string {
  return localDayOf(new Date())
}

/** Local midnight as an ISO timestamp, for `occurred_at >= …` filters. */
export function startOfLocalDayISO(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** Local midnight..next-midnight window for an arbitrary YYYY-MM-DD date
 * (not just today) — powers the leaderboard's day-history view. Built from
 * separate y/m/d components rather than `new Date(dateStr)`, which parses
 * a bare "YYYY-MM-DD" string as UTC midnight and would drift the boundary
 * by several hours in US timezones. */
export function localDayRangeISO(dateStr: string): { startISO: string; endISO: string } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0)
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return { startISO: start.toISOString(), endISO: end.toISOString() }
}
