<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'

// Persisted server-side per admin account (admin_settings table, RLS-scoped
// to owner_id) so the key follows the account across devices/browsers
// instead of living in this one browser's localStorage.
const LEGACY_KEY_STORAGE = 'forcefield.anthropic_api_key'

const auth = useAuthStore()
const apiKey = ref('')
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const loadError = ref('')

onMounted(async () => {
  const ownerId = auth.profile?.id
  if (!ownerId) {
    loading.value = false
    return
  }
  const { data, error } = await supabase
    .from('admin_settings')
    .select('anthropic_api_key')
    .eq('owner_id', ownerId)
    .maybeSingle()
  loading.value = false
  if (error) {
    loadError.value = 'Could not load saved key — try reloading.'
    return
  }
  if (data?.anthropic_api_key) {
    apiKey.value = data.anthropic_api_key
  } else {
    // One-time carryover from the old per-browser storage, if present.
    apiKey.value = localStorage.getItem(LEGACY_KEY_STORAGE) ?? ''
  }
})

async function saveKey() {
  const ownerId = auth.profile?.id
  if (!ownerId) return
  loadError.value = ''
  const key = apiKey.value.trim()
  if (!key) {
    loadError.value = 'Enter your Anthropic API key first.'
    return
  }
  saving.value = true
  const { error } = await supabase
    .from('admin_settings')
    .upsert({ owner_id: ownerId, anthropic_api_key: key, updated_at: new Date().toISOString() })
  saving.value = false
  if (error) {
    loadError.value = 'Could not save the key — try again.'
    return
  }
  localStorage.removeItem(LEGACY_KEY_STORAGE)
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
          A shared demo key is already configured — the AI assistant works out of the box, nothing
          to set up. Optionally save your own key here to use it instead; it's saved to your
          account and follows you across devices.
        </p>
        <form v-if="!loading" @submit.prevent="saveKey">
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
          <button class="btn btn-primary" type="submit" :disabled="saving">
            {{ saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save Key' }}
          </button>
          <p v-if="loadError" class="error">{{ loadError }}</p>
        </form>
        <p v-else class="muted">Loading…</p>
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

.error {
  color: var(--danger, #c0392b);
  margin: 0.5rem 0 0;
  font-size: 0.9rem;
}
</style>
