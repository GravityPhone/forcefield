<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import InfographicCard from '@/components/chat/InfographicCard.vue'
import TurfPlanCard from '@/components/chat/TurfPlanCard.vue'
import { extractFollowups } from '@/lib/followups'
import { splitSegments, type InfographicSpec } from '@/lib/infographic'
import type { TurfPlanSpec } from '@/lib/turfPlan'
import { useRouter } from 'vue-router'
import { renderMarkdownLite } from '@/lib/markdownLite'
import { apiBase } from '@/lib/native'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import {
  appendMessage,
  createChat,
  deleteChat,
  deleteFrom,
  listChats,
  loadMessages,
  renameChat,
  titleFrom,
  type AiChatRow,
} from '@/lib/aiChats'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  error?: boolean
  /** What tools the assistant used to build this answer (from the server). */
  activity?: string[]
  /** Suggested next questions (parsed off the reply's ```followups trailer).
   * Rendered as tappable buttons under the LATEST reply only. */
  suggestions?: string[]
  /** Where this message sits in the stored conversation. Absent means it
   * never reached the database — an error bubble, or a save that failed. */
  seq?: number
}

type RenderSegment =
  | { kind: 'text'; html: string }
  | { kind: 'infographic'; spec: InfographicSpec }
  | { kind: 'turfplan'; spec: TurfPlanSpec }

const auth = useAuthStore()
const router = useRouter()
// Loaded once per visit from admin_settings (the account-level, cross-device
// store) rather than re-fetched per message.
const apiKey = ref<string | null>(null)
/** Gate on the whole boot — key AND saved history — so nobody can type into a
 * conversation that's a round trip away from being replaced. */
const ready = ref(false)

// --- Saved conversations (ai_chats / ai_chat_messages, owner-only) ---------
/** null = nothing written yet. A chat row is created LAZILY, on the first
 * send, so opening the screen and leaving doesn't file an empty chat. */
const chatId = ref<string | null>(null)
const chatTitle = ref('')
/** Position the next stored message takes. Rewinding moves it backwards. */
const nextSeq = ref(0)
const chats = ref<AiChatRow[]>([])
const historyOpen = ref(false)
const historyBusy = ref(false)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const confirmingDeleteId = ref<string | null>(null)
/** Storage trouble is said out loud rather than swallowed — the conversation
 * still works, it just isn't being kept. */
const saveError = ref('')

onMounted(async () => {
  const ownerId = auth.profile?.id
  if (ownerId) {
    const { data } = await supabase
      .from('admin_settings')
      .select('anthropic_api_key')
      .eq('owner_id', ownerId)
      .maybeSingle()
    apiKey.value = data?.anthropic_api_key?.trim() || null
    // Reload lands you back in the conversation you were having — that IS
    // persistence, as far as anyone using this screen is concerned. Reading
    // rows never calls the assistant; "+ New" is one tap away.
    try {
      chats.value = await listChats(ownerId)
      const newest = chats.value[0]
      if (newest) await openChat(newest.id)
    } catch {
      saveError.value = 'Couldn’t load saved chats.'
    }
  }
  ready.value = true
})

/** The opener is UI, never a stored row: it isn't written, isn't sent, and
 * only ever shows on a conversation with nothing in it. `id: 0` is the marker
 * activeSuggestions keys the starter list off. */
function greeting(): ChatMessage {
  return {
    id: 0,
    role: 'assistant',
    text:
      "Hi! I'm the Forcefield assistant. I can query the live canvassing data, use Google Maps, " +
      'search the web, and draw charts. Tap a question below to see what I can do, or ask ' +
      'anything in your own words. (Tap ✎ on one of your messages to edit it and re-run.)',
  }
}

const messages = ref<ChatMessage[]>([greeting()])

/** Conversation openers, shown until the first question is sent. After that,
 * the assistant supplies its own three follow-ups with every reply. */
