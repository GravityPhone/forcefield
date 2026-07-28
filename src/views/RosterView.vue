<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { useSquadsStore } from '@/stores/squads'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { embeddedPhone, telHref } from '@/lib/phone'
import { ROLE_LABELS, type AppRole } from '@/types'

interface RosterMember {
  id: string
  username: string
  display_name: string | null
  avatar: string | null
  color: string | null
  role: AppRole
  team_id: string | null
  team: { name: string } | null
  /** Null unless they saved a number AND they're on your team (RLS). */
  phone: string | null
}

const auth = useAuthStore()
const router = useRouter()

const members = ref<RosterMember[]>([])
// Starts true so first paint shows "Loading…" instead of a false empty state
// while the initial fetch (and, for admins, the teams list) is in flight.
const loading = ref(true)

// Everyone browses their OWN team. Admins have no team (and a manager might
// not be placed yet) — they pick a team to browse, or see everyone.
const needsPicker =
  !auth.profile?.team_id &&
  (auth.profile?.role === 'admin' || auth.profile?.role === 'campaign_manager')
const teams = ref<{ id: string; name: string }[]>([])
const pickedTeamId = ref('')

const teamOptions = computed(() => [
  ...teams.value.map((t) => ({ value: t.id, label: t.name })),
  { value: 'all', label: 'Everyone' },
])

// Leadership floats to the top, then alphabetical — same feel as a printed
// phone tree.
const ROLE_RANK: Record<AppRole, number> = {
  campaign_manager: 0,
  team_lead: 1,
  canvasser: 2,
  admin: 3,
}

const orderedMembers = computed(() =>
  [...members.value].sort(
    (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || memberName(a).localeCompare(memberName(b)),
  ),
)

// Search filters what's already loaded — the roster is one team, small enough
// that a round trip per keystroke would buy nothing.
const query = ref('')
const shownMembers = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return orderedMembers.value
  return orderedMembers.value.filter(
    (m) =>
      m.username.toLowerCase().includes(q) ||
      (m.display_name ?? '').toLowerCase().includes(q),
  )
})

function memberName(m: RosterMember): string {
  return m.display_name || m.username
}

// Guards against an earlier slow response landing after a newer one when the
// admin flips the team picker mid-fetch.
let loadSeq = 0

async function loadMembers() {
  const seq = ++loadSeq
  const scope = needsPicker ? pickedTeamId.value : auth.profile?.team_id
  if (!scope) {
    members.value = []
    loading.value = false
    return
  }
  loading.value = true
  let query = supabase
    .from('profiles')
    .select('id, username, display_name, avatar, color, role, team_id, team:teams(name), member_phones(phone)')
    .order('username')
  if (scope !== 'all') query = query.eq('team_id', scope)
  const { data } = await query
  if (seq !== loadSeq) return // a newer load superseded this one
  loading.value = false
  type Row = Omit<RosterMember, 'phone'> & { member_phones: unknown }
  members.value = ((data ?? []) as unknown as Row[]).map(({ member_phones, ...m }) => ({
    ...m,
    phone: embeddedPhone(member_phones),
  }))
}

onMounted(async () => {
  if (needsPicker) {
    const { data } = await supabase.from('teams').select('id, name').order('name')
    teams.value = data ?? []
    // Setting the picker triggers the watcher's load; only call directly
    // when there's nothing to pick (clears the initial loading state).
    if (teams.value.length) pickedTeamId.value = teams.value[0].id
    else await loadMembers()
  } else {
    await loadMembers()
  }
})

watch(pickedTeamId, () => void loadMembers())

function openMember(id: string) {
  void router.push(`/member/${id}`)
}

// --- Manage sheet (2026-07-28, user asks): elevate people and place them on
// today's squads right here, without a trip to the admin Roles page. Role
// changes are a manager's call; squad placement is managers AND squad leaders.
// The DB enforces both ends: guard_profile_privileges + the profiles UPDATE
// policy let a campaign manager set any non-admin role (never admin), and the
// add/remove squad RPCs gate who may touch a crew. ---

const squads = useSquadsStore()

const canElevate = computed(
  () => auth.profile?.role === 'admin' || auth.profile?.role === 'campaign_manager',
)
const canPlaceSquad = computed(() => canElevate.value || auth.profile?.role === 'team_lead')

/** Never on your own row (your role isn't yours to change, and your own crew
 * is the Squad page's job) and never on an admin's (admins sit outside
 * campaigns, teams and squads). */
function showManageFor(m: RosterMember): boolean {
  if (!canPlaceSquad.value) return false
  return m.id !== auth.profile?.id && m.role !== 'admin'
}

