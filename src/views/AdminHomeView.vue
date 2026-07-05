<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { METRIC_LABELS } from '@/types'
import type { LeaderboardMetric, LeaderboardSettings } from '@/types'

const settings = ref<LeaderboardSettings | null>(null)
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')

onMounted(async () => {
  const { data } = await supabase.from('leaderboard_settings').select('*').eq('id', true).single()
  if (data) settings.value = data as LeaderboardSettings
})

async function saveSettings() {
  if (!settings.value) return
  saving.value = true
  saveError.value = ''
  const { error } = await supabase
    .from('leaderboard_settings')
    .update({
      primary_metric: settings.value.primary_metric,
      doors_board_enabled: settings.value.doors_board_enabled,
      updated_at: new Date().toISOString(),
    })
    .eq('id', true)
  saving.value = false
  if (error) {
    saveError.value = 'Could not save — try again.'
    return
  }
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}
</script>

<template>
  <AppShell title="Admin Dashboard">
    <div class="grid">
      <div class="card">
        <h3>Leaderboards</h3>
        <template v-if="settings">
          <div class="field">
            <label for="primary-metric">Ranking metric</label>
            <select id="primary-metric" v-model="settings.primary_metric">
              <option v-for="(label, value) in METRIC_LABELS" :key="value" :value="value as LeaderboardMetric">
                {{ label }}
              </option>
            </select>
          </div>
          <label class="check">
            <input type="checkbox" v-model="settings.doors_board_enabled" />
            Also show a separate doors-knocked board
          </label>
          <div class="actions">
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveSettings">
              {{ saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save' }}
            </button>
            <router-link class="btn btn-ghost btn-sm" to="/leaderboard">View leaderboard</router-link>
          </div>
          <p v-if="saveError" class="error">{{ saveError }}</p>
        </template>
        <p v-else class="muted">Loading settings…</p>
      </div>

      <div class="card">
        <h3>Campaign Bulletin</h3>
        <p class="muted">Post announcements the whole team sees.</p>
        <router-link class="btn btn-primary btn-sm" to="/bulletin">Open bulletin</router-link>
      </div>

      <div class="card">
        <h3>Campaigns &amp; Teams</h3>
        <p class="muted">Create campaigns and assign teams to them.</p>
        <router-link class="btn btn-primary btn-sm" to="/admin/campaigns">Manage</router-link>
      </div>

      <div class="card">
        <h3>Users &amp; Roles</h3>
        <p class="muted">Manage accounts, elevate roles, create admins. Coming soon.</p>
      </div>

      <div class="card">
        <h3>Turf Assignment</h3>
        <p class="muted">Assign street ranges to teams and canvassers. Coming soon.</p>
      </div>

      <div class="card">
        <h3>Voter Data Import</h3>
        <p class="muted">Import a county voter-roll CSV, filtered by city. Coming soon.</p>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.check {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.92rem;
  margin: 0.35rem 0 0.75rem;
}

.check input {
  width: auto;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0.5rem 0 0;
  font-size: 0.9rem;
}
</style>
