// Server-side proxy for the admin AI chat. The browser can't call
// api.anthropic.com directly (CORS + it would expose the key in client
// requests), so the frontend POSTs here and this function makes the real
// call — with tool use (read-only SQL, Google Maps, statistics) and
// Anthropic's server-side web search (billed to the same Anthropic key,
// no separate search API key needed).
//
// BUDGET CONSTRAINT: the admin's key has $5 of credit. Model must stay
// claude-haiku-4-5-20251001 (cheapest tier) and max_tokens conservative.
// Tool spend is capped at MAX_TOOL_CALLS client tool calls + MAX_SEARCHES
// web searches per user question, enforced here (the system prompt also
// tells the model its budget so it plans instead of exploring).
//
// TIME CONSTRAINT: Netlify's synchronous function timeout is ~10s on every
// plan. A 5-tool-call turn (especially with web search) cannot reliably fit
// in one invocation, so instead of degrading the answer at the deadline the
// function returns { continue: true, state } — the frontend immediately
// POSTs the state back and a fresh invocation (fresh 10s clock) picks up the
// loop exactly where it stopped. `state` is an opaque JSON blob of the
// in-progress Anthropic message array plus budget counters; tampering with
// it buys nothing the plain messages payload doesn't already allow.

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import * as ss from 'simple-statistics'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1600
const DEADLINE_MS = 8000
const TOOL_TIMEOUT_MS = 4000
/** Client tool calls (SQL/Maps/stats) allowed per user question, across continuations. */
const MAX_TOOL_CALLS = 5
/** Server-side web searches allowed per user question, across continuations. */
const MAX_SEARCHES = 3
/** Model rounds (API calls that advance the conversation) per question — loop backstop. */
const MAX_TOTAL_ROUNDS = 8
/** Below this remaining budget, don't start another model call — hand off instead. */
const MIN_ROUND_MS = 2600
/** Web search happens inside the API call and needs real headroom. */
const WEB_SEARCH_MIN_MS = 6000
/** Timed-out Anthropic calls retried (via continuation) before giving up. */
const MAX_API_RETRIES = 2
const STATE_MAX_CHARS = 2_000_000

const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? ''
// Shared demo key: used when the request doesn't carry a personal key, so
// anyone with AI-chat access can demo it without bringing their own.
const SHARED_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

/** All timestamp columns come back from query_database in UTC, so the browser
 * sends its current local time + IANA zone with every request and the prompt
 * is rebuilt per-request. Budget counters are baked in too so the model knows
 * how much it has left on continuation rounds. */