const STARTERS = [
  'How are we doing against the signature goal?',
  'Where should we send crews next?',
  'Compare this week’s outcomes as a chart',
  'Which areas are our strongest and weakest?',
]

/** Suggestion buttons live under the newest reply only — older ones are stale. */
const activeSuggestions = computed<string[]>(() => {
  if (loading.value) return []
  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'assistant' || last.error) return []
  if (last.id === 0) return STARTERS
  return last.suggestions ?? []
})

function sendSuggestion(q: string) {
  if (loading.value) return
  draft.value = q
  void send()
}

const draft = ref('')
const loading = ref(false)
/** Latest tool-activity line from the server, shown live in the thinking bubble. */
const liveStatus = ref('')
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
let nextId = 1

/** Nothing to start over from: no saved chat, nothing said. */
const isFresh = computed(() => !chatId.value && messages.value.length <= 1)

/** Read the rows and render them. Deliberately does NOT touch /api/chat —
 * reopening an old answer must never cost a request against the admin's key. */
async function openChat(id: string) {
  let rows
  try {
    rows = await loadMessages(id)
  } catch {
    saveError.value = 'Couldn’t open that chat.'
    return
  }
  chatId.value = id
  chatTitle.value = chats.value.find((c) => c.id === id)?.title ?? ''
  messages.value = rows.map((r) => ({
    id: nextId++,
    role: r.role,
    text: r.text,
    activity: r.activity ?? undefined,
    suggestions: r.suggestions ?? undefined,
    seq: r.seq,
  }))
  nextSeq.value = rows.length ? rows[rows.length - 1].seq + 1 : 0
  if (!messages.value.length) messages.value = [greeting()]
  saveError.value = ''
  await scrollToBottom()
}

/** Back to an unwritten conversation. Kept apart from newChat() because
 * deleting the chat you're looking at also lands here, and that shouldn't
 * slam the sheet shut on someone who is still tidying up their list. */
function resetConversation() {
  chatId.value = null
  chatTitle.value = ''
  nextSeq.value = 0
  messages.value = [greeting()]
  draft.value = ''
  saveError.value = ''
}

function newChat() {
  if (loading.value) return
  resetConversation()
  historyOpen.value = false
}

async function openHistory() {
  if (loading.value) return
  historyOpen.value = true
  renamingId.value = null
  confirmingDeleteId.value = null
  const ownerId = auth.profile?.id
  if (!ownerId) return
  historyBusy.value = true
  try {
    chats.value = await listChats(ownerId)
  } catch {
    saveError.value = 'Couldn’t load saved chats.'
  }
  historyBusy.value = false
}

async function pickChat(id: string) {
  historyOpen.value = false
  if (id === chatId.value) return
  await openChat(id)
}

function startRename(row: AiChatRow) {
  renamingId.value = row.id
  renameDraft.value = row.title
  confirmingDeleteId.value = null
}

async function commitRename() {
  const id = renamingId.value
  const title = renameDraft.value.trim()
  renamingId.value = null
  const row = chats.value.find((c) => c.id === id)
  if (!id || !row || !title || row.title === title) return
  row.title = title
  if (id === chatId.value) chatTitle.value = title
  try {
    await renameChat(id, title)
  } catch {
    saveError.value = 'Couldn’t rename it.'
  }
}

/** Two taps, no dialog — the knock-edit sheet's precedent: a confirm dialog is
 * hard to dismiss one-handed, and arming the button says the same thing. */
async function removeChat(row: AiChatRow) {
  if (confirmingDeleteId.value !== row.id) {
    confirmingDeleteId.value = row.id
    return
  }
  confirmingDeleteId.value = null
  try {
    await deleteChat(row.id)
  } catch {
    saveError.value = 'Couldn’t delete it.'
    return
  }
  chats.value = chats.value.filter((c) => c.id !== row.id)
  if (row.id === chatId.value) resetConversation()
}

