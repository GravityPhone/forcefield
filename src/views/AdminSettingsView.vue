<script setup lang="ts">
import { ref } from 'vue'
import AppShell from '@/components/AppShell.vue'

// Stored locally for now. Phase 2 (real chat backend) will move this to secure
// per-admin storage — never into the frontend bundle or a shared table in plaintext.
const KEY_STORAGE = 'forcefield.anthropic_api_key'

const apiKey = ref(localStorage.getItem(KEY_STORAGE) ?? '')
const saved = ref(false)

function saveKey() {
  localStorage.setItem(KEY_STORAGE, apiKey.value.trim())
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}
</script>

<template>
  <AppShell title="Admin Settings">
    <div class="stack">
      <div class="card">
        <h3>AI Assistant — Anthropic API Key</h3>
        <p class="muted">
          Bring your own key. Used by the AI chat once the data backend ships (Phase 2). The key
          stays on this device for now.
        </p>
        <form @submit.prevent="saveKey">
          <div class="field">
            <label for="anthropic-key">API key</label>
            <input
              id="anthropic-key"
              v-model="apiKey"
              type="password"
              placeholder="sk-ant-…"
              autocomplete="off"
            />
          </div>
          <button class="btn btn-primary" type="submit">
            {{ saved ? 'Saved ✓' : 'Save Key' }}
          </button>
        </form>
      </div>

      <div class="card">
        <h3>Data Sources</h3>
        <div class="source-row">
          <div>
            <strong>CSV Import (county voter roll)</strong>
            <p class="muted small">Import addresses from a downloaded voter-roll file, filtered by city.</p>
          </div>
          <span class="badge">Coming soon</span>
        </div>
        <div class="source-row">
          <div>
            <strong>Connect to Minivan</strong>
            <p class="muted small">Sync directly with VAN/Minivan. Requires API access we don't have yet.</p>
          </div>
          <button class="btn btn-ghost" disabled>Coming soon</button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-top: 1px solid var(--border);
}

.source-row:first-of-type {
  border-top: none;
}

.small {
  font-size: 0.85rem;
  margin: 0.2rem 0 0;
}
</style>
