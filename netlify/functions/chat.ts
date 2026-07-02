// Server-side proxy for the admin AI chat. The browser can't call
// api.anthropic.com directly (CORS + it would expose the key in client
// requests), so the frontend POSTs { apiKey, messages } here and this
// function makes the real call.
//
// BUDGET CONSTRAINT: the admin's key has $5 of credit. Model must stay
// claude-haiku-4-5-20251001 (cheapest tier) and max_tokens conservative.

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024

const SYSTEM_PROMPT =
  'You are the AI assistant inside Forcefield, a door-to-door canvassing app, ' +
  'talking to an org admin. You do not yet have access to their real canvassing ' +
  'data (knock logs, addresses, turf) — that integration is coming later. Answer ' +
  'general questions helpfully and concisely, and when asked about their specific ' +
  'data, say you cannot see it yet.'

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

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { apiKey, messages } = body
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return json({ error: 'Missing API key — add it in Settings.' }, 400)
  }
  if (!isValidMessages(messages)) {
    return json({ error: 'Invalid messages payload' }, 400)
  }

  const client = new Anthropic({ apiKey: apiKey.trim() })
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    })
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    return json({ text })
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
