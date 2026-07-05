<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import type { ChatProfile } from '@/types'

const squads = useSquadsStore()
const router = useRouter()

const composing = ref(false)
const squadName = ref('')
const picked = ref<ChatProfile[]>([])
const creating = ref(false)

onMounted(() => {
  void squads.loadToday()
  squads.subscribeToRosters()
})
onUnmounted(() => squads.unsubscribeFromRosters())

function openComposer() {
  composing.value = true
  squadName.value = ''
  picked.value = []
}

async function createSquad() {
  const name = squadName.value.trim()
  if (creating.value || !name) return
  creating.value = true
  const squad = await squads.createSquad(
    name,
    picked.value.map((p) => p.id),
  )
  creating.value = false
  if (squad) {
    composing.value = false
    openSquadChat(squad)
  }
}

function openSquadChat(squad: SquadListItem) {
  if (!squad.chat_id) return
  void router.push({ path: '/chat', query: { chat: squad.chat_id } })
}

function memberNames(squad: SquadListItem): string {
  return squad.members.map((m) => m.display_name || m.username).join(', ')
}
</script>

<template>
  <AppShell title="Squads">
    <div class="stack">
      <p class="muted intro">
        Squads are today's door-knocking crews — everyone in one shares a squad chat and shows
        up together on the leaderboard. They reset at midnight, so start a fresh one each day.
      </p>

      <button class="btn btn-primary new-squad-btn" @click="openComposer">+ New squad</button>

      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <p v-if="squads.loading && !squads.squads.length" class="muted">Loading today's squads…</p>
      <p v-else-if="!squads.squads.length" class="muted">
        No squads yet today. Start one and invite whoever you're knocking with.
      </p>

      <div v-for="s in squads.squads" :key="s.id" class="card squad-card">
        <div class="squad-info">
          <span class="squad-name">👥 {{ s.name }}</span>
          <span class="muted squad-members">
            {{ s.members.length }} member{{ s.members.length === 1 ? '' : 's' }} —
            {{ memberNames(s) }}
          </span>
        </div>
        <div class="squad-actions">
          <button v-if="s.isMember" class="btn btn-sm btn-primary" @click="openSquadChat(s)">
            Chat
          </button>
          <button v-if="s.isMember" class="btn btn-sm btn-ghost" @click="squads.leaveSquad(s.id)">
            Leave
          </button>
          <button v-else class="btn btn-sm btn-primary" @click="squads.joinSquad(s.id)">
            Join
          </button>
        </div>
      </div>
    </div>

    <!-- New squad dialog -->
    <div v-if="composing" class="overlay" @click.self="composing = false">
      <div class="dialog card">
        <h3>New squad</h3>
        <p class="muted hint">
          Name today's crew and optionally add people now — anyone can also join on their own.
          A squad chat is created automatically.
        </p>
        <div class="field">
          <label for="squad-name">Squad name</label>
          <input id="squad-name" v-model="squadName" placeholder="e.g. Richwood crew" />
        </div>
        <UserPicker v-model="picked" />
        <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
        <div class="dialog-actions">
          <button class="btn" @click="composing = false">Cancel</button>
          <button
            class="btn btn-primary"
            :disabled="creating || !squadName.trim()"
            @click="createSquad"
          >
            {{ creating ? 'Creating…' : 'Create squad' }}
          </button>
        </div>
      </div>
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

.new-squad-btn {
  align-self: flex-start;
}

.squad-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.squad-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.squad-name {
  font-weight: 700;
}

.squad-members {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.squad-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
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
}

.hint {
  margin: 0;
  font-size: 0.88rem;
}

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 18, 30, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 50;
}

.dialog {
  width: min(440px, 100%);
  max-height: 85dvh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
