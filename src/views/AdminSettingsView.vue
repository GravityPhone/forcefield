<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import {
  appointmentSettings,
  ensureAppointmentSettings,
  refreshAppointmentSettings,
  windowLabel,
} from '@/lib/appointments'
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
  void ensureAppointmentSettings().then(() => (appt.value = { ...appointmentSettings.value }))
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

// --- Appointments (2026-07-26, user call) ---
//
// The whole feature is OFF until this switch is flipped: no outcome-button
// follow-up, no nav row, no analytics tab. It lives here rather than on
// /appointments itself because a switch can't live on the page it hides —
// which is the one place the 2026-07-21 "knobs on the screen they affect"
// rule can't reach. Collapsed by default: this is a once-a-campaign decision
// sitting under a key field and two data sources, not a daily control.
//
// Edits bind into a draft, not the shared settings ref — a half-typed "1" in
// the minutes box would otherwise redefine every window in the app mid-
// keystroke. Save publishes and re-reads, which is what makes the nav row
// appear without a reload.

const apptOpen = ref(false)
const apptSaving = ref(false)
const apptSaved = ref(false)
const apptError = ref('')
const appt = ref({ ...appointmentSettings.value })

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)))
}

/** The first window of the day as these settings currently read — clamped
 * exactly like Save clamps, so the preview can't promise something the DB
 * would refuse. */
const windowPreview = computed(() => {
  const d = new Date()
  d.setHours(clampInt(appt.value.day_start_hour, 0, 23), 0, 0, 0)
  const end = new Date(d.getTime() + clampInt(appt.value.window_minutes, 15, 480) * 60_000)
  return windowLabel(d, end)
})

async function saveAppointments() {
  apptSaving.value = true
  apptError.value = ''
  const start = clampInt(appt.value.day_start_hour, 0, 23)
  const { error } = await supabase
    .from('appointment_settings')
    .update({
      enabled: appt.value.enabled,
      window_minutes: clampInt(appt.value.window_minutes, 15, 480),
      day_start_hour: start,
      day_end_hour: clampInt(appt.value.day_end_hour, start + 1, 24),
      updated_at: new Date().toISOString(),
    })
    .eq('id', true)
  apptSaving.value = false
  if (error) {
    apptError.value = 'Could not save — try again.'
    return
  }
  await refreshAppointmentSettings()
  appt.value = { ...appointmentSettings.value }
  apptSaved.value = true
  setTimeout(() => (apptSaved.value = false), 2000)
}
</script>

<template>
  <AppShell title="Admin Settings">
    <div class="stack">
      <div class="card" data-help="settings-key">
        <h3>AI Assistant — Anthropic API Key</h3>
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

      <div class="card" data-help="settings-sources">
        <h3>Data Sources</h3>
        <div class="source-row">
          <div><strong>CSV Import (county voter roll)</strong></div>
          <span class="badge">Coming soon</span>
        </div>
        <div class="source-row">
          <div><strong>Connect to Minivan</strong></div>
          <button class="btn btn-ghost" disabled>Coming soon</button>
        </div>
      </div>

      <!-- Off unless a campaign wants it: flipping this is what creates the
           Appointments tab, the nav row, and the outcome button's follow-up. -->
      <div class="card fold-card" data-help="settings-appointments">
        <button class="fold-head" :aria-expanded="apptOpen" @click="apptOpen = !apptOpen">
          <span>Appointments</span>
          <span class="fold-state muted">{{ appointmentSettings.enabled ? 'On' : 'Off' }}</span>
          <span class="fold-caret" aria-hidden="true">{{ apptOpen ? '▴' : '▾' }}</span>
        </button>
        <div v-if="apptOpen" class="fold-body">
          <label class="check">
            <input type="checkbox" v-model="appt.enabled" />
            Offer a time when a door says come back
          </label>
          <div class="step-row">
            window <input type="number" min="15" max="480" step="15" v-model.number="appt.window_minutes" /> minutes
            <span class="preview">{{ windowPreview }}</span>
          </div>
          <div class="step-row">
            between <input type="number" min="0" max="23" v-model.number="appt.day_start_hour" /> and
            <input type="number" min="1" max="24" v-model.number="appt.day_end_hour" /> o’clock
          </div>
          <button class="btn btn-primary btn-sm" :disabled="apptSaving" @click="saveAppointments">
            {{ apptSaved ? 'Saved ✓' : apptSaving ? 'Saving…' : 'Save' }}
          </button>
          <p v-if="apptError" class="error">{{ apptError }}</p>
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

/* --- Tucked-away fold (Appointments): same collapsible the Feed and Board
   options cards use, so a manager already knows what a caret here means. --- */

.fold-card {
  padding: 0;
}

.fold-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.85rem 1rem;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.fold-head > :first-child {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.fold-state {
  font-weight: 600;
  font-size: 0.88rem;
}

.fold-caret {
  color: var(--text-muted);
}

.fold-body {
  padding: 0 1rem 1rem;
}

.check {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.92rem;
  margin: 0 0 0.75rem;
}

.check input {
  width: auto;
}

/* Indented under the switch they only matter beneath. */
.step-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: 0 0 0.75rem 1.75rem;
  font-size: 0.88rem;
  color: var(--text-muted);
}

.step-row input {
  width: 4.6em;
  padding: 0.25rem 0.4rem;
  font: inherit;
  font-size: 0.88rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}

/* The first window of the day, read back from the numbers above it. */
.preview {
  font-weight: 700;
  color: var(--text);
}
</style>
