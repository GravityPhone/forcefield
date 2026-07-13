<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { fadeUp, popIn } from '@/lib/motion'
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

type RoleFilter = 'all' | AppRole
const roleFilter = ref<RoleFilter>('all')

/** User whose editor sheet shows, and which section just saved (drives the
 * per-section "Saved ✓" flash inside the sheet). `editing` deliberately keeps
 * its last user after closing so the sheet stays populated through the
 * slide-down animation — `sheetOpen` alone controls visibility. */
const editing = ref<Profile | null>(null)
const sheetOpen = ref(false)
const savedSection = ref<'role' | 'team' | 'squad' | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

function openSheet(user: Profile) {
  editing.value = user
  sheetOpen.value = true
}

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

const roleCounts = computed(() => {
  const counts: Record<RoleFilter, number> = { all: profiles.value.length, canvasser: 0, team_lead: 0, campaign_manager: 0, admin: 0 }
  for (const p of profiles.value) counts[p.role]++
  return counts
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return profiles.value.filter((p) => {
    if (roleFilter.value !== 'all' && p.role !== roleFilter.value) return false
    if (!q) return true
    return (
      p.username.toLowerCase().includes(q) || (p.display_name ?? '').toLowerCase().includes(q)
    )
  })
})

// --- Avatar: initials on a hue derived from the username, so every user
// gets a stable identifying color without storing anything. ---

function initialsOf(p: Profile): string {
  const name = p.display_name || p.username
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

function hueOf(p: Profile): number {
  let h = 0
  for (const ch of p.username) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function avatarStyle(p: Profile) {
  const h = hueOf(p)
  return {
    background: `linear-gradient(135deg, hsl(${h} 65% 52%), hsl(${(h + 40) % 360} 65% 40%))`,
  }
}

function teamName(teamId: string | null): string | null {
  return teams.value.find((t) => t.id === teamId)?.name ?? null
}

function squadOf(userId: string): (Squad & { memberIds: string[] }) | null {
  return squads.value.find((s) => s.memberIds.includes(userId)) ?? null
}

const isSelf = computed(() => editing.value?.id === auth.profile?.id)

// Only true admins manage admin accounts or hand out the admin role. Campaign
// managers run the whole non-admin roster but can't touch (or mint) admins —
// the DB enforces this too (guard_profile_privileges + the profiles UPDATE
// policy); the UI just hides what they can't do.
const isSuperAdmin = computed(() => auth.profile?.role === 'admin')

const roleOptions = computed(() =>
  (Object.entries(ROLE_LABELS) as [AppRole, string][]).filter(
    ([value]) => isSuperAdmin.value || value !== 'admin',
  ),
)

/** A manager may not edit an admin at all — the sheet goes read-only for them. */
const canManageEditing = computed(
  () => isSuperAdmin.value || editing.value?.role !== 'admin',
)

// --- Saves: instant on tap, with a section-scoped flash. On failure the
// list reloads so the UI never shows a state the DB doesn't hold. ---

function flashSaved(section: 'role' | 'team' | 'squad') {
  savedSection.value = section
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => (savedSection.value = null), 1600)
}

function fail(message: string) {
  error.value = message
  void loadAll()
}

async function setRole(user: Profile, role: AppRole) {
  if (user.role === role) return
  error.value = ''
  const { error: err } = await supabase.from('profiles').update({ role }).eq('id', user.id)
  if (err) return fail(`Could not change ${user.username}'s role — try again.`)
  user.role = role
  flashSaved('role')
}

async function setTeam(user: Profile, teamId: string | null) {
  if ((user.team_id ?? null) === teamId) return
  error.value = ''
  const { error: err } = await supabase
    .from('profiles')
    .update({ team_id: teamId })
    .eq('id', user.id)
  if (err) return fail(`Could not move ${user.username} — try again.`)
  user.team_id = teamId
  flashSaved('team')
}

/** Move a user between today's squads (or out of all of them). Squad and
 * squad-chat rosters move together, same as the join/leave RPCs — an
 * admin-placed member must land in the crew's chat too. */
async function setSquad(user: Profile, squadId: string | null) {
  if ((squadOf(user.id)?.id ?? null) === squadId) return
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
  flashSaved('squad')
}

function closeSheet() {
  sheetOpen.value = false
  savedSection.value = null
  error.value = ''
}

const FILTERS: { value: RoleFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'admin', label: 'Admins' },
  { value: 'campaign_manager', label: 'Managers' },
  { value: 'team_lead', label: 'Squad Leaders' },
  { value: 'canvasser', label: 'Canvassers' },
]
</script>

