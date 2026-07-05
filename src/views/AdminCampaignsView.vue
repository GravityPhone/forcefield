<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type { Campaign, Team } from '@/types'

const auth = useAuthStore()

const campaigns = ref<Campaign[]>([])
const teams = ref<Team[]>([])
const loading = ref(true)
const error = ref('')

const newCampaignName = ref('')
const newCampaignDescription = ref('')
const creatingCampaign = ref(false)

const newTeamName = ref('')
const newTeamCampaignId = ref<string>('')
const creatingTeam = ref(false)

async function loadAll() {
  const [c, t] = await Promise.all([
    supabase.from('campaigns').select('*').order('created_at'),
    supabase.from('teams').select('*').order('name'),
  ])
  loading.value = false
  if (c.data) campaigns.value = c.data as Campaign[]
  if (t.data) teams.value = t.data as Team[]
}

onMounted(() => void loadAll())

async function createCampaign() {
  const name = newCampaignName.value.trim()
  if (creatingCampaign.value || !name) return
  creatingCampaign.value = true
  error.value = ''
  const { error: err } = await supabase.from('campaigns').insert({
    name,
    description: newCampaignDescription.value.trim() || null,
    created_by: auth.profile?.id ?? null,
  })
  creatingCampaign.value = false
  if (err) {
    error.value = 'Could not create the campaign — is the name already taken?'
    return
  }
  newCampaignName.value = ''
  newCampaignDescription.value = ''
  await loadAll()
}

async function createTeam() {
  const name = newTeamName.value.trim()
  if (creatingTeam.value || !name) return
  creatingTeam.value = true
  error.value = ''
  const { error: err } = await supabase.from('teams').insert({
    name,
    campaign_id: newTeamCampaignId.value || null,
  })
  creatingTeam.value = false
  if (err) {
    error.value = 'Could not create the team — is the name already taken?'
    return
  }
  newTeamName.value = ''
  await loadAll()
}

async function assignTeam(team: Team, campaignId: string) {
  error.value = ''
  const { error: err } = await supabase
    .from('teams')
    .update({ campaign_id: campaignId || null })
    .eq('id', team.id)
  if (err) {
    error.value = 'Could not move that team — try again.'
    return
  }
  team.campaign_id = campaignId || null
}

function campaignName(id: string | null): string {
  return campaigns.value.find((c) => c.id === id)?.name ?? '(no campaign)'
}

function teamsIn(campaignId: string | null): Team[] {
  return teams.value.filter((t) => t.campaign_id === campaignId)
}

// Reka's Select reserves the empty-string value, so "(no campaign)" rides a
// 'none' sentinel that maps back to '' / null at the call sites.
const campaignOptions = computed(() => [
  { value: 'none', label: '(no campaign)' },
  ...campaigns.value.map((c) => ({ value: c.id, label: c.name })),
])
</script>

<template>
  <AppShell title="Campaigns &amp; Teams">
    <div class="stack">
      <p class="muted intro">
        Campaigns are the big efforts your org runs; each team works one campaign. Day-to-day
        crews (squads) form themselves on the <router-link to="/squads">Squads</router-link> page.
      </p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="loading" class="muted">Loading…</p>

      <template v-else>
        <div class="card">
          <h3>New campaign</h3>
          <div class="field">
            <label for="campaign-name">Name</label>
            <input id="campaign-name" v-model="newCampaignName" placeholder="e.g. UBI" />
          </div>
          <div class="field">
            <label for="campaign-desc">Description (optional)</label>
            <input
              id="campaign-desc"
              v-model="newCampaignDescription"
              placeholder="e.g. Universal Basic Income ballot initiative"
            />
          </div>
          <button
            class="btn btn-primary btn-sm"
            :disabled="creatingCampaign || !newCampaignName.trim()"
            @click="createCampaign"
          >
            {{ creatingCampaign ? 'Creating…' : 'Create campaign' }}
          </button>
        </div>

        <div class="card">
          <h3>New team</h3>
          <div class="field">
            <label for="team-name">Name</label>
            <input id="team-name" v-model="newTeamName" placeholder="e.g. Richwood Team" />
          </div>
          <div class="field">
            <label id="team-campaign-label">Campaign</label>
            <AppSelect
              :model-value="newTeamCampaignId || 'none'"
              :options="campaignOptions"
              aria-labelledby="team-campaign-label"
              @update:model-value="newTeamCampaignId = $event === 'none' ? '' : $event"
            />
          </div>
          <button
            class="btn btn-primary btn-sm"
            :disabled="creatingTeam || !newTeamName.trim()"
            @click="createTeam"
          >
            {{ creatingTeam ? 'Creating…' : 'Create team' }}
          </button>
        </div>

        <div v-for="c in campaigns" :key="c.id" class="card">
          <h3>{{ c.name }}</h3>
          <p v-if="c.description" class="muted desc">{{ c.description }}</p>
          <p v-if="!teamsIn(c.id).length" class="muted desc">No teams assigned yet.</p>
          <div v-for="t in teamsIn(c.id)" :key="t.id" class="team-row">
            <span class="team-name">{{ t.name }}</span>
            <AppSelect
              small
              :model-value="t.campaign_id ?? 'none'"
              :options="campaignOptions"
              :aria-label="`Campaign for ${t.name}`"
              @update:model-value="assignTeam(t, $event === 'none' ? '' : $event)"
            />
          </div>
        </div>

        <div v-if="teamsIn(null).length" class="card">
          <h3>Unassigned teams</h3>
          <div v-for="t in teamsIn(null)" :key="t.id" class="team-row">
            <span class="team-name">{{ t.name }}</span>
            <AppSelect
              small
              :model-value="t.campaign_id ?? 'none'"
              :options="campaignOptions"
              :aria-label="`Campaign for ${t.name}`"
              @update:model-value="assignTeam(t, $event === 'none' ? '' : $event)"
            />
          </div>
        </div>
      </template>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
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

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.6rem;
}

.desc {
  margin: 0 0 0.6rem;
  font-size: 0.9rem;
}

.team-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--border);
}

.team-row:last-child {
  border-bottom: none;
}

.team-name {
  font-weight: 600;
}

.team-row :deep(.sel-trigger) {
  max-width: 12rem;
}
</style>