/** Stamp for a history row: today is a clock, anything older is a date. */
function chatStamp(iso: string): string {
  const d = new Date(iso)
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Write the question the moment it's asked, creating the chat if this is the
 * first one. A dropped connection should cost at most the answer, never the
 * question. Returns the seq it landed at, or null if nothing was stored. */
async function persistUser(text: string): Promise<number | null> {
  const ownerId = auth.profile?.id
  if (!ownerId) return null
  const seq = nextSeq.value
  try {
    if (!chatId.value) {
      chatTitle.value = titleFrom(text)
      chatId.value = await createChat(ownerId, chatTitle.value)
    } else if (seq === 0) {
      // Rewound all the way to the start: the title came from the message
      // that just got dropped, so it takes its meaning from this one instead.
      chatTitle.value = titleFrom(text)
      await renameChat(chatId.value, chatTitle.value)
    }
    await appendMessage(chatId.value, { seq, role: 'user', text })
    nextSeq.value = seq + 1
    saveError.value = ''
    return seq
  } catch {
    saveError.value = 'Couldn’t save this chat.'
    return null
  }
}

/** Written ONCE, when the turn is finally answered — not per continuation hop,
 * which would file half a reply every time the server handed back state. */
async function persistAssistant(m: {
  text: string
  activity?: string[]
  suggestions?: string[]
}): Promise<number | null> {
  if (!chatId.value) return null
  const seq = nextSeq.value
  try {
    await appendMessage(chatId.value, { seq, role: 'assistant', ...m })
    nextSeq.value = seq + 1
    return seq
  } catch {
    saveError.value = 'Couldn’t save the answer.'
    return null
  }
}

async function scrollToBottom() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

/** Collapse runs of the same activity label into one chip with a count.
 * Every database lookup reads "Searched database" now — the SQL itself isn't
 * something a campaign manager can check (read-only is enforced in Postgres)
 * — so a turn that ran three queries would otherwise print the same chip
 * three times. Only CONSECUTIVE repeats fold: search, geocode, search really
 * did happen in that order. */
function activityChips(activity: string[]): { label: string; count: number }[] {
  const out: { label: string; count: number }[] = []
  for (const a of activity) {
    const last = out[out.length - 1]
    if (last && last.label === a) last.count++
    else out.push({ label: a, count: 1 })
  }
  return out
}

/** Assistant replies render as markdown-lite text plus inline infographic
 * cards; recomputed per render, which is fine at chat-history scale. */
function segmentsFor(text: string): RenderSegment[] {
  return splitSegments(text).map((seg) =>
    seg.kind === 'text' ? { kind: 'text' as const, html: renderMarkdownLite(seg.text) } : seg,
  )
}

/** [[Grove St]] in a reply renders as a .street-link button inside v-html, so
 * the click is delegated from the wrapper rather than bound per element.
 *
 * Lands on the TURF CUTTER since 2026-07-25 (user call), not Scout. The
 * question behind "tell me about Grove St" is a manager's question — how is
 * this street doing and who has it — and the cutter is the only screen that
 * answers the second half: it paints every door on its knock status and names
 * the owning turf when you tap one. Scout is the canvasser's walking view and
 * knows nothing about who a street belongs to. */
function openStreetFromClick(event: MouseEvent) {
  const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('.street-link')
  const street = el?.dataset.street?.trim()
  if (!street) return
  event.preventDefault()
  void router.push({ path: '/turf', query: { street } })
}

/** Rewind: pull this message back into the input and drop it plus everything
 * after it, so sending branches the conversation from that point.
 *
 * The stored side has to be rewound too, or reopening this chat would bring
 * the abandoned branch back with it. The cutoff comes from what SURVIVED, not
 * from the dropped message, so a message that never saved can't leave a stale
 * tail behind. */
function editMessage(m: ChatMessage) {
  if (loading.value) return
  const idx = messages.value.findIndex((x) => x.id === m.id)
  if (idx === -1) return
  draft.value = m.text
  const kept = messages.value.slice(0, idx)
  messages.value = kept.length ? kept : [greeting()]
  const seqs = kept.map((k) => k.seq).filter((s): s is number => typeof s === 'number')
  const cutoff = seqs.length ? Math.max(...seqs) + 1 : 0
  nextSeq.value = cutoff
  const id = chatId.value
  if (id) {
    deleteFrom(id, cutoff).catch(() => {
      saveError.value = 'Couldn’t save this chat.'
    })
  }
  nextTick(() => inputEl.value?.focus())
}

async function send() {
  const text = draft.value.trim()
  if (!text || loading.value) return

  if (!ready.value) return // still booting; send is disabled in the UI until then
  // No personal key saved is fine — the chat function falls back to the
  // shared demo key configured on the server.

  const asked: ChatMessage = { id: nextId++, role: 'user', text }
  messages.value.push(asked)
  draft.value = ''
  loading.value = true
  liveStatus.value = ''
  await scrollToBottom()

  // Filed before the request goes out, not after it comes back.
  const askedSeq = await persistUser(text)
  if (askedSeq !== null) asked.seq = askedSeq

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
      text: 'Your session expired. Please sign in again.',
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
      // The reply ends with a ```followups trailer (3 suggested next
      // questions) — strip it from the shown/stored text, keep as buttons.
      // Storing the STRIPPED text is why `suggestions` needs a column of its
      // own: strip the block and they're gone unless they're kept apart.
      const { text: replyText, suggestions } = extractFollowups(String(data.text ?? ''))
      const answer = {
        text: replyText || '(empty response)',
        activity: activity.length ? activity : undefined,
        suggestions: suggestions.length ? suggestions : undefined,
      }
      // Filed before it's shown, so the thinking bubble doesn't sit under a
      // finished answer while the write lands.
      const answerSeq = await persistAssistant(answer)
      messages.value.push({
        id: nextId++,
        role: 'assistant',
        ...answer,
        seq: answerSeq ?? undefined,
      })
      return
    }
    messages.value.push({
      id: nextId++,
      role: 'assistant',
      text: 'The assistant took too many steps. Try a narrower question.',
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
  <AppShell title="Forcefield Assistant">
    <div class="chat card">
      <div class="chat-bar">
        <button
          class="bar-title"
          type="button"
          data-help="aichat-history"
          :disabled="loading"
          @click="openHistory"
        >
          ☰ {{ chatTitle || 'Chats' }}
        </button>
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          data-help="aichat-new"
          :disabled="loading || isFresh"
          @click="newChat"
        >
          + New
        </button>
      </div>
      <p v-if="saveError" class="save-error">{{ saveError }}</p>
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
                <!-- [[Street]] links inside v-html can't carry @click, so the
                     wrapper delegates — see openStreetFromClick. -->
                <div
                  v-if="seg.kind === 'text'"
                  class="md"
                  v-html="seg.html"
                  @click="openStreetFromClick"
                />
                <TurfPlanCard v-else-if="seg.kind === 'turfplan'" :spec="seg.spec" />
                <InfographicCard v-else :spec="seg.spec" />
              </template>
              <div v-if="m.activity?.length" class="activity">
                <span
                  v-for="(c, i) in activityChips(m.activity)"
                  :key="i"
                  class="chip"
                  :title="c.label"
                >{{ c.count > 1 ? `${c.label} ×${c.count}` : c.label }}</span>
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
        <!-- Tappable next questions: curated starters on a fresh chat, then
             the assistant's own three follow-ups after every reply. -->
        <div v-if="activeSuggestions.length" class="suggestions" data-help="aichat-suggestions" aria-label="Suggested questions">
          <button
            v-for="(q, i) in activeSuggestions"
            :key="`${q}-${i}`"
            class="suggestion"
            type="button"
            @click="sendSuggestion(q)"
          >
            {{ q }}
          </button>
        </div>
      </div>
      <form class="chat-input" data-help="aichat-input" @submit.prevent="send">
        <input
          ref="inputEl"
          v-model="draft"
          placeholder="Ask the assistant…"
          aria-label="Chat message"
          :disabled="loading || !ready"
        />
        <button class="btn btn-primary" type="submit" :disabled="!draft.trim() || loading || !ready">
          Send
        </button>
      </form>
    </div>

    <BottomSheet v-model:open="historyOpen" title="Chats">
      <!-- A refresh renders under the rows it already has; only a cold open
           shows the wait. -->
      <p v-if="historyBusy && !chats.length" class="hist-note muted">Loading…</p>
      <p v-else-if="!chats.length" class="hist-note muted">No saved chats yet.</p>
      <ul v-else class="hist-list">
        <li
          v-for="c in chats"
          :key="c.id"
          class="hist-row"
          :class="{ current: c.id === chatId }"
        >
          <template v-if="renamingId === c.id">
            <input
              v-model="renameDraft"
              class="hist-rename"
              type="text"
              aria-label="Chat name"
              @keyup.enter="commitRename"
              @keyup.esc="renamingId = null"
            />
            <button class="hist-btn" type="button" aria-label="Save name" @click="commitRename">
              ✓
            </button>
          </template>
          <template v-else>
            <button class="hist-open" type="button" @click="pickChat(c.id)">
              <span class="hist-name">{{ c.title }}</span>
              <span class="hist-when">{{ chatStamp(c.updated_at) }}</span>
            </button>
            <button class="hist-btn" type="button" aria-label="Rename" @click="startRename(c)">
              ✎
            </button>
            <!-- Two taps, no dialog — same as the knock-edit sheet. -->
            <button
              class="hist-btn danger"
              type="button"
              :aria-label="confirmingDeleteId === c.id ? 'Tap again to delete' : 'Delete'"
              @click="removeChat(c)"
            >
              {{ confirmingDeleteId === c.id ? 'Delete?' : '✕' }}
            </button>
          </template>
        </li>
      </ul>
    </BottomSheet>
  </AppShell>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: min(72dvh, 720px);
  padding: 0.75rem;
}

/* Which conversation you're in, and the two ways out of it. */
.chat-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.25rem 0.5rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

/* The current chat's name IS the button that opens the list. A long title
   ellipses rather than widening the row — nothing here scrolls sideways. */
.bar-title {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 700;
  font-size: 0.95rem;
  padding: 0.35rem 0.4rem;
  border-radius: var(--radius);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-title:hover:not(:disabled) {
  background: var(--surface-2);
}

.bar-title:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.save-error {
  margin: 0.4rem 0 0;
  padding: 0 0.5rem;
  font-size: 0.8rem;
  color: var(--danger);
  flex-shrink: 0;
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

/* [[Street Name]] — inline in prose, so it has to sit on the text baseline
   and wrap like a word rather than behaving like a block button. */
.md :deep(.street-link) {
  display: inline;
  border: 0;
  padding: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.md :deep(.street-link:hover) {
  text-decoration-thickness: 2px;
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

/* Suggested-question buttons — pills under the newest reply. */
.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding-left: 0.25rem;
}

.suggestion {
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--accent);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease;
  -webkit-tap-highlight-color: transparent;
}

.suggestion:hover {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface));
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

/* --- History sheet -------------------------------------------------------- */

.hist-note {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

.hist-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 60dvh;
  overflow-y: auto;
}

.hist-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}

.hist-row:last-child {
  border-bottom: none;
}

.hist-row.current {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.hist-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 0.7rem 0.4rem;
  cursor: pointer;
  border-radius: var(--radius);
}

.hist-open:hover {
  background: var(--surface-2);
}

.hist-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist-when {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.hist-btn {
  flex-shrink: 0;
  min-width: 34px;
  min-height: 34px;
  padding: 0 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.hist-btn:hover {
  color: var(--text);
}

.hist-btn.danger {
  border-color: var(--danger);
  color: var(--danger);
}

.hist-rename {
  flex: 1;
  min-width: 0;
  margin: 0.35rem 0;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  padding: 0.5rem 0.6rem;
}
</style>
