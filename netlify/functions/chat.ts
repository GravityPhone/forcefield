// Server-side proxy for the admin AI chat. The browser can't call
// api.anthropic.com directly (CORS + it would expose the key in client
// requests), so the frontend POSTs { apiKey, messages } here and this
// function makes the real call — now with tool use, so the assistant can
// read live canvassing data and use Google Maps.
//
// BUDGET CONSTRAINT: the admin's key has $5 of credit. Model must stay
// claude-haiku-4-5-20251001 (cheapest tier) and max_tokens conservative.
//
// TIME CONSTRAINT: Netlify's synchronous function timeout is ~10s on every
// plan (not just free) — a multi-round tool-use loop can blow past that if
// left unbounded. DEADLINE_MS below tracks elapsed wall-clock time; once
// it's gone, the final round drops the `tools` param entirely, which forces
// Claude to answer immediately from whatever it already fetched instead of
// requesting another round trip. That keeps every response under Netlify's
// limit regardless of plan.

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024
const MAX_ROUNDS = 4
const DEADLINE_MS = 8000
const TOOL_TIMEOUT_MS = 4000

const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? ''

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const SYSTEM_PROMPT =
  'You are the AI assistant inside Forcefield, a door-to-door canvassing app for a ' +
  'UBI (universal basic income) campaign, talking to an org admin. You have tools to ' +
  'query the live canvassing database (addresses, persons, knock logs and their ' +
  'outcomes/timestamps, canvasser profiles) and to geocode addresses / compute ' +
  'distances via Google Maps. Private user-to-user chat messages are intentionally ' +
  'not accessible to you, even via the database tool — if asked about them, say so. ' +
  'The database tool only accepts read-only SELECT queries (writes are rejected) and ' +
  'is capped at 500 rows per call — aggregate with COUNT/GROUP BY server-side rather ' +
  'than pulling raw rows when you can. Table names: addresses, persons, knock_logs ' +
  '(columns: id, person_id, household_id, canvasser_id, occurred_at, outcome, notes — ' +
  "outcome is one of 'signed','didnt_sign','maybe','not_home','skip','hostile'), " +
  'profiles (id, username, display_name, role, team_id), household_knock_summary ' +
  '(household_id, total_knocks, signed_count, and other per-outcome counts, reached). ' +
  'Be concise — this runs on a tight time budget, so answer directly rather than ' +
  'running many exploratory queries.'

interface ChatRequest {
  apiKey?: unknown
  messages?: unknown
}

interface WireMessage {
  role: 'user' | 'assistant'
  content: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function isValidMessages(value: unknown): value is WireMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0,
    ) &&
    value[0].role === 'user'
  )
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

// --- Tools ---

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'query_database',
    description:
      'Run a read-only SQL SELECT query against the canvassing database. Writes of any ' +
      'kind are rejected by the database itself. Results are capped at 500 rows.',
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single SELECT statement.' } },
      required: ['sql'],
    },
  },
  {
    name: 'geocode_address',
    description: 'Look up latitude/longitude for a street address via Google Maps.',
    input_schema: {
      type: 'object',
      properties: { address: { type: 'string' } },
      required: ['address'],
    },
  },
  {
    name: 'reverse_geocode',
    description: 'Look up the street address at a given latitude/longitude via Google Maps.',
    input_schema: {
      type: 'object',
      properties: { lat: { type: 'number' }, lng: { type: 'number' } },
      required: ['lat', 'lng'],
    },
  },
  {
    name: 'distance_between',
    description: 'Straight-line distance in miles between two lat/lng points.',
    input_schema: {
      type: 'object',
      properties: {
        lat1: { type: 'number' },
        lng1: { type: 'number' },
        lat2: { type: 'number' },
        lng2: { type: 'number' },
      },
      required: ['lat1', 'lng1', 'lat2', 'lng2'],
    },
  },
]

async function runQueryDatabase(sql: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc('ai_readonly_query', { query: sql })
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify(data)
}

async function runGeocodeAddress(address: string): Promise<string> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${MAPS_KEY}`
  const res = await fetch(url)
  const data = (await res.json()) as {
    status: string
    results?: { geometry: { location: { lat: number; lng: number } }; formatted_address: string }[]
  }
  if (data.status !== 'OK' || !data.results?.length) {
    return JSON.stringify({ error: `Geocoding failed: ${data.status}` })
  }
  const top = data.results[0]
  return JSON.stringify({
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    formatted_address: top.formatted_address,
  })
}

async function runReverseGeocode(lat: number, lng: number): Promise<string> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY}`
  const res = await fetch(url)
  const data = (await res.json()) as { status: string; results?: { formatted_address: string }[] }
  if (data.status !== 'OK' || !data.results?.length) {
    return JSON.stringify({ error: `Reverse geocoding failed: ${data.status}` })
  }
  return JSON.stringify({ formatted_address: data.results[0].formatted_address })
}

function runDistanceBetween(lat1: number, lng1: number, lat2: number, lng2: number): string {
  const R = 3958.8 // Earth radius, miles
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return JSON.stringify({ miles: Math.round(miles * 100) / 100 })
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'query_database':
        return await withTimeout(runQueryDatabase(String(input.sql)), TOOL_TIMEOUT_MS, name)
      case 'geocode_address':
        return await withTimeout(runGeocodeAddress(String(input.address)), TOOL_TIMEOUT_MS, name)
      case 'reverse_geocode':
        return await withTimeout(
          runReverseGeocode(Number(input.lat), Number(input.lng)),
          TOOL_TIMEOUT_MS,
          name,
        )
      case 'distance_between':
        return runDistanceBetween(
          Number(input.lat1),
          Number(input.lng1),
          Number(input.lat2),
          Number(input.lng2),
        )
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : 'Tool call failed' })
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { apiKey, messages: rawMessages } = body
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return json({ error: 'Missing API key — add it in Settings.' }, 400)
  }
  if (!isValidMessages(rawMessages)) {
    return json({ error: 'Invalid messages payload' }, 400)
  }

  // Pin the base URL explicitly — don't inherit ANTHROPIC_BASE_URL from the
  // function's environment. This is a BYO-key proxy for the admin's own
  // Anthropic account; it must always talk to the real public API.
  const client = new Anthropic({ apiKey: apiKey.trim(), baseURL: 'https://api.anthropic.com' })

  const started = Date.now()
  const messages: Anthropic.MessageParam[] = rawMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const timeLeft = DEADLINE_MS - (Date.now() - started)
      const useTools = timeLeft > TOOL_TIMEOUT_MS // no time left for another round trip

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        ...(useTools ? { tools: TOOLS } : {}),
      })

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        return json({ text: text || '(empty response)' })
      }

      messages.push({ role: 'assistant', content: response.content })
      const results = await Promise.all(
        toolUses.map(async (tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: await executeTool(tu.name, tu.input as Record<string, unknown>),
        })),
      )
      messages.push({ role: 'user', content: results })
    }

    return json({ text: 'Ran out of time gathering data — try a more specific question.' })
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return json({ error: 'Invalid API key — check it in Settings.' }, 401)
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: 'Rate limited by Anthropic — try again in a moment.' }, 429)
    }
    if (err instanceof Anthropic.BadRequestError) {
      return json({ error: `Anthropic rejected the request: ${err.message}` }, 400)
    }
    if (err instanceof Anthropic.APIError) {
      return json({ error: `Anthropic error: ${err.message}` }, 502)
    }
    return json({ error: 'Unexpected server error.' }, 500)
  }
}

export const config = { path: '/api/chat' }