function buildSystemPrompt(
  timezone: string,
  localTime: string,
  toolCallsUsed: number,
  searchesUsed: number,
): string {
  return `You are Forcefield's built-in AI analyst. Forcefield is a door-to-door canvassing app for a UBI (universal basic income) petition campaign in Union County, Ohio — canvassers knock doors to collect petition signatures. You are talking to an org admin or campaign manager inside the app's AI chat.

## Style
- Lead with the answer, then the supporting numbers. Keep it tight — a few sentences or a short bullet list, not an essay.
- Formatting that renders here: **bold**, \`code\`, and "- " bullet lists. No markdown tables, no # headings.
- Percentages to 1 decimal; small counts stay exact.

## Tools — plan first, stay in budget
Hard limits per question, enforced by the server: ${MAX_TOOL_CALLS} tool calls total and ${MAX_SEARCHES} web searches. Used so far on this question: ${toolCallsUsed} tool calls, ${searchesUsed} searches.
- Decide what you need BEFORE calling anything: one well-joined SQL query beats three exploratory ones. The full schema is below — never query information_schema.
- No tools for greetings, general knowledge, or follow-ups answerable from data already in this conversation.
- Do exactly what was asked — no bonus queries, no tangents, no "while I'm at it" exploration. If the request is ambiguous, ask a clarifying question instead of burning tool calls on a guess.
- If you hit the budget, answer from what you have and say what's missing.

Tools:
- query_database: read-only SELECT, max 500 rows per call. Aggregate in SQL (COUNT, GROUP BY, date_trunc) rather than pulling raw rows.
- geocode_address / reverse_geocode / distance_between: Google Maps lookups and straight-line miles.
- compute_statistics: statistics (mean/median/correlation/regression/ckmeans/t-test…) over numbers you pulled with query_database — use it instead of doing math by hand on more than a handful of values.
- web_search: ONLY for outside or current information (news, weather, election rules, deadlines, general facts). Never for anything the database or Maps tools can answer. Mention the source name inline when you use it.

## Database schema (Postgres)
- addresses(id, street, unit, city, county, zip, lat, lng, turf_id -> turfs.id, registered_voter)
- persons(id, name, household_id -> addresses.id, voter_file_id, registered_voter)
- knock_logs(id, person_id -> persons.id, household_id -> addresses.id, canvasser_id -> profiles.id, occurred_at, outcome, notes) — outcome is one of 'signed','didnt_sign','maybe','not_home','skip','hostile'; join addresses on knock_logs.household_id = addresses.id for the address
- profiles(id, username, display_name, role, team_id -> teams.id, avatar, color) — role is canvasser / team_lead (displays "Squad Leader") / campaign_manager / admin
- teams(id, name, campaign_id -> campaigns.id)
- campaigns(id, name, description, is_active)
- squads(id, name, squad_date, chat_id, created_by)
- squad_members(squad_id -> squads.id, user_id -> profiles.id, joined_at)
- turfs(id, name, color, squad_id -> squads.id, assignee_id -> profiles.id, parent_turf_id -> turfs.id) — assigned to a squad OR one canvasser, never both; parent_turf_id set means it's a sub-turf carved from that parent
- household_knock_summary(household_id -> addresses.id, total_knocks, signed_count, didnt_sign_count, maybe_count, not_home_count, skip_count, hostile_count, reached) — view, one row per knocked household
- household_latest_knock(household_id -> addresses.id, outcome, occurred_at) — view, most recent knock per household
Private user-to-user chat messages are intentionally inaccessible to you, even via SQL — if asked about them, say so.

## Infographics
You can render charts. When a visual genuinely helps (comparing categories, a trend over time, an outcome breakdown, a KPI snapshot), embed ONE block formatted exactly like:
\`\`\`infographic
{"type":"bar","title":"Signatures by canvasser","data":[{"label":"Dana","value":34},{"label":"Marcus","value":28}]}
\`\`\`
- "type": "bar" (compare categories) | "line" (trend across ordered points) | "pie" (parts of a whole) | "stat" (2–4 headline numbers).
- "data": 2–8 points, each {"label": string, "value": number, "color": optional "#hex"}.
- When charting knock outcomes use their fixed app colors: signed #2e9e5b, didnt_sign #d64545, maybe #e0a02e, not_home #8a90a5, skip #b9bdcc, hostile #7a2e2e. Otherwise omit "color" and the app picks.
- Put the block on its own lines, add a one-line takeaway in prose, and don't re-list every number the chart already shows.
- Skip the chart when a sentence does the job or there's only one number. At most one block per reply.

## Time
The admin's current local time is ${localTime} (timezone: ${timezone}). Every timestamp column returned by query_database (occurred_at, created_at, joined_at) is stored in UTC — always convert to the admin's timezone before stating a time back to them, and note that it's local (e.g. "1:04 AM local time"). Never report a raw UTC timestamp as if it were their local time.`
}

interface ChatRequest {
  apiKey?: unknown
  messages?: unknown
  state?: unknown
  timezone?: unknown
  localTime?: unknown
}

interface WireMessage {
  role: 'user' | 'assistant'
  content: string
}

/** In-progress turn, round-tripped through the client between invocations. */
interface ChatState {
  /** Anthropic message array, including tool_use/tool_result blocks. */
  m: Anthropic.MessageParam[]
  /** Client tool calls used. */
  t: number
  /** Server-side web searches used. */
  s: number
  /** Model rounds completed. */
  r: number
  /** Anthropic-call timeouts retried. */
  x: number
  /** Human-readable activity log ("SQL: …", "Web search: …"). */
  a: string[]
}

