<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { OUTCOME_HEX, OUTCOME_LABELS } from '@/lib/outcomes'
import { embeddedPhone, telHref } from '@/lib/phone'
import { ROLE_LABELS, type AppRole, type KnockOutcome } from '@/types'

interface MemberProfile {
  id: string
  username: string
  display_name: string | null
  avatar: string | null
  color: string | null
  role: AppRole
  team_id: string | null
  bio: string | null
  why_canvassing: string | null
  fun_fact: string | null
  team: { name: string } | null
  /** Null unless they saved a number AND they're on your team (RLS). */
  phone: string | null
}

interface VisitRow {
  id: string
  outcome: KnockOutcome
  occurred_at: string
  person: { name: string } | null
  addresses: { street: string; unit: string | null; city: string } | null
}

const route = useRoute()
const auth = useAuthStore()

const member = ref<MemberProfile | null>(null)
const visits = ref<VisitRow[]>([])
const loading = ref(true)

async function load() {
  const id = route.params.id
  if (typeof id !== 'string') return
  loading.value = true
  const [profileRes, visitsRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, avatar, color, role, team_id, bio, why_canvassing, fun_fact, team:teams(name), member_phones(phone)')
      .eq('id', id)
      .maybeSingle(),
    // Same org-readable knock_logs the leaderboards use — just this member's,
    // newest first, with the door embedded for display.
    supabase
      .from('knock_logs')
      .select('id, outcome, occurred_at, person:persons(name), addresses!inner(street, unit, city)')
      .eq('canvasser_id', id)
      .order('occurred_at', { ascending: false })
      .limit(100),
  ])
  type Row = Omit<MemberProfile, 'phone'> & { member_phones: unknown }
  const row = profileRes.data as unknown as Row | null
  member.value = row
    ? (({ member_phones, ...m }) => ({ ...m, phone: embeddedPhone(member_phones) }))(row)
    : null
  visits.value = (visitsRes.data ?? []) as unknown as VisitRow[]
  loading.value = false
}

onMounted(load)
watch(() => route.params.id, load)

function memberName(m: MemberProfile): string {
  return m.display_name || m.username
}

/** "Sat, Jul 5 · 3:12 PM" — same format as Talk mode's door history. */
function visitWhen(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const day = d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${day} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function doorLine(v: VisitRow): string {
  if (!v.addresses) return 'Unknown address'
  return `${v.addresses.street}${v.addresses.unit ? ' ' + v.addresses.unit : ''}`
}
</script>

<template>
  <AppShell title="Member">
    <div class="member-page">
      <router-link class="back-link" to="/roster">‹ Roster</router-link>

      <p v-if="loading" class="muted empty">Loading…</p>
      <p v-else-if="!member" class="muted empty">Couldn’t find that member.</p>

      <template v-else>
        <div class="card head" :style="{ '--member-color': memberColor(member) }">
          <span class="head-avatar" :style="!avatarUrl(member.avatar) ? { background: memberColor(member) } : {}">
            <img v-if="avatarUrl(member.avatar)" :src="avatarUrl(member.avatar)" alt="" />
            <template v-else>{{ memberName(member).slice(0, 1).toUpperCase() }}</template>
          </span>
          <span class="head-text">
            <span class="head-name">
              {{ memberName(member) }}
              <span v-if="member.id === auth.profile?.id" class="muted you-tag">(you)</span>
            </span>
            <span class="muted head-role">
              {{ ROLE_LABELS[member.role] }}<template v-if="member.team"> · {{ member.team.name }}</template>
            </span>
          </span>
          <router-link
            v-if="member.id === auth.profile?.id"
            class="btn btn-sm head-edit"
            to="/profile"
          >
            Edit
          </router-link>
          <a
            v-else-if="member.phone"
            class="btn btn-sm btn-primary head-call"
            :href="telHref(member.phone)"
            :aria-label="`Call ${memberName(member)}`"
          >
            Call
          </a>
        </div>

        <!-- About — only the fields they actually filled in. -->
        <div v-if="member.bio || member.why_canvassing || member.fun_fact" class="card about">
          <p v-if="member.bio" class="about-bio">{{ member.bio }}</p>
          <div v-if="member.why_canvassing" class="about-item">
            <span class="about-label muted">Why I’m canvassing</span>
            <p class="about-text">{{ member.why_canvassing }}</p>
          </div>
          <div v-if="member.fun_fact" class="about-item">
            <span class="about-label muted">Fun fact</span>
            <p class="about-text">{{ member.fun_fact }}</p>
          </div>
        </div>
        <p v-else class="muted empty">
          No intro yet{{ member.id === auth.profile?.id ? ' — add one on the About me page.' : '.' }}
        </p>

        <!-- Recent knocks, same visual language as Talk mode's door history. -->
        <div class="card visits">
          <h3 class="visits-title">
            Recent visits
            <span class="muted visits-count">
              {{ visits.length ? `last ${visits.length}` : '' }}
            </span>
          </h3>
          <ul v-if="visits.length" class="visit-list">
            <li v-for="v in visits" :key="v.id" class="visit-row">
              <span class="visit-dot" :style="{ background: OUTCOME_HEX[v.outcome] }" aria-hidden="true"></span>
              <span class="visit-main">
                <span class="visit-what">
                  <strong>{{ doorLine(v) }}</strong>
                  <template v-if="v.addresses?.city"> · {{ v.addresses.city }}</template>
                </span>
                <span class="muted visit-meta">
                  {{ OUTCOME_LABELS[v.outcome] }}<template v-if="v.person?.name"> — {{ v.person.name }}</template>
                  · {{ visitWhen(v.occurred_at) }}
                </span>
              </span>
            </li>
          </ul>
          <p v-else class="muted empty">No doors knocked yet.</p>
        </div>
      </template>
    </div>
  </AppShell>
</template>

<style scoped>
.member-page {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  max-width: 640px;
}

.back-link {
  align-self: flex-start;
  font-weight: 700;
  font-size: 0.92rem;
  color: var(--accent);
}

.head {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.9rem 1rem;
  border-left: 5px solid var(--member-color);
}

.head-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2.5px solid var(--member-color);
  overflow: hidden;
  flex-shrink: 0;
  font-weight: 800;
  font-size: 1.4rem;
  color: #fff;
}

.head-avatar img {
  width: 80%;
  height: 80%;
  object-fit: contain;
}

.head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.head-name {
  font-weight: 800;
  font-size: 1.1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.you-tag {
  font-weight: 500;
  font-size: 0.85rem;
}

.head-role {
  font-size: 0.88rem;
}

.head-edit,
.head-call {
  margin-left: auto;
  flex-shrink: 0;
}

.head-call {
  text-decoration: none;
}

.about {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1rem;
}

.about-bio {
  margin: 0;
  white-space: pre-line;
  line-height: 1.5;
}

.about-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.about-label {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.about-text {
  margin: 0;
  line-height: 1.45;
}

.visits {
  padding: 1rem;
}

.visits-title {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.visits-count {
  font-weight: 500;
  font-size: 0.8rem;
}

.visit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  /* Long histories scroll inside the card, like Talk mode's door history. */
  max-height: 24rem;
  overflow-y: auto;
}

.visit-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.visit-dot {
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  margin-top: 0.25rem;
  border: 1.5px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
}

.visit-main {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.visit-what {
  font-size: 0.9rem;
}

.visit-meta {
  font-size: 0.8rem;
}

.empty {
  margin: 0;
  font-size: 0.92rem;
}
</style>
