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
import * as ss from 'simple-statistics'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024
const MAX_ROUNDS = 4
const DEADLINE_MS = 8000
const TOOL_TIMEOUT_MS = 4000

const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? ''
// Shared demo key: used when the request doesn't carry a personal key, so
// anyone with AI-chat access can demo it without bringing their own.
const SHARED_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

/** All timestamp columns (occurred_at, created_at) come back from
 * query_database in UTC — Postgres's timestamptz is correctly stored and
 * queried in UTC, that part isn't the bug. Without this, the model has no
 * way to know the admin isn't also in UTC and will just repeat the raw
 * value, which reads as hours off from what actually happened locally. The
 * browser sends its current local time + IANA zone with every request so
 * this can be rebuilt per-request instead of baked in once. */
function buildSystemPrompt(timezone: string, localTime: string): string {
  return (
    'You are the AI assistant inside Forcefield, a door-to-door canvassing app for a ' +
    'UBI (universal basic income) campaign, talking to an org admin. You have tools to ' +
    'query the live canvassing database and to geocode addresses / compute distances via ' +
    'Google Maps. Private user-to-user chat messages are intentionally not accessible to ' +
    'you, even via the database tool — if asked about them, say so. The database tool ' +
    'only accepts read-only SELECT queries (writes are rejected) and is capped at 500 ' +
    'rows per call — aggregate with COUNT/GROUP BY server-side rather than pulling raw ' +
    'rows when you can. This runs on a tight time budget: get the schema right on the ' +
    'first query rather than exploring with information_schema, and prefer one joined ' +
    'query over several round trips. Schema:\n' +
    '- addresses(id, street, unit, city, county, zip, lat, lng, turf_id, registered_voter)\n' +
    '- persons(id, name, household_id -> addresses.id, voter_file_id, registered_voter)\n' +
    '- knock_logs(id, person_id -> persons.id, household_id -> addresses.id, ' +
    'canvasser_id -> profiles.id, occurred_at, outcome, notes) — outcome is one of ' +
    "'signed','didnt_sign','maybe','not_home','skip','hostile'; to get the address for a " +
    'knock, join addresses on knock_logs.household_id = addresses.id\n' +
    '- profiles(id, username, display_name, role, team_id) — role is ' +
    'canvasser/team_lead/campaign_manager/admin (team_lead displays as "Squad Leader")\n' +
    '- household_knock_summary(household_id -> addresses.id, total_knocks, signed_count, ' +
    'didnt_sign_count, maybe_count, not_home_count, skip_count, hostile_count, reached)\n' +
    '- household_latest_knock(household_id -> addresses.id, outcome, occurred_at)\n\n' +
    'For statistical questions (trends, correlation, regression, clustering), pull the raw ' +
    'numbers with query_database first, then pass them to compute_statistics rather than ' +
    'computing by hand.\n\n' +
    `The admin's current local time is ${localTime} (timezone: ${timezone}). Every ` +
    'timestamp column returned by query_database (occurred_at, created_at) is stored in ' +
    "UTC — always convert to the admin's timezone above before stating a time back to " +
    'them, and note that it\'s local (e.g. "1:04 AM local time") rather than repeating ' +
    'the raw UTC value. Never report a raw UTC timestamp as if it were their local time.'
  )
}

interface ChatRequest {
  apiKey?: unknown
  messages?: unknown
  timezone?: unknown
  localTime?: unknown
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

// The Capacitor apps run the same frontend from a local webview origin, so
// their requests arrive cross-origin (the web app is same-origin and sends
// no Origin header worth matching). Only the shell origins are allowed.
const ALLOWED_ORIGINS = new Set([
  'capacitor://localhost', // iOS shell
  'https://localhost', // Android shell (androidScheme: https)
])

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  }
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
  {
    name: 'compute_statistics',
    description:
      'Run a statistical computation over numeric data pulled via query_database. ' +
      "Single-array operations (use `values`): mean, median, mode, min, max, sum, variance, " +
      "standardDeviation, quantile (needs `param` in [0,1]), interquartileRange, skewness, " +
      "kurtosis, geometricMean, harmonicMean, coefficientOfVariation, ckmeans (needs `param` " +
      "= number of clusters, returns each cluster's values). Two-array operations (use " +
      "`values` and `values2`, same length, paired by index): correlation, linearRegression " +
      '(returns slope m, intercept b, and rSquared), tTestTwoSample.',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'mean',
            'median',
            'mode',
            'min',
            'max',
            'sum',
            'variance',
            'standardDeviation',
            'quantile',
            'interquartileRange',
            'skewness',
            'kurtosis',
            'geometricMean',
            'harmonicMean',
            'coefficientOfVariation',
            'ckmeans',
            'correlation',
            'linearRegression',
            'tTestTwoSample',
          ],
        },
        values: { type: 'array', items: { type: 'number' } },
        values2: { type: 'array', items: { type: 'number' } },
        param: { type: 'number' },
      },
      required: ['operation', 'values'],
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

