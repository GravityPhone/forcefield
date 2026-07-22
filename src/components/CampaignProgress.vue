<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { supabase } from '@/lib/supabase'
import type { Campaign } from '@/types'

/** Whole-campaign totals. Everyone sees their own campaign; org admins get
 * a switcher across all campaigns (`switchable`). */
const props = defineProps<{ switchable?: boolean }>()

interface CampaignStats {
  campaign_id: string
  campaign_name: string
  doors: number
  signatures: number
  doors_7d: number
  signatures_7d: number
  canvassers: number
  signature_goal: number | null
}

const stats = ref<CampaignStats | null>(null)
const campaigns = ref<Campaign[]>([])
const selectedId = ref<string>('')
const loading = ref(true)

const signRate = computed(() => {
  if (!stats.value || !stats.value.doors) return null
  return Math.round((stats.value.signatures / stats.value.doors) * 100)
})

/** Progress toward the campaign's signature goal, when one is set. */
const goalPct = computed(() => {
  const s = stats.value
  if (!s?.signature_goal) return null
  return Math.min(100, (s.signatures / s.signature_goal) * 100)
})

const campaignOptions = computed(() =>
  campaigns.value.map((c) => ({ value: c.id, label: c.name })),
)

async function loadStats(cid: string | null) {
  loading.value = true
  const { data } = await supabase.rpc('get_campaign_stats', { cid })
  loading.value = false
  const row = (data as CampaignStats[] | null)?.[0]
  stats.value = row
    ? {
        ...row,
        doors: Number(row.doors),
        signatures: Number(row.signatures),
        doors_7d: Number(row.doors_7d),
        signatures_7d: Number(row.signatures_7d),
        canvassers: Number(row.canvassers),
        signature_goal: row.signature_goal == null ? null : Number(row.signature_goal),
      }
    : null
}

async function switchCampaign(cid: string) {
  selectedId.value = cid
  await loadStats(cid)
}

onMounted(async () => {
  if (props.switchable) {
    const { data } = await supabase.from('campaigns').select('*').order('created_at')
    campaigns.value = (data ?? []) as Campaign[]
    const first = campaigns.value[0]
    if (first) {
      await switchCampaign(first.id)
      return
    }
    loading.value = false
    return
  }
  await loadStats(null)
})
</script>

<template>
  <div class="card progress-card">
    <div class="head">
      <h3>Campaign progress</h3>
      <AppSelect
        v-if="switchable && campaignOptions.length"
        small
        :model-value="selectedId"
        :options="campaignOptions"
        aria-label="Campaign"
        @update:model-value="switchCampaign($event)"
      />
    </div>

    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="!stats" class="muted">
      {{ switchable ? 'No campaigns yet.' : "Your team isn't assigned to a campaign yet." }}
    </p>
    <template v-else>
      <p class="campaign-name">{{ stats.campaign_name }}</p>
      <div v-if="goalPct !== null && stats.signature_goal" class="goal">
        <div class="goal-labels">
          <span class="goal-line">
            <strong>{{ stats.signatures.toLocaleString() }}</strong>
            of {{ stats.signature_goal.toLocaleString() }} signatures
          </span>
          <span class="goal-pct">{{ Math.floor(goalPct) }}%</span>
        </div>
        <div
          class="goal-track"
          role="progressbar"
          :aria-valuenow="stats.signatures"
          :aria-valuemin="0"
          :aria-valuemax="stats.signature_goal"
          aria-label="Signature goal progress"
        >
          <div class="goal-fill" :style="{ width: `${goalPct}%` }" />
        </div>
      </div>
      <div class="tiles">
        <div class="tile">
          <span class="num">{{ stats.signatures.toLocaleString() }}</span>
          <span class="lbl">Signatures</span>
          <span class="sub muted">+{{ stats.signatures_7d.toLocaleString() }} this week</span>
        </div>
        <div class="tile">
          <span class="num">{{ stats.doors.toLocaleString() }}</span>
          <span class="lbl">Doors knocked</span>
          <span class="sub muted">+{{ stats.doors_7d.toLocaleString() }} this week</span>
        </div>
        <div class="tile">
          <span class="num">{{ signRate === null ? '—' : `${signRate}%` }}</span>
          <span class="lbl">Sign rate</span>
          <span class="sub muted">of doors knocked</span>
        </div>
        <div class="tile">
          <span class="num">{{ stats.canvassers.toLocaleString() }}</span>
          <span class="lbl">Canvassers</span>
          <span class="sub muted">have knocked doors</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.progress-card {
  margin-bottom: 1rem;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  margin-bottom: 0.5rem;
}

.head h3 {
  margin: 0;
}

.campaign-name {
  margin: 0 0 0.6rem;
  font-weight: 700;
  color: var(--accent);
}

/* Goal progress bar — only renders when the campaign has a target set. */
.goal {
  margin: 0 0 0.8rem;
}

.goal-labels {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
  margin-bottom: 0.3rem;
  font-size: 0.9rem;
}

.goal-pct {
  font-weight: 800;
  color: var(--accent);
}

.goal-track {
  height: 10px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow: hidden;
}

.goal-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.4s ease;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 0.6rem;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.num {
  font-size: 1.45rem;
  font-weight: 800;
  line-height: 1.1;
}

.lbl {
  font-weight: 600;
  font-size: 0.85rem;
}

.sub {
  font-size: 0.75rem;
}
</style>
