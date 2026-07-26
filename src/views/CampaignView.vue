<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import CampaignProgress from '@/components/CampaignProgress.vue'
import { useAuthStore } from '@/stores/auth'
import {
  campaignById,
  campaignOptions,
  joinCampaign,
  loadCampaigns,
  myCampaigns,
  myCampaignIds,
  switchCampaign,
} from '@/lib/campaigns'
import { hapticTap } from '@/lib/native'
import {
  CAMPAIGN_BODY,
  CAMPAIGN_FACTS,
  CAMPAIGN_HEADLINE,
  DEMO_NOTICE,
  TALKING_POINTS,
  THE_ASK,
} from '@/lib/campaignContent'

/** "Campaign" — the one screen in the app that isn't about logging or
 * measuring anything: which campaign you're working, why the signatures are
 * being gathered, and what to say at the door.
 *
 * The switcher sits at the TOP (2026-07-26, user call): a canvasser or squad
 * leader working two efforts changes which one they're on here, and joins
 * another from the same card. The briefing below is a pure render of
 * src/lib/campaignContent.ts — all copy edits happen there — and ships as
 * clearly-labeled placeholder while Forcefield is a demo.
 *
 * Switching changes what this screen reports (and the progress card), not
 * what you can knock: doors, turf, squads and knocks are all org-wide. */

const auth = useAuthStore()

const joined = computed(() => myCampaigns())
const active = computed(() => campaignById(auth.profile?.campaign_id))
/** Joining a second campaign is a canvasser/squad-leader move — a campaign
 * manager runs one campaign, and an admin runs none. */
const canJoinMore = computed(
  () => auth.profile?.role === 'canvasser' || auth.profile?.role === 'team_lead',
)
const joinable = computed(() => campaignOptions.value.filter((c) => !myCampaignIds.value.has(c.id)))

const joinOpen = ref(false)
const busy = ref('')
const error = ref('')

onMounted(() => void loadCampaigns())

async function makeActive(id: string) {
  if (busy.value || id === auth.profile?.campaign_id) return
  busy.value = id
  error.value = ''
  const result = await switchCampaign(id)
  busy.value = ''
  if (result.error) {
    error.value = result.error
    return
  }
  hapticTap('light')
}

async function join(id: string) {
  if (busy.value) return
  busy.value = id
  error.value = ''
  const result = await joinCampaign(id)
  busy.value = ''
  if (result.error) {
    error.value = result.error
    return
  }
  hapticTap('light')
  joinOpen.value = false
}
</script>

