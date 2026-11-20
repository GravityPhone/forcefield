/**
 * Read a link-shared Google Sheet as CSV (2026-11-19).
 *
 * Lives outside netlify/functions/ on purpose: the function (sheet.ts) and
 * the dev server (vite.config.ts) both call it, and nothing in here touches
 * Supabase or the environment, so importing it can never fail for a missing
 * key.
 *
 * NO GOOGLE ACCOUNT IS INVOLVED. This asks Google for the sheet the way an
 * anonymous browser would, so it only works when the sheet is shared as
 * "Anyone with the link". A private sheet answers with a sign-in page, which
 * is reported as exactly that.
 *
 * It is not an open proxy: the only thing taken from the caller's URL is the
 * spreadsheet id and the tab id, both checked against a strict pattern, and
 * the request always goes to docs.google.com.
 */

export interface SheetRef {
  id: string
  gid: string
}

export interface SheetResult {
  csv: string
  /** "Fall site plan - Week 3", from Google's own filename. Null if absent. */
  title: string | null
  /** Stable name for this tab: "<spreadsheet id>:<gid>". */
  key: string
}

export class SheetError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Pull the spreadsheet id and tab out of any of the links Sheets hands out
 * (…/d/<id>/edit#gid=123, …/edit?gid=123, …/d/<id>/, a bare id). */
export function parseSheetUrl(raw: string): SheetRef | null {
  const s = raw.trim()
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) ?? s.match(/^([A-Za-z0-9_-]{25,})$/)
  if (!m) return null
  // Published-to-web links (/d/e/2PACX-…) are a different address space and
  // have no export endpoint under this id.
  if (m[1] === 'e') return null
  const gid = s.match(/[#?&]gid=(\d+)/)?.[1] ?? '0'
  return { id: m[1], gid }
}

const MAX_BYTES = 2_000_000

export async function fetchSheetCsv(rawUrl: string): Promise<SheetResult> {
  const ref = parseSheetUrl(rawUrl)
  if (!ref) throw new SheetError('That is not a Google Sheets link.')
  const url = `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${ref.gid}`
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(7000) })
  } catch {
    throw new SheetError('Could not reach Google Sheets. Try again.', 502)
  }
  const type = res.headers.get('content-type') ?? ''
  // A sheet that is not link-shared redirects to a sign-in page (HTML, often
  // with a 200), so the content type is the honest test, not the status.
  if (!type.includes('text/csv')) {
    if (res.status === 404 || res.status === 400) {
      throw new SheetError('Google has no sheet at that link. Check the link and the tab.', 404)
    }
    throw new SheetError(
      'That sheet is private. In Google Sheets: Share, General access, Anyone with the link, Viewer.',
      403,
    )
  }
  const csv = await res.text()
  if (csv.length > MAX_BYTES) throw new SheetError('That sheet is too large to import.', 413)
  const disp = res.headers.get('content-disposition') ?? ''
  const star = disp.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  let title: string | null = null
  try {
    title = star ? decodeURIComponent(star).replace(/\.csv$/i, '') : null
  } catch {
    title = null
  }
  return { csv, title, key: `${ref.id}:${ref.gid}` }
}