const managing = ref<RosterMember | null>(null)
const manageOpen = ref(false)
const manageError = ref('')
const manageBusy = ref(false)
const savedSection = ref<'role' | 'squad' | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

function flashSaved(section: 'role' | 'squad') {
  savedSection.value = section
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => (savedSection.value = null), 1600)
}

function openManage(m: RosterMember) {
  managing.value = m
  manageOpen.value = true
  manageError.value = ''
  savedSection.value = null
  // Freshest possible squad list at the moment it's about to be used.
  void squads.loadToday()
}

/** Elevation stops at Campaign Manager on purpose: minting admins is the
 * admin's own page's job (/admin/roles), and the DB refuses it here anyway. */
const ROLE_CHOICES: AppRole[] = ['canvasser', 'team_lead', 'campaign_manager']

async function setRole(role: AppRole) {
  const target = managing.value
  if (!target || target.role === role || manageBusy.value) return
  manageBusy.value = true
  manageError.value = ''
  const { error } = await supabase.from('profiles').update({ role }).eq('id', target.id)
  manageBusy.value = false
  if (error) {
    manageError.value = `Could not change ${memberName(target)}'s role. Try again.`
    return
  }
  target.role = role
  flashSaved('role')
}

/** The squad the person being managed is out with today, if any. */
const managingSquad = computed(() => {
  const id = managing.value?.id
  if (!id) return null
  return squads.squads.find((s) => s.members.some((m) => m.id === id)) ?? null
})

async function placeSquad(squadId: string | null) {
  const target = managing.value
  if (!target || manageBusy.value) return
  const current = managingSquad.value
  if ((current?.id ?? null) === squadId) return
  manageBusy.value = true
  manageError.value = ''
  let reason: string | null = null
  if (squadId === null) {
    if (current) reason = await squads.removeMember(current.id, target.id)
  } else {
    // Managers move people between crews in one tap; a squad leader gets the
    // RPC's "Already out with X today" and takes them off that crew first.
    reason = await squads.addMember(squadId, target.id)
    await squads.loadToday()
  }
  manageBusy.value = false
  if (reason) {
    manageError.value = reason
    return
  }
  flashSaved('squad')
}
</script>

