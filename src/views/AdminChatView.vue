<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import InfographicCard from '@/components/chat/InfographicCard.vue'
import { splitSegments, type InfographicSpec } from '@/lib/infographic'
import { renderMarkdownLite } from '@/lib/markdownLite'
import { apiBase } from '@/lib/native'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  error?: boolean
  /** What tools the assistant used to build this answer (from the server). */
  activity?: string[]
}

type RenderSegment = { kind: 'text'; html: string } | { kind: 'infographic'; spec: InfographicSpec }

const auth = useAuthStore()
// Loaded once per visit from admin_settings (the account-level, cross-device
// store) rather than re-fetched per message.
const apiKey = ref<string | null>(null)
const keyLoaded = ref(false)

onMounted(async () => {
  const ownerId = auth.profile?.id
  if (ownerId) {
    const { data } = await supabase
      .from('admin_settings')
      .select('anthropic_api_key')
      .eq('owner_id', ownerId)
      .maybeSingle()
    apiKey.value = data?.anthropic_api_key?.trim() || null
  }
  keyLoaded.value = true
})

const messages = ref<ChatMessage[]>([
  {
    id: 0,
    role: 'assistant',
    text:
      "Hi! I'm the Forcefield assistant. I can query your live canvassing data, use Google Maps, " +
      'search the web, and draw quick charts. Try "how many doors signed today", "compare ' +
      'outcomes this week as a chart", or "any rain expected in Marysville tomorrow?". ' +
      'Tap ✎ on one of your messages to edit it and re-run from that point.',
  },
])

const draft = ref('')
const loading = ref(false)
/** Latest tool-activity line from the server, shown live in the thinking bubble. */
const liveStatus = ref('')
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
let nextId = 1

async function scrollToBottom() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

/** Assistant replies render as markdown-lite text plus inline infographic
 * cards; recomputed per render, which is fine at chat-history scale. */
function segmentsFor(text: string): RenderSegment[] {
  return splitSegments(text).map((seg) =>
    seg.kind === 'text' ? { kind: 'text' as const, html: renderMarkdownLite(seg.text) } : seg,
  )
}

/** Rewind: pull this message back into the input and drop it plus everything
 * after it, so sending branches the conversation from that point. */
function editMessage(m: ChatMessage) {
  if (loading.value) return
  const idx = messages.value.findIndex((x) => x.id === m.id)
  if (idx === -1) return
  draft.value = m.text
  messages.value = messages.value.slice(0, idx)
  nextTick(() => inputEl.value?.focus())
}

async function send() {
  const text = draft.value.trim()
  if (!text || loading.value) return

  if (!keyLoaded.value) return // still fetching; send is disabled in the UI until then
  // No personal key saved is fine — the chat function falls back to the
  // shared demo key configured on the server.

  messages.value.push({ id: nextId++, role: 'user', text })
  draft.value = ''
  loading.value = true
  liveStatus.value = ''
  await scrollToBottom()

  // Full multi-turn history, skipping error bubbles and the seeded greeting —
  // the Anthropic API requires the first message to be from the user.
  const history = messages.value.filter((m) => !m.error)
  const firstUser = history.findIndex((m) => m.role === 'user')
  const wireMessages = history.slice(firstUser).map((m) => ({ role: m.role, content: m.text }))

  // Sent fresh with every request (not cached) so the assistant can convert
  // any UTC timestamp it reads back (occurred_at, created_at) to the admin's
  // actual local time instead of repeating the raw UTC value.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const localTime = new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  })

  // The function authenticates the caller from their Supabase session token
  // (it no longer trusts any client-sent identity or role), so attach it to
  // every hop. "me"/username context is derived server-side from this token.
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token
  if (!accessToken) {
    messages.value.push({
      id: nextId++,
      role: 'assistant',
      text: 'Your session expired — please sign in again.',
      error: true,
    })
    loading.value = false
    return
  }

  // A turn with several tool calls (or a web search) won't fit in one Netlify
  // function invocation, so the server may answer { continue, state } — POST
  // the state straight back and a fresh invocation resumes the loop. The hop
  // cap is a client-side backstop; the server enforces the real budgets.
  let payload: Record<string, unknown> = {
    // undefined omits the field, so the server falls back to the shared key
    apiKey: apiKey.value ?? undefined,
    messages: wireMessages,
    timezone,
    localTime,
  }

  try {
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        messages.value.push({
          id: nextId++,
          role: 'assistant',
          text: data.error ?? `Request failed (${res.status}).`,
          error: true,
        })
        return
      }
      if (data.continue && typeof data.state === 'string') {
        const acts = Array.isArray(data.activity) ? (data.activity as string[]) : []
        liveStatus.value = acts.length ? acts[acts.length - 1] : 'Working…'
        payload = {
          apiKey: apiKey.value ?? undefined,
          state: data.state,
          timezone,
          localTime,
        }
        continue
      }
      const activity = Array.isArray(data.activity) ? (data.activity as string[]) : []
      messages.value.push({
        id: nextId++,
        role: 'assistant',
        text: data.text ?? '(empty response)',
        activity: activity.length ? activity : undefined,
      })
      return
    }
    messages.value.push({
      id: nextId++,
      role: 'assistant',
      text: 'The assistant took too many steps — try a narrower question.',
      error: true,
    })
  } catch {
    messages.value.push({
      id: nextId++,
      role: 'assistant',
      text: 'Could not reach the chat service. (Note: the /api/chat function only runs on Netlify, not under plain "npm run dev".)',
      error: true,
    })
  } finally {
    loading.value = false
    liveStatus.value = ''
    await scrollToBottom()
  }
}
</script>

