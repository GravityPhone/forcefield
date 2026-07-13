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
/** The AI assistant is a managers-only tool. */
const ALLOWED_ROLES = new Set(['admin', 'campaign_manager'])
/** Caps on a fresh (non-continuation) messages payload — a size backstop the
 * continuation path already has (parseState). */
const MAX_MESSAGE_CHARS = 8000
const MAX_MESSAGES = 60

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
  requester: RequesterInfo | null,
): string {
  const requesterLine = requester
    ? `You are talking to @${requester.username} (role: ${requester.role}${requester.id ? `, profiles.id ${requester.id}` : ''}) inside the app's AI chat — when they say "me" or "my", that's who they mean.`
    : "You are talking to an org admin or campaign manager inside the app's AI chat."
  return `You are Forcefield's built-in AI analyst. Forcefield is a door-to-door canvassing app for a UBI (universal basic income) petition campaign in Union County, Ohio — canvassers knock doors to collect petition signatures. ${requesterLine}

## Style
- Lead with the answer, then the supporting numbers. Keep it tight — a few sentences or a short bullet list, not an essay.
- Formatting that renders here: **bold**, \`code\`, and "- " bullet lists. No markdown tables, no # headings.
- Percentages to 1 decimal; small counts stay exact.

## Tools — plan first, stay in budget
Hard limits per question, enforced by the server: ${MAX_TOOL_CALLS} tool calls total and ${MAX_SEARCHES} web searches. Used so far on this question: ${toolCallsUsed} tool calls, ${searchesUsed} searches.
- Decide what you need BEFORE calling anything: one well-joined SQL query beats three exploratory ones. The full schema is below — never query information_schema.
- No tools for greetings, general knowledge, or follow-ups answerable from data already in this conversation.
- Do exactly what was asked — no bonus queries, no tangents, no "while I'm at it" exploration. If the request is ambiguous, ask a clarifying question instead of burning tool calls on a guess.
- Timeframes: if the question doesn't name one, use ALL-TIME. Never add a date filter (WHERE occurred_at >= …) the admin didn't ask for — and if you do scope by time, say so in the answer.
- If a result looks surprisingly sparse or empty, sanity-check with an unfiltered COUNT(*) before concluding the data is thin — a wrong filter looks exactly like an empty campaign.
- If you hit the budget, answer from what you have and say what's missing.

Tools:
- query_database: read-only SELECT, max 500 rows per call. Aggregate in SQL (COUNT, GROUP BY, date_trunc) rather than pulling raw rows.
- geocode_address / reverse_geocode / distance_between: Google Maps lookups and straight-line miles.
- compute_statistics: statistics (mean/median/correlation/regression/ckmeans/t-test…) over numbers you pulled with query_database — use it instead of doing math by hand on more than a handful of values.
- find_door_clusters: geographic hotspots straight from door coordinates — where doors of a kind sit close together. Modes: a latest-outcome value, 'knocked', or 'unknocked'; tune radius_m (default 300m) / min_doors / limit.
- web_search: ONLY for outside or current information (news, weather, election rules, deadlines, general facts). Never for anything the database or Maps tools can answer. Mention the source name inline when you use it.

## Database schema (Postgres)
- addresses(id, street, unit, city, county, zip, lat, lng, turf_id -> turfs.id, registered_voter)
- persons(id, name, household_id -> addresses.id, voter_file_id, registered_voter)
- knock_logs(id, person_id -> persons.id, household_id -> addresses.id, canvasser_id -> profiles.id, occurred_at, outcome, notes) — outcome is one of 'signed','didnt_sign','maybe','not_home','skip','hostile'; join addresses on knock_logs.household_id = addresses.id for the address
- profiles(id, username, display_name, role, team_id -> teams.id, avatar, color) — role is canvasser / team_lead (displays "Squad Leader") / campaign_manager / admin. display_name is usually NULL: always select coalesce(display_name, username) AS name and refer to people as @username — every account has a username, so never claim names are unavailable.
- teams(id, name, campaign_id -> campaigns.id)
- campaigns(id, name, description, is_active)
- squads(id, name, squad_date, chat_id, created_by)
- squad_members(squad_id -> squads.id, user_id -> profiles.id, joined_at)
- turfs(id, name, color, squad_id -> squads.id, assignee_id -> profiles.id, parent_turf_id -> turfs.id) — assigned to a squad OR one canvasser, never both; parent_turf_id set means it's a sub-turf carved from that parent. Squads last ONE DAY (squad_date), turf is durable: squad_id is the CURRENT dispatch, re-pointed to a new squad each morning
- turf_assignments(turf_id -> turfs.id, squad_id -> squads.id, squad_name, assignee_id -> profiles.id, assigned_on, assigned_by, created_at) — append-only dispatch history: which crew a turf was sent to on which day (squad_name snapshotted at assignment; a row with both squad_id and assignee_id NULL records the turf being pulled back). Use it for "which crews worked turf X" / "what did squad Y work over the week"
- canvasser_leaderboard(canvasser_id, username, display_name, doors_knocked, signatures) — view, all-time per-canvasser totals; zero-knock canvassers included. CAUTION: doors_knocked counts knock EVENTS despite the name, not distinct doors. The go-to for "best performers" / leaderboard questions: ORDER BY signatures DESC.
- household_knock_summary(household_id -> addresses.id, total_knocks, signed_count, didnt_sign_count, maybe_count, not_home_count, skip_count, hostile_count, reached) — view, one row per knocked HOUSEHOLD; reached = any outcome besides not_home
- household_latest_knock(household_id -> addresses.id, outcome, occurred_at) — view, each knocked door's MOST RECENT outcome — a door's current status, and what the app's map pins show

## Interpreting canvassing questions
The counting words in a question map to different SQL — pick deliberately, and say which you counted:
- A "knock" = one knock_logs row (an event — doors get revisited). A "door"/"household" = COUNT(DISTINCT household_id). A "signature" = a knock_logs row with outcome 'signed'. For time-scoped or distinct-door splits the leaderboard view can't answer, aggregate knock_logs yourself.
- Past activity vs current status: "how many signatures have we collected" → count knock_logs events; "how many doors ARE signed / still need a visit" → household_latest_knock (current state = latest outcome). Never count activity from household_* views — they collapse repeat visits.
- person_id on a knock is optional in practice: signed/didnt_sign/maybe usually have one, not_home/skip/hostile usually don't, but neither is guaranteed — LEFT JOIN persons and tolerate NULLs ("who signed" may include a few knocks with no person recorded).
- Progress/coverage = knocked doors vs ALL addresses in scope. Scale: ~22.7k imported addresses, ~43.5k persons, and most doors have never been knocked — a huge unknocked count is normal, not missing data. Unworked doors in a turf = addresses WHERE turf_id = … with no row in household_latest_knock (add latest outcome 'not_home' for revisit lists).
- lat/lng are NULL until a door gets geocoded (currently ~93% of addresses) — never filter on them except for map math. persons.registered_voter is true for the whole imported voter file — don't filter on it unless asked.
- "Where / which areas" questions (hotspots, dense pockets, where to send people, good revisit zones): call find_door_clusters. Geography lives in addresses.lat/lng — turfs are OPTIONAL admin labels, and knocked doors are often outside any turf, so NEVER answer "can't tell, no turfs defined" or group by turf unless the admin asked about turfs. Then reverse_geocode the best cluster's center to name the spot ("the W 5th St area in Marysville"), and mention how many candidate doors were invisible for lack of coordinates.
- Turf rollups: sub-turfs OWN their doors (addresses.turf_id points at the sub-turf), so a parent turf's direct count excludes doors carved into children — include turfs WHERE parent_turf_id = parent to cover the whole area. "How's squad X doing" can mean knocks by its members (via squad_members) or progress on its turf (turfs WHERE squad_id) — match the wording.
- Rates: contact rate = knocks with outcome IN ('signed','didnt_sign','maybe') / all knocks; conversion = signed / contacted. Guard every denominator with NULLIF(…, 0).
- Timeframe filters (only when the admin names one): occurred_at is UTC, so compare in their zone — "today" is (occurred_at AT TIME ZONE '${timezone}')::date = (now() AT TIME ZONE '${timezone}')::date. Never occurred_at::date or current_date alone (those are UTC days and will slice the day wrong).

## Shaping the answer
- Match the question's shape: a number question gets the number first, then a line or two of context; "how are we doing" gets the topline (signatures, doors knocked, contact rate, top canvasser), not a data dump; "who/best" questions name people as @username with their numbers.
- Always say in a few words what scope you used (all-time vs a window, campaign-wide vs one turf).
- If two readings differ materially, answer the likelier one and flag the other in one clause (e.g. "counting distinct doors — say the word if you want raw knocks").
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
  user?: unknown
}

/** Who's on the other end of the chat — resolved from the verified Supabase
 * session (see authorizeRequest), never from the request body. */
interface RequesterInfo {
  id: string
  username: string
  role: string
}

type AuthResult = { profile: RequesterInfo } | { error: string; status: number }

/** Gate the endpoint: require a valid Supabase access token whose account is a
 * manager. Without this the tool loop (read-only SQL over the whole database,
 * Maps + web search on the server's keys) would be reachable by anyone who
 * knows the URL. Identity/role come from the verified JWT, not the payload. */
async function authorizeRequest(req: Request): Promise<AuthResult> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return { error: 'Sign in to use the assistant.', status: 401 }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !userData?.user) return { error: 'Session expired — sign in again.', status: 401 }

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('id, username, role')
    .eq('id', userData.user.id)
    .single()
  if (profErr || !profile) return { error: 'No profile found for this account.', status: 403 }
  if (!ALLOWED_ROLES.has(profile.role)) {
    return { error: 'The AI assistant is available to campaign managers and admins only.', status: 403 }
  }
  return { profile: profile as RequesterInfo }
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
    value.length <= MAX_MESSAGES &&
    value.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0 &&
        m.content.length <= MAX_MESSAGE_CHARS,
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
    name: 'find_door_clusters',
    description:
      'Find geographic hotspots of doors — groups of addresses near each other — from stored ' +
      'coordinates. Turfs are NOT involved; this is pure geography. Call it for any "which ' +
      'areas / where should we send people / dense pockets of X" question. mode picks the ' +
      "doors: a latest-outcome value ('not_home', 'signed', 'maybe', 'didnt_sign', 'skip', " +
      "'hostile'), 'knocked' (any latest outcome), or 'unknocked' (never visited). Returns the " +
      'top clusters (door count, center lat/lng, most-common streets) plus how many candidate ' +
      'doors lack coordinates. Follow up with reverse_geocode on the best center to name the area.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['not_home', 'signed', 'maybe', 'didnt_sign', 'skip', 'hostile', 'knocked', 'unknocked'],
        },
        radius_m: {
          type: 'number',
          description: 'Approximate cluster radius in meters (default 300, max 2000).',
        },
        min_doors: { type: 'number', description: 'Minimum doors for a cluster to count (default 3).' },
        limit: { type: 'number', description: 'Max clusters to return (default 5, max 10).' },
      },
      required: ['mode'],
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

const CLUSTER_OUTCOMES = new Set(['signed', 'didnt_sign', 'maybe', 'not_home', 'skip', 'hostile'])

interface ClusterDoor {
  id: string
  lat: number
  lng: number
  street: string | null
}

/** addresses.street holds the full house-number line ("1037 WATKINS GLEN CT")
 * — strip the leading number so clusters group by actual street name. */
function streetName(street: string): string {
  const stripped = street.replace(/^\s*\d[\w/-]*\s+/, '').trim()
  return stripped || street
}

/** PostgREST `.in()` rides the URL, so chunk large id lists. */
async function fetchAddressesByIds(ids: string[]): Promise<ClusterDoor[]> {
  const out: ClusterDoor[] = []
  for (let i = 0; i < ids.length && i < 3000; i += 150) {
    const { data, error } = await supabaseAdmin
      .from('addresses')
      .select('id, lat, lng, street')
      .in('id', ids.slice(i, i + 150))
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as ClusterDoor[]))
  }
  return out
}

/** Grid-bin doors by lat/lng (cell ≈ radius), score each cell with its 3×3
 * neighborhood so clusters straddling a cell edge still read as one hotspot,
 * then greedily pick non-overlapping tops. Pure geography — turfs never
 * enter into it. Queries here are fixed app code (not model-written SQL),
 * so the ai_readonly_query write-blocking isn't being bypassed in spirit. */
async function runFindDoorClusters(
  mode: string,
  radiusRaw?: number,
  minDoorsRaw?: number,
  limitRaw?: number,
): Promise<string> {
  if (!CLUSTER_OUTCOMES.has(mode) && mode !== 'knocked' && mode !== 'unknocked') {
    return JSON.stringify({ error: `Unknown mode: ${mode}` })
  }
  const radius = Math.min(2000, Math.max(50, Number.isFinite(radiusRaw) ? Number(radiusRaw) : 300))
  const minDoors = Math.min(50, Math.max(1, Math.round(Number.isFinite(minDoorsRaw) ? Number(minDoorsRaw) : 3)))
  const limit = Math.min(10, Math.max(1, Math.round(Number.isFinite(limitRaw) ? Number(limitRaw) : 5)))

  let doors: ClusterDoor[]
  let totalCandidates: number
  let fetchCapped = false

  if (mode === 'unknocked') {
    const { data: knockedRows, error: e1 } = await supabaseAdmin
      .from('household_latest_knock')
      .select('household_id')
    if (e1) return JSON.stringify({ error: e1.message })
    const knocked = new Set((knockedRows ?? []).map((r) => String(r.household_id)))
    const { count: totalAddresses } = await supabaseAdmin
      .from('addresses')
      .select('id', { count: 'exact', head: true })
    const { data: geocoded, error: e2 } = await supabaseAdmin
      .from('addresses')
      .select('id, lat, lng, street')
      .not('lat', 'is', null)
      .limit(8000)
    if (e2) return JSON.stringify({ error: e2.message })
    fetchCapped = (geocoded ?? []).length === 8000
    doors = ((geocoded ?? []) as ClusterDoor[]).filter((a) => !knocked.has(a.id))
    totalCandidates = Math.max(0, (totalAddresses ?? 0) - knocked.size)
  } else {
    const { data: latest, error } = await supabaseAdmin
      .from('household_latest_knock')
      .select('household_id, outcome')
    if (error) return JSON.stringify({ error: error.message })
    const wanted = (latest ?? []).filter((r) => (mode === 'knocked' ? true : r.outcome === mode))
    totalCandidates = wanted.length
    const addrs = wanted.length
      ? await fetchAddressesByIds(wanted.map((r) => String(r.household_id)))
      : []
    doors = addrs.filter((a) => a.lat != null && a.lng != null)
  }

  const withCoords = doors.length
  const withoutCoords = Math.max(0, totalCandidates - withCoords)
  if (!withCoords) {
    return JSON.stringify({
      mode,
      radius_m: radius,
      total_candidates: totalCandidates,
      with_coords: 0,
      without_coords: withoutCoords,
      clusters: [],
      note: 'No candidate doors have coordinates yet — doors get lat/lng from turf cutting or the maps\' "Place pins" buttons.',
    })
  }

  const latRef = doors.reduce((sum, d) => sum + d.lat, 0) / withCoords
  const degLat = radius / 111320
  const degLng = radius / (111320 * Math.max(0.2, Math.cos((latRef * Math.PI) / 180)))

  interface Cell {
    i: number
    j: number
    n: number
    sumLat: number
    sumLng: number
    streets: Map<string, number>
  }
  const cells = new Map<string, Cell>()
  for (const d of doors) {
    const i = Math.floor(d.lat / degLat)
    const j = Math.floor(d.lng / degLng)
    const key = `${i}:${j}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { i, j, n: 0, sumLat: 0, sumLng: 0, streets: new Map() }
      cells.set(key, cell)
    }
    cell.n++
    cell.sumLat += d.lat
    cell.sumLng += d.lng
    if (d.street) {
      const name = streetName(d.street)
      cell.streets.set(name, (cell.streets.get(name) ?? 0) + 1)
    }
  }

  const scored = [...cells.values()].map((c) => {
    let n = 0
    let sumLat = 0
    let sumLng = 0
    const streets = new Map<string, number>()
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const nb = cells.get(`${c.i + di}:${c.j + dj}`)
        if (!nb) continue
        n += nb.n
        sumLat += nb.sumLat
        sumLng += nb.sumLng
        for (const [street, count] of nb.streets) streets.set(street, (streets.get(street) ?? 0) + count)
      }
    }
    return { i: c.i, j: c.j, doors: n, lat: sumLat / n, lng: sumLng / n, streets }
  })
  scored.sort((a, b) => b.doors - a.doors)

  const picked: typeof scored = []
  for (const cand of scored) {
    if (cand.doors < minDoors) break // sorted desc — everything after is smaller
    if (picked.some((p) => Math.max(Math.abs(p.i - cand.i), Math.abs(p.j - cand.j)) < 2)) continue
    picked.push(cand)
    if (picked.length >= limit) break
  }

  return JSON.stringify({
    mode,
    radius_m: radius,
    total_candidates: totalCandidates,
    with_coords: withCoords,
    without_coords: withoutCoords,
    clusters: picked.map((c) => ({
      doors: c.doors,
      center: { lat: Number(c.lat.toFixed(5)), lng: Number(c.lng.toFixed(5)) },
      streets: [...c.streets.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([street]) => street),
    })),
    ...(fetchCapped
      ? { note: 'Coordinate fetch capped at 8000 geocoded addresses — treat counts as a sample.' }
      : {}),
  })
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
      case 'find_door_clusters':
        return await withTimeout(
          runFindDoorClusters(
            String(input.mode ?? ''),
            input.radius_m == null ? undefined : Number(input.radius_m),
            input.min_doors == null ? undefined : Number(input.min_doors),
            input.limit == null ? undefined : Number(input.limit),
          ),
          TOOL_TIMEOUT_MS,
          name,
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
    case 'find_door_clusters':
      return `Clustered ${String(input.mode ?? '?')} doors (${Number(input.radius_m) || 300}m)`
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

  // Auth gate: only a signed-in manager may drive the tool loop.
  const authz = await authorizeRequest(req)
  if ('error' in authz) return json({ error: authz.error }, authz.status)
  const requester: RequesterInfo = authz.profile

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const {
    apiKey,
    messages: rawMessages,
    state: rawState,
    timezone: rawTimezone,
    localTime: rawLocalTime,
  } = body
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
            system: buildSystemPrompt(timezone, localTime, state.t, state.s, requester),
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
      console.error('Anthropic BadRequest:', err.message)
      return json({ error: 'The assistant could not process that request. Try rephrasing.' }, 400)
    }
    if (err instanceof Anthropic.APIError) {
      console.error('Anthropic APIError:', err.message)
      return json({ error: 'The assistant is temporarily unavailable — try again in a moment.' }, 502)
    }
    console.error('Chat function error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
}

export const config = { path: '/api/chat' }