<template>
  <AppShell title="Roles">
    <div class="stack">
      <input
        v-model="query"
        class="user-search"
        type="search"
        placeholder="Search by name or username…"
        aria-label="Search users"
      />

      <div class="filter-chips" role="group" aria-label="Filter by role">
        <button
          v-for="f in FILTERS"
          :key="f.value"
          class="chip"
          :class="{ active: roleFilter === f.value }"
          :aria-pressed="roleFilter === f.value"
          @click="roleFilter = f.value"
        >
          {{ f.label }}
          <span class="chip-count">{{ roleCounts[f.value] }}</span>
        </button>
      </div>

      <p v-if="error && !sheetOpen" class="error">{{ error }}</p>
      <p v-if="loading" class="muted">Loading users…</p>
      <p v-else-if="!filtered.length" class="muted">No users match.</p>

      <div v-else class="user-list card">
        <button
          v-for="(u, i) in filtered"
          :key="u.id"
          v-motion="fadeUp(Math.min(i, 10) * 30)"
          class="user-row"
          @click="openSheet(u)"
        >
          <span class="avatar" :style="avatarStyle(u)" aria-hidden="true">{{ initialsOf(u) }}</span>
          <span class="user-main">
            <span class="user-name-line">
              <span class="user-name">{{ u.display_name || u.username }}</span>
              <span v-if="u.id === auth.profile?.id" class="muted you-tag">you</span>
            </span>
            <span class="muted user-sub">
              @{{ u.username
              }}<template v-if="teamName(u.team_id)"> · {{ teamName(u.team_id) }}</template>
              <template v-if="squadOf(u.id)"> · 👥 {{ squadOf(u.id)!.name }}</template>
            </span>
          </span>
          <span class="role-pill" :class="`role-${u.role}`">{{ ROLE_LABELS[u.role] }}</span>
          <span class="chevron" aria-hidden="true">›</span>
        </button>
      </div>
    </div>

    <!-- Editor sheet: slides up from the bottom, phone-first. Reka Dialog
         underneath (focus trap, Esc, scroll lock) via the shared BottomSheet. -->
    <BottomSheet
      v-model:open="sheetOpen"
      :aria-label="editing ? `Edit ${editing.username}` : 'Edit user'"
    >
      <template #header>
        <div v-if="editing" class="sheet-head">
          <span class="avatar avatar-lg" :style="avatarStyle(editing)" aria-hidden="true">
            {{ initialsOf(editing) }}
          </span>
          <div class="sheet-names">
            <span class="user-name">{{ editing.display_name || editing.username }}</span>
            <span class="muted user-sub">@{{ editing.username }}</span>
          </div>
        </div>
      </template>

      <template v-if="editing">
        <p v-if="error" class="error">{{ error }}</p>

          <div class="section">
            <div class="section-head">
              <span class="section-label">Role</span>
              <Transition name="fade">
                <span v-if="savedSection === 'role'" v-motion="popIn()" class="saved">Saved ✓</span>
              </Transition>
            </div>
            <div class="segmented" role="group" aria-label="Role">
              <button
                v-for="[value, label] in roleOptions"
                :key="value"
                class="segment"
                :class="{ active: editing.role === value }"
                :disabled="isSelf || !canManageEditing"
                :aria-pressed="editing.role === value"
                @click="setRole(editing, value)"
              >
                {{ label }}
              </button>
            </div>
            <p v-if="isSelf" class="muted hint">You can't change your own role.</p>
            <p v-else-if="!canManageEditing" class="muted hint">
              Only admins can manage admin accounts.
            </p>
          </div>

          <!-- Admins run the org — they're never on a team or in a squad. -->
          <p v-if="editing.role === 'admin'" class="muted hint">
            Admins aren't part of a campaign, team, or squad.
          </p>

          <div v-if="editing.role !== 'admin'" class="section">
            <div class="section-head">
              <span class="section-label">Team</span>
              <Transition name="fade">
                <span v-if="savedSection === 'team'" v-motion="popIn()" class="saved">Saved ✓</span>
              </Transition>
            </div>
            <div class="option-list">
              <button
                class="option"
                :class="{ active: editing.team_id === null }"
                @click="setTeam(editing, null)"
              >
                <span>No team</span>
                <span v-if="editing.team_id === null" class="check">✓</span>
              </button>
              <button
                v-for="t in teams"
                :key="t.id"
                class="option"
                :class="{ active: editing.team_id === t.id }"
                @click="setTeam(editing, t.id)"
              >
                <span>{{ t.name }}</span>
                <span v-if="editing.team_id === t.id" class="check">✓</span>
              </button>
            </div>
          </div>

          <div v-if="editing.role !== 'admin'" class="section">
            <div class="section-head">
              <span class="section-label">Today's squad</span>
              <Transition name="fade">
                <span v-if="savedSection === 'squad'" v-motion="popIn()" class="saved">Saved ✓</span>
              </Transition>
            </div>
            <div v-if="squads.length" class="option-list">
              <button
                class="option"
                :class="{ active: !squadOf(editing.id) }"
                @click="setSquad(editing, null)"
              >
                <span>No squad</span>
                <span v-if="!squadOf(editing.id)" class="check">✓</span>
              </button>
              <button
                v-for="s in squads"
                :key="s.id"
                class="option"
                :class="{ active: squadOf(editing.id)?.id === s.id }"
                @click="setSquad(editing, s.id)"
              >
                <span>👥 {{ s.name }}</span>
                <span class="muted option-sub">{{ s.memberIds.length }} member{{ s.memberIds.length === 1 ? '' : 's' }}</span>
                <span v-if="squadOf(editing.id)?.id === s.id" class="check">✓</span>
              </button>
            </div>
            <p v-else class="muted hint">
              No squads yet today — they form on the
              <router-link to="/squads">Squads</router-link> page and reset at midnight.
            </p>
          </div>
      </template>
    </BottomSheet>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0;
  font-size: 0.9rem;
}