class TimeoutError extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function continueJson(state: ChatState): Response {
  return json({ continue: true, state: JSON.stringify(state), activity: state.a })
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

/** Sanity-check a continuation blob. Content blocks aren't deep-validated —
 * the Anthropic API rejects malformed ones, and a tampered state can't do
 * anything the plain messages payload couldn't. */
function parseState(raw: unknown): ChatState | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > STATE_MAX_CHARS) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const { m, t, s, r, x, a } = obj as Record<string, unknown>
  const isCount = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100
  if (!Array.isArray(m) || m.length === 0 || m.length > 400) return null
  if (![t, s, r, x].every(isCount)) return null
  if (!Array.isArray(a) || a.length > 60 || !a.every((v) => typeof v === 'string' && v.length <= 300))
    return null
  const rolesOk = m.every(
    (msg) =>
      msg &&
      typeof msg === 'object' &&
      ((msg as { role?: unknown }).role === 'user' || (msg as { role?: unknown }).role === 'assistant') &&
      'content' in (msg as object),
  )
  if (!rolesOk) return null
  return {
    m: m as Anthropic.MessageParam[],
    t: t as number,
    s: s as number,
    r: r as number,
    x: x as number,
    a: a as string[],
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out`)), ms)
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

/** Anthropic-hosted web search — executes inside the API call on their infra,
 * billed to the same API key. Basic variant: Haiku 4.5 doesn't support the
 * newer dynamic-filtering (_20260209) tool versions. */
function webSearchTool(remainingUses: number): Anthropic.Messages.ToolUnion {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: Math.max(1, remainingUses),
  }
}

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

/** One human-readable line per tool call, shown to the admin as activity
 * chips — transparency about exactly what the assistant did. */
function activityLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'query_database': {
      const sql = String(input.sql ?? '').replace(/\s+/g, ' ').trim()
      return `SQL: ${sql.length > 110 ? `${sql.slice(0, 110)}…` : sql}`
    }
    case 'geocode_address':
      return `Geocoded: ${String(input.address ?? '')}`.slice(0, 120)
    case 'reverse_geocode':
      return 'Reverse-geocoded a point'
    case 'distance_between':
      return 'Measured a distance'
    case 'compute_statistics':
      return `Stats: ${String(input.operation ?? '')}`
    default:
      return `Tool: ${name}`
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

  const { apiKey, messages: rawMessages, state: rawState, timezone: rawTimezone, localTime: rawLocalTime } = body
  // A personal key saved in Settings still wins; otherwise fall back to the
  // shared demo key configured on the Netlify site (ANTHROPIC_API_KEY). The
  // shared key never leaves the server — demo users just get working chat.
  const personalKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  const effectiveKey = personalKey || SHARED_ANTHROPIC_KEY
  if (!effectiveKey) {
    return json({ error: 'Missing API key — add it in Settings.' }, 400)
  }

  // Either a continuation of an in-progress turn, or a fresh turn.
  let state: ChatState | null = null
  if (rawState != null) {
    state = parseState(rawState)
    if (!state) return json({ error: 'Invalid continuation state' }, 400)
  } else if (isValidMessages(rawMessages)) {
    state = {
      m: rawMessages.map((m) => ({ role: m.role, content: m.content })),
      t: 0,
      s: 0,
      r: 0,
      x: 0,
      a: [],
    }
  } else {
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

  try {
    for (;;) {
      const timeLeft = DEADLINE_MS - (Date.now() - started)
      const canTool = state.t < MAX_TOOL_CALLS
      const canSearch = state.s < MAX_SEARCHES
      const offerTools = state.r < MAX_TOTAL_ROUNDS && (canTool || canSearch)

      // Not enough wall clock left in this invocation for another model call
      // — hand the loop to a fresh invocation instead of degrading the answer.
      if (timeLeft < MIN_ROUND_MS) return continueJson(state)
      // Web search runs inside the API call and needs real headroom. Mid-turn
      // (r > 0) a fresh invocation is one cheap round trip away, so prefer
      // that over silently offering a search-less round.
      if (offerTools && canSearch && state.r > 0 && timeLeft < WEB_SEARCH_MIN_MS) {
        return continueJson(state)
      }

      const tools: Anthropic.Messages.ToolUnion[] = []
      if (offerTools && canTool) tools.push(...TOOLS)
      if (offerTools && canSearch && timeLeft >= WEB_SEARCH_MIN_MS) {
        tools.push(webSearchTool(MAX_SEARCHES - state.s))
      }

      let response: Anthropic.Message
      try {
        response = await withTimeout(
          client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: buildSystemPrompt(timezone, localTime, state.t, state.s),
            messages: state.m,
            ...(tools.length ? { tools } : {}),
          }),
          Math.max(1500, timeLeft - 300),
          'anthropic',
        )
      } catch (err) {
        if (err instanceof TimeoutError) {
          state.x++
          if (state.x > MAX_API_RETRIES) {
            return json({ error: 'The model kept timing out — try again, or ask a narrower question.' }, 504)
          }
          return continueJson(state) // retry the same round on a fresh clock
        }
        throw err
      }

      state.r++

      // Server-side web searches already ran inside that API call — count
      // them against the budget and log them for the activity trace.
      for (const block of response.content) {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          state.s++
          const q = (block.input as { query?: unknown } | null)?.query
          state.a.push(`Web search: “${typeof q === 'string' ? q.slice(0, 90) : '…'}”`)
        }
      }

      // Server tool loop paused mid-work (e.g. long search) — resend as-is.
      if (response.stop_reason === 'pause_turn') {
        state.m.push({ role: 'assistant', content: response.content })
        continue
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        return json({ text: text || '(empty response)', activity: state.a })
      }

      state.m.push({ role: 'assistant', content: response.content })

      // Execute up to the remaining budget; anything past it gets an error
      // result so the protocol stays valid and the model wraps up.
      const remaining = Math.max(0, MAX_TOOL_CALLS - state.t)
      const allowed = toolUses.slice(0, remaining)
      const denied = toolUses.slice(allowed.length)
      state.t += allowed.length
      for (const tu of allowed) {
        state.a.push(activityLabel(tu.name, tu.input as Record<string, unknown>))
      }

      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        allowed.map(async (tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: await executeTool(tu.name, tu.input as Record<string, unknown>),
        })),
      )
      for (const tu of denied) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify({
            error: `Tool budget exhausted (${MAX_TOOL_CALLS} per question) — answer with what you have.`,
          }),
          is_error: true,
        })
      }
      state.m.push({ role: 'user', content: results })
    }
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
