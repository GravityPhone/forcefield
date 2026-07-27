<script lang="ts">
// See LandingView: named for App.vue's keep-alive `exclude` list. This one is a
// gate you pass through once, so there is nothing to come back to either.
export default { name: 'ChooseCampaignView' }
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppLogo from '@/components/AppLogo.vue'
import { useAuthStore, roleHome } from '@/stores/auth'
import { campaignOptions, campaignsLoading, joinCampaign, loadCampaigns } from '@/lib/campaigns'
import { hapticTap } from '@/lib/native'

/** The gate a new account passes through before it sees anything else: which
 * campaign are you knocking for?
 *
 * It sits outside AppShell on purpose — no nav, no tabs, nothing to wander
 * off into. The router sends every signed-in non-admin here while
 * profiles.campaign_id is null, so quitting doesn't skip it: log out, come
 * back tomorrow, and this is still the first screen.
 *
 * Joining isn't a commitment to be careful about — canvassers and squad
 * leaders join more campaigns from /campaign and switch between them there —
 * so this is one screen and one tap, not a wizard. */

const auth = useAuthStore()
const router = useRouter()

const picked = ref<string>('')
const joining = ref(false)
const error = ref('')

/** First name only, same rule as the app header. */
const firstName = computed(() => {
  const name = auth.profile?.display_name || auth.profile?.username || ''
  return name.split(/\s+/)[0] ?? ''
})

const pickedCampaign = computed(() => campaignOptions.value.find((c) => c.id === picked.value) ?? null)

onMounted(() => void loadCampaigns(true))

function pick(id: string) {
  picked.value = id
  error.value = ''
  hapticTap('light')
}

async function confirm() {
  const id = picked.value
  if (!id || joining.value) return
  joining.value = true
  error.value = ''
  try {
    const result = await joinCampaign(id)
    if (result.error) {
      error.value = result.error
      return
    }
    hapticTap('light')
    void router.push(roleHome(auth.profile!.role))
  } finally {
    joining.value = false
  }
}

async function logOut() {
  await auth.logOut()
  void router.push('/')
}
</script>

<template>
  <div class="choose">
    <div class="choose-inner">
      <div class="brand">
        <span class="brand-mark"><AppLogo size="1em" /></span>
        <span class="brand-name">Forcefield</span>
      </div>

      <header class="intro">
        <h1>{{ firstName ? `Welcome, ${firstName}` : 'Welcome' }}</h1>
        <p class="req">Join a campaign to continue.</p>
      </header>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <p v-if="campaignsLoading && !campaignOptions.length" class="muted state">Loading…</p>
      <p v-else-if="!campaignOptions.length" class="muted state">
        No campaigns are open yet. Ask an admin to start one.
      </p>

      <!-- Tap a card to pick it; the button below names what you're joining,
           which is the confirmation — a second screen to say the same thing
           would just be a screen. -->
      <ul v-else class="list">
        <li v-for="c in campaignOptions" :key="c.id">
          <button
            type="button"
            class="camp"
            :class="{ picked: picked === c.id }"
            :aria-pressed="picked === c.id"
            @click="pick(c.id)"
          >
            <span class="camp-head">
              <span class="camp-name">{{ c.name }}</span>
              <span class="check" aria-hidden="true">✓</span>
            </span>
            <span v-if="c.description" class="camp-desc">{{ c.description }}</span>
            <span class="camp-meta">
              <span>{{ c.members.toLocaleString() }} {{ c.members === 1 ? 'member' : 'members' }}</span>
              <span v-if="c.signature_goal">Goal {{ c.signature_goal.toLocaleString() }}</span>
            </span>
          </button>
        </li>
      </ul>

      <div class="actions">
        <button
          class="btn btn-primary btn-block"
          type="button"
          :disabled="!picked || joining"
          @click="confirm"
        >
          {{ joining ? 'Joining…' : pickedCampaign ? `Join ${pickedCampaign.name}` : 'Join' }}
        </button>
        <button class="btn btn-ghost btn-block" type="button" @click="logOut">Log out</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.choose {
  flex: 1;
  display: flex;
  justify-content: center;
  min-height: 100dvh;
  padding: 2rem 1.25rem 1.5rem;
}

.choose-inner {
  width: 100%;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--accent);
  font-weight: 800;
}

.brand-mark {
  font-size: 1.6rem;
  line-height: 1;
}

.brand-name {
  font-size: 1.05rem;
  letter-spacing: -0.01em;
}

.intro h1 {
  margin: 0;
  font-size: 1.6rem;
  letter-spacing: -0.02em;
}

/* A constraint, not a lesson: it says what has to happen, once. */
.req {
  margin: 0.3rem 0 0;
  font-weight: 600;
  color: var(--text-muted);
}

.state {
  margin: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.camp {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.3rem;
  padding: 0.9rem 1rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: normal;
  cursor: pointer;
}

.camp.picked {
  border-color: var(--accent);
  background: var(--surface-2);
}

.camp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}

.camp-name {
  font-size: 1.1rem;
  font-weight: 800;
}

.check {
  color: var(--accent);
  font-weight: 800;
  opacity: 0;
}

.camp.picked .check {
  opacity: 1;
}

.camp-desc {
  font-size: 0.92rem;
  line-height: 1.4;
}

.camp-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.9rem;
  margin-top: 0.15rem;
  font-size: 0.82rem;
  color: var(--text-muted);
  font-weight: 600;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-top: 0.4rem;
}
</style>