.user-search {
  width: 100%;
  min-height: 46px;
  padding: 0.6rem 0.9rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}

.user-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.filter-chips {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.75rem;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.chip:hover {
  background: var(--surface-2);
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast, #fff);
}

.chip-count {
  font-size: 0.75rem;
  font-weight: 700;
  opacity: 0.75;
}

/* --- User list: one card, divided rows --- */

.user-list {
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
}

.user-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  min-height: 60px;
  padding: 0.6rem 0.65rem;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.user-row:hover {
  background: var(--surface-2);
}

.user-row + .user-row {
  border-top: 1px solid var(--border);
}

.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  user-select: none;
}

.avatar-lg {
  width: 46px;
  height: 46px;
  font-size: 0.95rem;
}

.user-main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.user-name-line {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
}

.user-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.you-tag {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.user-sub {
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Role pills: fixed identity colors (like the outcome colors, deliberately
 * independent of the appearance scheme) so a role reads the same at a
 * glance in every theme. */
.role-pill {
  padding: 0.22rem 0.6rem;
  font-size: 0.74rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 999px;
  color: #fff;
  flex-shrink: 0;
}

.role-admin {
  background: #7c3aed;
}

.role-campaign_manager {
  background: #c2410c;
}

.role-team_lead {
  background: #0891b2;
}

.role-canvasser {
  background: #64748b;
}

.chevron {
  color: var(--text-muted);
  font-size: 1.2rem;
  line-height: 1;
  flex-shrink: 0;
}

/* --- Bottom sheet editor (chrome lives in ui/BottomSheet.vue) --- */

.sheet-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.sheet-names {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  min-height: 1.1rem;
}

.section-label {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.saved {
  color: var(--success, #2e7d32);
  font-size: 0.82rem;
  font-weight: 700;
}

.hint {
  margin: 0;
  font-size: 0.85rem;
}

/* Segmented role control */
.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-2);
}

.segment {
  flex: 1;
  min-height: 44px;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.segment + .segment {
  border-left: 1px solid var(--border);
}

.segment.active {
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}

.segment:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* Team / squad option lists */
.option-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 46px;
  padding: 0.55rem 0.8rem;
  border: none;
  background: var(--surface);
  font: inherit;
  font-size: 0.92rem;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.option:hover {
  background: var(--surface-2);
}

.option + .option {
  border-top: 1px solid var(--border);
}

.option.active {
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  font-weight: 600;
}

.option-sub {
  font-size: 0.8rem;
  margin-left: auto;
}

.check {
  margin-left: auto;
  color: var(--accent);
  font-weight: 800;
}

.option .option-sub + .check {
  margin-left: 0.5rem;
}

/* --- Transitions --- */

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
