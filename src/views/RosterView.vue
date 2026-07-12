<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
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
const loading = ref(false)

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

function memberName(m: RosterMember): string {
  return m.display_name || m.username
}

async function loadMembers() {
  const scope = needsPicker ? pickedTeamId.value : auth.profile?.team_id
  if (!scope) {
    members.value = []
    return
  }
  loading.value = true
  let query = supabase
    .from('profiles')
    .select('id, username, display_name, avatar, color, role, team_id, team:teams(name), member_phones(phone)')
    .order('username')
  if (scope !== 'all') query = query.eq('team_id', scope)
  const { data } = await query
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
    if (teams.value.length) pickedTeamId.value = teams.value[0].id
  }
  await loadMembers()
})

watch(pickedTeamId, () => void loadMembers())

function openMember(id: string) {
  void router.push(`/member/${id}`)
}
</script>

<template>
  <AppShell title="Roster">
    <div class="roster-page">
      <div v-if="needsPicker" class="team-pick">
        <span class="muted team-pick-label">Team:</span>
        <AppSelect v-model="pickedTeamId" class="team-select" :options="teamOptions" aria-label="Team to browse" />
      </div>

      <p v-if="!needsPicker && !auth.profile?.team_id" class="muted empty">
        You’re not on a team yet — once a campaign manager places you, your teammates show up here.
      </p>
      <p v-else-if="loading" class="muted empty">Loading…</p>
      <p v-else-if="!members.length" class="muted empty">No one on this team yet.</p>

      <div v-else class="roster-list">
        <div
          v-for="m in orderedMembers"
          :key="m.id"
          class="roster-row"
          :style="{ '--member-color': memberColor(m) }"
          role="button"
          tabindex="0"
          @click="openMember(m.id)"
          @keydown.enter.prevent="openMember(m.id)"
        >
          <span class="roster-avatar" :style="!avatarUrl(m.avatar) ? { background: memberColor(m) } : {}">
            <img v-if="avatarUrl(m.avatar)" :src="avatarUrl(m.avatar)" alt="" />
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
            v-if="m.phone"
            class="btn btn-sm call-btn"
            :href="telHref(m.phone)"
            :aria-label="`Call ${memberName(m)}`"
            @click.stop
          >
            Call
          </a>
          <span class="roster-chevron muted" aria-hidden="true">›</span>
        </div>
      </div>
    </div>
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

.roster-chevron {
  font-size: 1.3rem;
  flex-shrink: 0;
}

.empty {
  margin: 0;
  font-size: 0.92rem;
}
</style>
