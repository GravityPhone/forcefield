<script setup lang="ts">
import { nextTick, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
}

// UI shell only — Phase 2 wires this to a real backend (RAG over knock/address data).
const messages = ref<ChatMessage[]>([
  {
    id: 0,
    role: 'assistant',
    text: "Hi! I'm the Forcefield data assistant. Once I'm connected, you'll be able to ask things like \"which streets have the best signature rate in the evenings?\" and get answers from your live canvassing data. For now I'm just a preview — the data backend is coming soon.",
  },
])

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)
let nextId = 1

async function send() {
  const text = draft.value.trim()
  if (!text) return
  messages.value.push({ id: nextId++, role: 'user', text })
  draft.value = ''
  messages.value.push({
    id: nextId++,
    role: 'assistant',
    text: '🔌 Coming soon — I\'m not connected to your canvassing data yet. When the backend is live, I\'ll answer this from real knock logs, addresses, and turf data.',
  })
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}
</script>

<template>
  <AppShell title="AI Chat">
    <div class="chat card">
      <div ref="listEl" class="chat-messages">
        <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
          <div class="bubble">{{ m.text }}</div>
        </div>
      </div>
      <form class="chat-input" @submit.prevent="send">
        <input
          v-model="draft"
          placeholder="Ask about your canvassing data…"
          aria-label="Chat message"
        />
        <button class="btn btn-primary" type="submit" :disabled="!draft.trim()">Send</button>
      </form>
      <p class="muted disclaimer">
        Preview — responses use a placeholder until the data backend ships. Add your Anthropic API
        key in <router-link to="/admin/settings">Settings</router-link>.
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
