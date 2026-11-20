/**
 * POST /api/sheet  { url }  ->  { csv, title, key }
 *
 * Reads a link-shared Google Sheet for the site-plan import. It has to happen
 * on the server: the browser cannot fetch docs.google.com from this origin
 * (no CORS on the export, and the site's own CSP connect-src forbids it).
 *
 * Managers only, same gate as the assistant: without it this would be a way
 * for anyone who knows the URL to have this server fetch things. What it can
 * fetch is narrow regardless (netlify/shared/sheetFetch.ts builds the Google
 * URL itself from a validated id).
 */

import { createClient } from '@supabase/supabase-js'
import { SheetError, fetchSheetCsv } from '../shared/sheetFetch'

const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ALLOWED_ROLES = new Set(['admin', 'campaign_manager'])

// The Capacitor shells call the live site cross-origin; the web app is
// same-origin. Same allowlist as chat.ts.
const ALLOWED_ORIGINS = new Set(['capacitor://localhost', 'https://localhost'])

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    vary: 'Origin',
  }
}

function json(body: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  })
}

export default async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405, cors)

  const header = req.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return json({ error: 'Sign in first.' }, 401, cors)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData?.user) return json({ error: 'Session expired. Sign in again.' }, 401, cors)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', userData.user.id).single()
  if (!profile || !ALLOWED_ROLES.has(profile.role)) {
    return json({ error: 'Importing a site plan is for campaign managers.' }, 403, cors)
  }

  let url = ''
  try {
    const body = (await req.json()) as { url?: unknown }
    url = typeof body.url === 'string' ? body.url : ''
  } catch {
    return json({ error: 'Bad request.' }, 400, cors)
  }

  try {
    return json(await fetchSheetCsv(url), 200, cors)
  } catch (e) {
    if (e instanceof SheetError) return json({ error: e.message }, e.status, cors)
    return json({ error: 'Could not read that sheet.' }, 500, cors)
  }
}

export const config = { path: '/api/sheet' }
