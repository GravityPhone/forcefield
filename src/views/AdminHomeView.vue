<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { supabase } from '@/lib/supabase'
import { METRIC_LABELS } from '@/types'
import type { ActivityFeedSettings, LeaderboardMetric, LeaderboardSettings } from '@/types'

const metricOptions = Object.entries(METRIC_LABELS).map(([value, label]) => ({ value, label }))

const settings = ref<LeaderboardSettings | null>(null)
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')

const feed = ref<ActivityFeedSettings | null>(null)
const feedSaving = ref(false)
const feedSaved = ref(false)
const feedError = ref('')

onMounted(async () => {
  const [lb, af] = await Promise.all([
    supabase.from('leaderboard_settings').select('*').eq('id', true).single(),
    supabase.from('activity_feed_settings').select('*').eq('id', true).single(),
  ])
  if (lb.data) settings.value = lb.data as LeaderboardSettings
  if (af.data) feed.value = af.data as ActivityFeedSettings
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

/** Milestone steps must be whole numbers ≥ 1 (the DB CHECKs agree). */
function cleanStep(n: number): number {
  return Math.max(1, Math.round(Number.isFinite(n) ? n : 1))
}

async function saveFeedSettings() {
  const f = feed.value
  if (!f) return
  feedSaving.value = true
  feedError.value = ''
  const { error } = await supabase
    .from('activity_feed_settings')
    .update({
      show_knocks: f.show_knocks,
      show_signatures: f.show_signatures,
      person_milestones: f.person_milestones,
      person_door_step: cleanStep(f.person_door_step),
      squad_milestones: f.squad_milestones,
      squad_door_step: cleanStep(f.squad_door_step),
      squad_signature_step: cleanStep(f.squad_signature_step),
      team_milestones: f.team_milestones,
      team_door_step: cleanStep(f.team_door_step),
      team_signature_step: cleanStep(f.team_signature_step),
      updated_at: new Date().toISOString(),
    })
    .eq('id', true)
  feedSaving.value = false
  if (error) {
    feedError.value = 'Could not save — try again.'
    return
  }
  feedSaved.value = true
  setTimeout(() => (feedSaved.value = false), 2000)
}
</script>

<template>
  <AppShell title="Admin Dashboard">
    <div class="grid">
      <div class="card">
        <h3>Leaderboards</h3>
        <template v-if="settings">
          <div class="field">
            <label id="primary-metric-label">Ranking metric</label>
            <AppSelect
              :model-value="settings.primary_metric"
              :options="metricOptions"
              aria-labelledby="primary-metric-label"
              @update:model-value="settings.primary_metric = $event as LeaderboardMetric"
            />
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

      <!-- The team feed's knobs: what shows per-event, and where the
           milestone lines fall. The feed itself derives everything from
           knock_logs client-side — these are the only server settings. -->
      <div class="card">
        <h3>Activity Feed</h3>
        <template v-if="feed">
          <label class="check">
            <input type="checkbox" v-model="feed.show_signatures" />
            Show each signature as it lands
          </label>
          <label class="check">
            <input type="checkbox" v-model="feed.show_knocks" />
            Show every knock too
          </label>
          <label class="check">
            <input type="checkbox" v-model="feed.person_milestones" />
            Personal milestones
          </label>
          <div v-if="feed.person_milestones" class="step-row">
            every <input type="number" min="1" v-model.number="feed.person_door_step" /> doors
          </div>
          <label class="check">
            <input type="checkbox" v-model="feed.squad_milestones" />
            Squad milestones
          </label>
          <div v-if="feed.squad_milestones" class="step-row">
            every <input type="number" min="1" v-model.number="feed.squad_door_step" /> doors ·
            <input type="number" min="1" v-model.number="feed.squad_signature_step" /> signatures
          </div>
          <label class="check">
            <input type="checkbox" v-model="feed.team_milestones" />
            Whole-team milestones
          </label>
          <div v-if="feed.team_milestones" class="step-row">
            every <input type="number" min="1" v-model.number="feed.team_door_step" /> doors ·
            <input type="number" min="1" v-model.number="feed.team_signature_step" /> signatures
          </div>
          <div class="actions">
            <button class="btn btn-primary btn-sm" :disabled="feedSaving" @click="saveFeedSettings">
              {{ feedSaved ? 'Saved ✓' : feedSaving ? 'Saving…' : 'Save' }}
            </button>
            <router-link class="btn btn-ghost btn-sm" to="/activity">View feed</router-link>
          </div>
          <p v-if="feedError" class="error">{{ feedError }}</p>
        </template>
        <p v-else class="muted">Loading settings…</p>
      </div>

      <div class="card">
        <h3>Analytics</h3>
        <p class="muted">Charts, probabilities, and build-your-own regression models on the knock data.</p>
        <router-link class="btn btn-primary btn-sm" to="/admin/analytics">Explore</router-link>
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

      <!-- Campaign managers manage all non-admin roles; true admins
           additionally manage admin accounts (the Roles screen adapts). -->
      <div class="card">
        <h3>Roles</h3>
        <p class="muted">Elevate roles, assign teams, place people in today's squads.</p>
        <router-link class="btn btn-primary btn-sm" to="/admin/roles">Manage</router-link>
      </div>

      <div class="card">
        <h3>Turf Assignment</h3>
        <p class="muted">Sweep street ranges on the map into turf for squads or canvassers.</p>
        <router-link class="btn btn-primary btn-sm" to="/turf">Cut turf</router-link>
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

/* Indented "every N doors" rows under their milestone toggle. */
.step-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: -0.45rem 0 0.75rem 1.75rem;
  font-size: 0.88rem;
  color: var(--text-muted);
}

.step-row input {
  width: 4.2em;
  padding: 0.25rem 0.4rem;
  font: inherit;
  font-size: 0.88rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
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