<template>
  <AppShell title="Campaign">
    <div class="campaign-page">
      <!-- Which campaign you're on, first thing: the row switches between the
           ones you've joined and ends in the way into another. -->
      <!-- No data-help anchor: /campaign has no help topic on purpose (the
           page is the explanation), and an orphan anchor breaks the
           anchor↔target cross-check. -->
      <div v-if="active || joined.length" class="card switch-card">
        <!-- One campaign and no way to add another (a campaign manager runs
             one) leaves a chip that does nothing the heading doesn't — so the
             row only renders when it's a control. -->
        <div v-if="joined.length > 1 || canJoinMore" class="chips">
          <button
            v-for="c in joined"
            :key="c.id"
            type="button"
            class="chip"
            :class="{ on: c.id === auth.profile?.campaign_id }"
            :aria-pressed="c.id === auth.profile?.campaign_id"
            :disabled="!!busy"
            @click="makeActive(c.id)"
          >
            {{ busy === c.id ? '…' : c.name }}
          </button>
          <button
            v-if="canJoinMore"
            type="button"
            class="chip chip-add"
            :disabled="!!busy"
            @click="joinOpen = true"
          >
            + Join another
          </button>
        </div>
        <h2 v-if="active" class="active-name">{{ active.name }}</h2>
        <p v-if="active?.description" class="active-desc">{{ active.description }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <!-- Demo notice, so nobody reads the placeholder below as a real
           campaign's position. Remove this card when real content lands. -->
      <div class="card demo-note">
        <p>{{ DEMO_NOTICE }}</p>
      </div>

      <!-- One headline, then filler. No sub-headings: there's nothing here
           yet to organize, and inventing section titles for placeholder text
           only makes it look like something it isn't. -->
      <div class="card">
        <h2 class="headline">{{ CAMPAIGN_HEADLINE }}</h2>
        <p v-for="(p, i) in CAMPAIGN_BODY" :key="i">{{ p }}</p>
      </div>

      <!-- The ask: pulled out on its own so it's findable in two seconds on a
           porch. -->
      <div class="card ask-card">
        <h3>The ask, at the door</h3>
        <blockquote class="ask">{{ THE_ASK }}</blockquote>
      </div>

      <div class="card">
        <h3>Talking points</h3>
        <div class="points">
          <article v-for="p in TALKING_POINTS" :key="p.title" class="point">
            <h4>{{ p.title }}</h4>
            <p>{{ p.body }}</p>
          </article>
        </div>
      </div>

      <div class="card">
        <h3>Good to know</h3>
        <dl class="facts">
          <template v-for="f in CAMPAIGN_FACTS" :key="f.label">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value }}</dd>
          </template>
        </dl>
      </div>

      <!-- Where the campaign actually stands — the same live card the
           dashboard shows. -->
      <CampaignProgress :key="auth.profile?.campaign_id ?? 'none'" />
    </div>

    <BottomSheet v-model:open="joinOpen" title="Join a campaign">
      <div class="join-sheet">
        <p v-if="!joinable.length" class="muted">You're on every open campaign.</p>
        <button
          v-for="c in joinable"
          :key="c.id"
          type="button"
          class="join-row"
          :disabled="!!busy"
          @click="join(c.id)"
        >
          <span class="join-name">{{ busy === c.id ? 'Joining…' : c.name }}</span>
          <span v-if="c.description" class="join-desc">{{ c.description }}</span>
          <span class="join-meta">
            <span>{{ c.members.toLocaleString() }} {{ c.members === 1 ? 'member' : 'members' }}</span>
            <span v-if="c.signature_goal">Goal {{ c.signature_goal.toLocaleString() }}</span>
          </span>
        </button>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
    </BottomSheet>
  </AppShell>
</template>

<style scoped>
.campaign-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 720px;
}

.campaign-page h2,
.campaign-page h3,
.campaign-page h4 {
  margin: 0;
}

.campaign-page p {
  margin: 0.5rem 0 0;
}

.headline {
  font-size: 1.3rem;
}

/* --- Which campaign you're on, and the way into another --- */

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.chip {
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.chip-add {
  border-style: dashed;
  font-weight: 600;
}

.chip:disabled {
  opacity: 0.6;
  cursor: default;
}

.active-name {
  font-size: 1.25rem;
}

.chips + .active-name {
  margin-top: 0.7rem;
}

.active-desc {
  margin-top: 0.2rem;
  color: var(--text-muted);
}

.error {
  margin: 0.5rem 0 0;
  color: var(--danger, #c0392b);
  font-size: 0.9rem;
}

/* --- Join sheet --- */

.join-sheet {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-bottom: 0.5rem;
}

.join-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.2rem;
  width: 100%;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: normal;
  cursor: pointer;
}

.join-name {
  font-weight: 800;
}

.join-desc {
  font-size: 0.9rem;
  line-height: 1.4;
}

.join-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.9rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  font-weight: 600;
}

.section {
  margin-top: 1rem;
}

.section-sub {
  margin-top: 0.3rem;
  font-size: 0.9rem;
}

/* The demo notice reads as an aside, not as campaign copy. */
.demo-note {
  border-left: 4px solid var(--accent);
}

.demo-note h3 {
  color: var(--accent);
}

.ask {
  margin: 0.6rem 0 0;
  padding: 0.75rem 0.9rem;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 1.02rem;
  line-height: 1.5;
}

.points {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.6rem;
  margin-top: 0.7rem;
}

.point {
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.point h4 {
  font-size: 0.95rem;
}

.point p {
  margin-top: 0.35rem;
  font-size: 0.9rem;
}

.facts {
  margin: 0.7rem 0 0;
}

.facts dt {
  font-weight: 700;
}

.facts dt:first-child {
  margin-top: 0;
}

/* Facts read as a two-column list on anything wider than a phone. */
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.45rem 0.9rem;
}

.facts dd {
  margin: 0;
}

/* …and inside the 430px desktop phone frame (style.css). */
@media (max-width: 480px), (min-width: 820px) {
  .facts {
    display: block;
  }

  .facts dt {
    margin-top: 0.7rem;
  }

  .facts dd {
    margin-top: 0.15rem;
  }
}
</style>