<template>
  <AppShell title="Roster">
    <div class="roster-page">
      <div v-if="needsPicker" class="team-pick">
        <span class="muted team-pick-label">Team:</span>
        <AppSelect v-model="pickedTeamId" class="team-select" :options="teamOptions" aria-label="Team to browse" />
      </div>

      <input
        v-model="query"
        class="roster-search"
        data-help="roster-search"
        type="search"
        placeholder="Search people…"
        aria-label="Search the roster"
      />

      <p v-if="!needsPicker && !auth.profile?.team_id" class="muted empty">
        You’re not on a team yet.
      </p>
      <p v-else-if="loading" class="muted empty">Loading…</p>
      <p v-else-if="!members.length" class="muted empty">No one on this team yet.</p>
      <p v-else-if="!shownMembers.length" class="muted empty">No one matches.</p>

      <div v-else class="roster-list" data-help="roster-list">
        <div
          v-for="m in shownMembers"
          :key="m.id"
          class="roster-row"
          :style="{ '--member-color': memberColor(m) }"
          role="button"
          tabindex="0"
          @click="openMember(m.id)"
          @keydown.enter.self.prevent="openMember(m.id)"
          @keydown.space.self.prevent="openMember(m.id)"
        >
          <span class="roster-avatar" :style="!avatarUrl(m.avatar) ? { background: memberColor(m) } : {}">
            <img
              v-if="avatarUrl(m.avatar)"
              :src="avatarUrl(m.avatar)"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <template v-else>{{ memberName(m).slice(0, 1).toUpperCase() }}</template>
          </span>
          <span class="roster-text">
            <span class="roster-name">
              {{ memberName(m) }}
              <span v-if="m.id === auth.profile?.id" class="muted you-tag">(you)</span>
            </span>
            <span class="muted roster-role">
              {{ ROLE_LABELS[m.role]
              }}<template v-if="pickedTeamId === 'all' && m.team"> · {{ m.team.name }}</template>
            </span>
          </span>
          <a
            v-if="m.phone && m.id !== auth.profile?.id"
            class="btn btn-sm call-btn"
            data-help="roster-call"
            :href="telHref(m.phone)"
            :aria-label="`Call ${memberName(m)}`"
            @click.stop
          >
            Call
          </a>
          <button
            v-if="showManageFor(m)"
            class="btn btn-sm manage-btn"
            data-help="roster-manage"
            :aria-label="`Manage ${memberName(m)}`"
            @click.stop="openManage(m)"
          >
            Manage
          </button>
          <span class="roster-chevron muted" aria-hidden="true">›</span>
        </div>
      </div>
    </div>

    <!-- Role and today's squad, right from the roster (2026-07-28). -->
    <BottomSheet
      v-model:open="manageOpen"
      :aria-label="managing ? `Manage ${memberName(managing)}` : 'Manage'"
    >
      <template #header>
        <div v-if="managing" class="sheet-head" :style="{ '--member-color': memberColor(managing) }">
          <span class="roster-avatar" :style="!avatarUrl(managing.avatar) ? { background: memberColor(managing) } : {}">
            <img v-if="avatarUrl(managing.avatar)" :src="avatarUrl(managing.avatar)" alt="" />
            <template v-else>{{ memberName(managing).slice(0, 1).toUpperCase() }}</template>
          </span>
          <div class="sheet-names">
            <span class="roster-name">{{ memberName(managing) }}</span>
            <span class="muted roster-role">{{ ROLE_LABELS[managing.role] }}</span>
          </div>
        </div>
      </template>

      <div v-if="managing" class="manage-body">
        <p v-if="manageError" class="error">{{ manageError }}</p>

        <div v-if="canElevate" class="section">
          <div class="section-head">
            <span class="section-label">Role</span>
            <Transition name="fade">
              <span v-if="savedSection === 'role'" class="saved">Saved ✓</span>
            </Transition>
          </div>
          <div class="segmented" role="group" aria-label="Role">
            <button
              v-for="value in ROLE_CHOICES"
              :key="value"
              class="segment"
              :class="{ active: managing.role === value }"
              :disabled="manageBusy"
              :aria-pressed="managing.role === value"
              @click="setRole(value)"
            >
              {{ ROLE_LABELS[value] }}
            </button>
          </div>
        </div>

        <div class="section">
          <div class="section-head">
            <span class="section-label">Today's squad</span>
            <Transition name="fade">
              <span v-if="savedSection === 'squad'" class="saved">Saved ✓</span>
            </Transition>
          </div>
          <div v-if="squads.squads.length" class="option-list">
            <button
              class="option"
              :class="{ active: !managingSquad }"
              :disabled="manageBusy"
              @click="placeSquad(null)"
            >
              <span>No squad</span>
              <span v-if="!managingSquad" class="check">✓</span>
            </button>
            <button
              v-for="s in squads.squads"
              :key="s.id"
              class="option"
              :class="{ active: managingSquad?.id === s.id }"
              :disabled="manageBusy"
              @click="placeSquad(s.id)"
            >
              <span>👥 {{ s.name }}</span>
              <span class="muted option-sub">{{ s.members.length }} member{{ s.members.length === 1 ? '' : 's' }}</span>
              <span v-if="managingSquad?.id === s.id" class="check">✓</span>
            </button>
          </div>
          <p v-else class="muted hint">No squads yet today.</p>
        </div>
      </div>
    </BottomSheet>
  </AppShell>
</template>

<style scoped>
.roster-page {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  max-width: 640px;
}

.team-pick {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.team-pick-label {
  font-size: 0.9rem;
  flex-shrink: 0;
}

.team-pick :deep(.team-select) {
  flex: 1;
  min-width: 0;
  width: auto;
  max-width: 18rem;
}

.roster-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.roster-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 60px;
  padding: 0.55rem 0.8rem;
  border: 1px solid color-mix(in srgb, var(--member-color) 45%, var(--border));
  border-left: 5px solid var(--member-color);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--member-color) 6%, var(--surface));
  cursor: pointer;
}

.roster-row:hover {
  background: color-mix(in srgb, var(--member-color) 12%, var(--surface));
}

.roster-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2.5px solid var(--member-color);
  overflow: hidden;
  flex-shrink: 0;
  font-weight: 800;
  color: #fff;
}

.roster-avatar img {
  width: 80%;
  height: 80%;
  object-fit: contain;
}

.roster-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.roster-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.you-tag {
  font-weight: 500;
  font-size: 0.85rem;
}

.roster-role {
  font-size: 0.83rem;
}

.call-btn {
  flex-shrink: 0;
  border: 1.5px solid var(--member-color);
  color: var(--member-color);
  background: transparent;
  font-weight: 700;
  text-decoration: none;
}

.roster-search {
  width: 100%;
  min-height: 46px;
  padding: 0.6rem 0.9rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}

.roster-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.manage-btn {
  flex-shrink: 0;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  font-weight: 700;
}

/* --- Manage sheet: same chrome as the Roles page's editor --- */

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

.manage-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0;
  font-size: 0.9rem;
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

.option:disabled {
  cursor: not-allowed;
  opacity: 0.7;
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

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.roster-chevron {
  font-size: 1.3rem;
  flex-shrink: 0;
}

.empty {
  margin: 0;
  font-size: 0.92rem;
}
</style>
