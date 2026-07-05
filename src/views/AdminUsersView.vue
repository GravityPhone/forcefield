<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { localToday } from '@/lib/day'
import { useAuthStore } from '@/stores/auth'
import { ROLE_LABELS } from '@/types'
import type { AppRole, Profile, Squad, Team } from '@/types'

const auth = useAuthStore()

const profiles = ref<Profile[]>([])
const teams = ref<Team[]>([])
const squads = ref<(Squad & { memberIds: string[] })[]>([])
const loading = ref(true)
const error = ref('')
const query = ref('')
/** Row-scoped "Saved ✓" flash so feedback lands next to what was changed. */
const savedUserId = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

async function loadAll() {
  const [p, t, s] = await Promise.all([
    supabase.from('profiles').select('*').order('username'),
    supabase.from('teams').select('*').order('name'),
    supabase
      .from('squads')
      .select('*, squad_members(user_id)')
      .eq('squad_date', localToday())
      .order('created_at'),
  ])
  loading.value = false
  if (p.data) profiles.value = p.data as Profile[]
  if (t.data) teams.value = t.data as Team[]
  type SquadRow = Squad & { squad_members: { user_id: string }[] }
  if (s.data) {
    squads.value = (s.data as SquadRow[]).map((row) => ({
      ...row,
      memberIds: row.squad_members.map((m) => m.user_id),
    }))
  }
}

onMounted(() => void loadAll())

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return profiles.value
  return profiles.value.filter(
    (p) =>
      p.username.toLowerCase().includes(q) ||
      (p.display_name ?? '').toLowerCase().includes(q),
  )
})

function flashSaved(userId: string) {
  savedUserId.value = userId
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => (savedUserId.value = null), 2000)
}

function fail(message: string) {
  error.value = message
  void loadAll() // resync the selects with what the DB actually holds
}

async function setRole(user: Profile, role: AppRole) {
  error.value = ''
  const { error: err } = await supabase.from('profiles').update({ role }).eq('id', user.id)
  if (err) return fail(`Could not change ${user.username}'s role — try again.`)
  user.role = role
  flashSaved(user.id)
}

async function setTeam(user: Profile, teamId: string) {
  error.value = ''
  const { error: err } = await supabase
    .from('profiles')
    .update({ team_id: teamId || null })
    .eq('id', user.id)
  if (err) return fail(`Could not move ${user.username} — try again.`)
  user.team_id = teamId || null
  flashSaved(user.id)
}

function squadOf(userId: string): string {
  return squads.value.find((s) => s.memberIds.includes(userId))?.id ?? ''
}

/** Move a user between today's squads (or out of all of them). Squad and
 * squad-chat rosters move together, same as the join/leave RPCs — an
 * admin-placed member must land in the crew's chat too. */
async function setSquad(user: Profile, squadId: string) {
  error.value = ''
  const current = squads.value.filter((s) => s.memberIds.includes(user.id))
  for (const s of current) {
    if (s.id === squadId) continue
    const { error: err } = await supabase
      .from('squad_members')
      .delete()
      .eq('squad_id', s.id)
      .eq('user_id', user.id)
    if (err) return fail(`Could not move ${user.username} out of ${s.name} — try again.`)
    if (s.chat_id) {
      await supabase.from('chat_members').delete().eq('chat_id', s.chat_id).eq('user_id', user.id)
    }
  }

  const target = squads.value.find((s) => s.id === squadId)
  if (target && !target.memberIds.includes(user.id)) {
    const { error: err } = await supabase
      .from('squad_members')
      .insert({ squad_id: target.id, user_id: user.id })
    if (err) return fail(`Could not add ${user.username} to ${target.name} — try again.`)
    if (target.chat_id) {
      await supabase
        .from('chat_members')
        .insert({ chat_id: target.chat_id, user_id: user.id, added_by: auth.profile?.id ?? null })
    }
  }

  await loadAll()
  flashSaved(user.id)
}

function teamName(teamId: string | null): string {
  return teams.value.find((t) => t.id === teamId)?.name ?? ''
}
</script>

<template>
  <AppShell title="Users &amp; Roles">
    <div class="stack">
      <p class="muted intro">
        Change anyone's role, move them between teams, or place them in one of today's squads.
        Squad placement also moves their squad-chat membership.
      </p>
      <p v-if="error" class="error">{{ error }}</p>

      <input
        v-model="query"
        class="user-search"
        type="search"
        placeholder="Search by username or display name…"
        aria-label="Search users"
      />

      <p v-if="loading" class="muted">Loading users…</p>
      <p v-else-if="!filtered.length" class="muted">No users match.</p>

      <div v-for="u in filtered" :key="u.id" class="card user-card">
        <div class="user-head">
          <div class="user-names">
            <span class="user-name">{{ u.display_name || u.username }}</span>
            <span class="muted user-sub">
              @{{ u.username }}{{ teamName(u.team_id) ? ` · ${teamName(u.team_id)}` : '' }}
            </span>
          </div>
          <span v-if="savedUserId === u.id" class="saved">Saved ✓</span>
        </div>

        <div class="controls">
          <label class="control">
            <span class="muted control-label">Role</span>
            <!-- Your own role is locked here: demoting the account you're
                 using would kick you out of this page mid-edit. -->
            <select
              :value="u.role"
              :disabled="u.id === auth.profile?.id"
              :title="u.id === auth.profile?.id ? 'You can\'t change your own role' : ''"
              @change="setRole(u, ($event.target as HTMLSelectElement).value as AppRole)"
            >
              <option v-for="(label, value) in ROLE_LABELS" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
          </label>

          <label class="control">
            <span class="muted control-label">Team</span>
            <select
              :value="u.team_id ?? ''"
              @change="setTeam(u, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">(no team)</option>
              <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
          </label>

          <label class="control">
            <span class="muted control-label">Today's squad</span>
            <select
              :value="squadOf(u.id)"
              @change="setSquad(u, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">(no squad)</option>
              <option v-for="s in squads" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
        </div>
      </div>

      <p v-if="!loading && !squads.length" class="muted squad-note">
        No squads exist yet today — squads form on the
        <router-link to="/squads">Squads</router-link> page and reset at midnight.
      </p>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.intro {
  margin: 0;
  font-size: 0.92rem;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0;
  font-size: 0.9rem;
}

.user-search {
  width: 100%;
  min-height: 44px;
  padding: 0.6rem 0.8rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.user-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.user-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.user-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}

.user-names {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.user-name {
  font-weight: 700;
}

.user-sub {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved {
  color: var(--success, #2e7d32);
  font-size: 0.85rem;
  font-weight: 700;
  flex-shrink: 0;
}

.controls {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.control {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
  min-width: 9rem;
}

.control-label {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.control select {
  min-height: 40px;
}

.control select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.squad-note {
  margin: 0;
  font-size: 0.88rem;
}
</style>