function runComputeStatistics(
  operation: string,
  values: number[],
  values2: number[] | undefined,
  param: number | undefined,
): string {
  if (!values.length) return JSON.stringify({ error: 'values is empty' })
  switch (operation) {
    case 'mean':
      return JSON.stringify({ result: ss.mean(values) })
    case 'median':
      return JSON.stringify({ result: ss.median(values) })
    case 'mode':
      return JSON.stringify({ result: ss.mode(values) })
    case 'min':
      return JSON.stringify({ result: ss.min(values) })
    case 'max':
      return JSON.stringify({ result: ss.max(values) })
    case 'sum':
      return JSON.stringify({ result: ss.sum(values) })
    case 'variance':
      return JSON.stringify({ result: ss.variance(values) })
    case 'standardDeviation':
      return JSON.stringify({ result: ss.standardDeviation(values) })
    case 'quantile':
      if (param == null) return JSON.stringify({ error: 'quantile needs param in [0,1]' })
      return JSON.stringify({ result: ss.quantile(values, param) })
    case 'interquartileRange':
      return JSON.stringify({ result: ss.interquartileRange(values) })
    case 'skewness':
      return JSON.stringify({ result: ss.sampleSkewness(values) })
    case 'kurtosis':
      return JSON.stringify({ result: ss.sampleKurtosis(values) })
    case 'geometricMean':
      return JSON.stringify({ result: ss.geometricMean(values) })
    case 'harmonicMean':
      return JSON.stringify({ result: ss.harmonicMean(values) })
    case 'coefficientOfVariation':
      return JSON.stringify({ result: ss.coefficientOfVariation(values) })
    case 'ckmeans':
      if (param == null) return JSON.stringify({ error: 'ckmeans needs param = cluster count' })
      return JSON.stringify({ clusters: ss.ckmeans(values, param) })
    case 'correlation':
      if (!values2?.length) return JSON.stringify({ error: 'correlation needs values2' })
      return JSON.stringify({ result: ss.sampleCorrelation(values, values2) })
    case 'linearRegression': {
      if (!values2?.length) return JSON.stringify({ error: 'linearRegression needs values2' })
      const pairs: [number, number][] = values.map((x, i) => [x, values2[i]])
      const line = ss.linearRegression(pairs)
      return JSON.stringify({ ...line, rSquared: ss.rSquared(pairs, ss.linearRegressionLine(line)) })
    }
    case 'tTestTwoSample':
      if (!values2?.length) return JSON.stringify({ error: 'tTestTwoSample needs values2' })
      return JSON.stringify({ result: ss.tTestTwoSample(values, values2) })
    default:
      return JSON.stringify({ error: `Unknown operation: ${operation}` })
  }
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
      case 'compute_statistics':
        return runComputeStatistics(
          String(input.operation),
          (input.values as number[]) ?? [],
          input.values2 as number[] | undefined,
          input.param as number | undefined,
        )
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : 'Tool call failed' })
  }
}

export default async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  const res = await handleChat(req)
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
  return res
}

async function handleChat(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { apiKey, messages: rawMessages, timezone: rawTimezone, localTime: rawLocalTime } = body
  // A personal key saved in Settings still wins; otherwise fall back to the
  // shared demo key configured on the Netlify site (ANTHROPIC_API_KEY). The
  // shared key never leaves the server — demo users just get working chat.
  const personalKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  const effectiveKey = personalKey || SHARED_ANTHROPIC_KEY
  if (!effectiveKey) {
    return json({ error: 'Missing API key — add it in Settings.' }, 400)
  }
  if (!isValidMessages(rawMessages)) {
    return json({ error: 'Invalid messages payload' }, 400)
  }

  // The browser's IANA zone name and current local clock reading — both
  // best-effort, so a bad/missing value just falls back to UTC rather than
  // rejecting the request.
  let timezone = 'UTC'
  if (typeof rawTimezone === 'string' && rawTimezone.length < 100) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: rawTimezone })
      timezone = rawTimezone
    } catch {
      // invalid IANA name — keep the UTC fallback
    }
  }
  const localTime =
    typeof rawLocalTime === 'string' && rawLocalTime.length < 100 ? rawLocalTime : 'unknown'

  // Pin the base URL explicitly — don't inherit ANTHROPIC_BASE_URL from the
  // function's environment. Whether BYO or the shared demo key, this must
  // always talk to the real public API.
  const client = new Anthropic({ apiKey: effectiveKey, baseURL: 'https://api.anthropic.com' })

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
        system: buildSystemPrompt(timezone, localTime),
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