<template>
  <AppShell title="AI Chat">
    <div class="chat card">
      <div ref="listEl" class="chat-messages">
        <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role, { error: m.error }]">
          <button
            v-if="m.role === 'user'"
            class="edit-btn"
            type="button"
            title="Edit & re-run from here"
            aria-label="Edit this message and re-run from here"
            :disabled="loading"
            @click="editMessage(m)"
          >
            ✎
          </button>
          <div class="bubble">
            <template v-if="m.role === 'assistant' && !m.error">
              <template v-for="(seg, i) in segmentsFor(m.text)" :key="i">
                <div v-if="seg.kind === 'text'" class="md" v-html="seg.html" />
                <InfographicCard v-else :spec="seg.spec" />
              </template>
              <div v-if="m.activity?.length" class="activity">
                <span v-for="(a, i) in m.activity" :key="i" class="chip" :title="a">{{ a }}</span>
              </div>
            </template>
            <template v-else>{{ m.text }}</template>
          </div>
        </div>
        <div v-if="loading" class="msg assistant">
          <div class="bubble muted thinking">
            {{ liveStatus || 'Thinking'
            }}<span class="dots"><span>.</span><span>.</span><span>.</span></span>
          </div>
        </div>
      </div>
      <form class="chat-input" @submit.prevent="send">
        <input
          ref="inputEl"
          v-model="draft"
          placeholder="Ask the assistant…"
          aria-label="Chat message"
          :disabled="loading || !keyLoaded"
        />
        <button class="btn btn-primary" type="submit" :disabled="!draft.trim() || loading || !keyLoaded">
          Send
        </button>
      </form>
    </div>
  </AppShell>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: min(72dvh, 720px);
  padding: 0.75rem;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.5rem;
}

.msg {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.msg.user {
  justify-content: flex-end;
}

.bubble {
  max-width: 78%;
  padding: 0.6rem 0.9rem;
  border-radius: 14px;
  font-size: 0.95rem;
  line-height: 1.45;
  white-space: pre-wrap;
}

.msg.assistant .bubble {
  background: var(--surface-2);
  border-bottom-left-radius: 4px;
}

/* Replies that carry a chart need the room. */
.msg.assistant .bubble:has(.ig) {
  flex: 1;
  max-width: 96%;
}

.msg.user .bubble {
  background: var(--accent);
  color: var(--accent-contrast);
  border-bottom-right-radius: 4px;
}

.msg.error .bubble {
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  border: 1px solid var(--danger);
  color: var(--danger);
}

.edit-btn {
  flex: 0 0 auto;
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  opacity: 0.35;
  font-size: 0.95rem;
  padding: 0.25rem;
  border-radius: 6px;
}

.edit-btn:hover:not(:disabled),
.edit-btn:focus-visible {
  opacity: 1;
  background: var(--surface-2);
}

.edit-btn:disabled {
  opacity: 0.15;
  cursor: default;
}

/* Markdown-lite inside assistant bubbles (rendered HTML, not raw text). */
.md {
  white-space: normal;
}

.md p {
  margin: 0 0 0.45rem;
}

.md p:last-child {
  margin-bottom: 0;
}

.md ul {
  margin: 0.2rem 0 0.45rem;
  padding-left: 1.15rem;
}

.md li {
  margin: 0.15rem 0;
}

.md code {
  background: color-mix(in srgb, currentColor 10%, transparent);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.85em;
}

/* Tool-activity trace under an answer — what the assistant actually did. */
.activity {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.55rem;
}

.chip {
  font-size: 0.67rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.12rem 0.55rem;
  opacity: 0.75;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dots span {
  animation: dot-pulse 1.2s infinite;
  opacity: 0.25;
}

.dots span:nth-child(2) {
  animation-delay: 0.2s;
}

.dots span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes dot-pulse {
  0%,
  60%,
  100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}

.chat-input {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  border-top: 1px solid var(--border);
}

.chat-input input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
}

.chat-input input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
</style>
