<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { apiBase } from '@/lib/native'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  error?: boolean
}

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
    text: "Hi! I'm the Forcefield assistant. I can query your live canvassing data (knocks, outcomes, addresses) and use Google Maps — ask me things like \"how many doors were signed today\" or \"what are the last 5 outcomes logged\".",
  },
])

const draft = ref('')
const loading = ref(false)
const listEl = ref<HTMLElement | null>(null)
let nextId = 1

async function scrollToBottom() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

async function send() {
  const text = draft.value.trim()
  if (!text || loading.value) return

  if (!keyLoaded.value) return // still fetching; send is disabled in the UI until then
  if (!apiKey.value) {
    messages.value.push({ id: nextId++, role: 'user', text })
    messages.value.push({
      id: nextId++,
      role: 'assistant',
      text: 'No API key saved — add your Anthropic API key in Settings first.',
      error: true,
    })
    draft.value = ''
    await scrollToBottom()
    return
  }

  messages.value.push({ id: nextId++, role: 'user', text })
  draft.value = ''
  loading.value = true
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

  try {
    const res = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKey.value, messages: wireMessages, timezone, localTime }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      messages.value.push({
        id: nextId++,
        role: 'assistant',
        text: data.error ?? `Request failed (${res.status}).`,
        error: true,
      })
    } else {
      messages.value.push({ id: nextId++, role: 'assistant', text: data.text ?? '(empty response)' })
    }
  } catch {
    messages.value.push({
      id: nextId++,
      role: 'assistant',
      text: 'Could not reach the chat service. (Note: the /api/chat function only runs on Netlify, not under plain "npm run dev".)',
      error: true,
    })
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}
</script>

<template>
  <AppShell title="AI Chat">
    <div class="chat card">
      <div ref="listEl" class="chat-messages">
        <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role, { error: m.error }]">
          <div class="bubble">{{ m.text }}</div>
        </div>
        <div v-if="loading" class="msg assistant">
          <div class="bubble muted thinking">
            Thinking<span class="dots"><span>.</span><span>.</span><span>.</span></span>
          </div>
        </div>
      </div>
      <form class="chat-input" @submit.prevent="send">
        <input
          v-model="draft"
          placeholder="Ask the assistant…"
          aria-label="Chat message"
          :disabled="loading || !keyLoaded"
        />
        <button class="btn btn-primary" type="submit" :disabled="!draft.trim() || loading || !keyLoaded">
          Send
        </button>
      </form>
      <p class="muted disclaimer">
        Responses come from Claude Haiku via your API key (set in
        <router-link to="/admin/settings">Settings</router-link>). The assistant can read live
        canvassing data (not private user chats) and use Google Maps.
      </p>
    </div>
  </AppShell>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: min(65dvh, 640px);
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

.disclaimer {
  margin: 0.5rem 0.5rem 0.25rem;
  font-size: 0.8rem;
}
</style>
