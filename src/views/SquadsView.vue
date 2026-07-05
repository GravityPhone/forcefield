<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { fadeUp } from '@/lib/motion'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import { useChatStore } from '@/stores/chat'
import type { ChatProfile } from '@/types'

const squads = useSquadsStore()
const chat = useChatStore()

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
  chat.openDrawer(squad.chat_id) // slides over this page — no navigation
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

      <div
        v-for="(s, i) in squads.squads"
        :key="s.id"
        v-motion="fadeUp(Math.min(i, 8) * 45)"
        class="card squad-card"
      >
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

    <!-- New squad sheet -->
    <BottomSheet v-model:open="composing" title="New squad" aria-label="New squad">
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
      <button
        class="btn btn-primary btn-block create-btn"
        :disabled="creating || !squadName.trim()"
        @click="createSquad"
      >
        {{ creating ? 'Creating…' : 'Create squad' }}
      </button>
    </BottomSheet>
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
  min-height: 56px;
  font-size: 1.05rem;
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

/* Creating today's crew is a primary field action — full-width, can't-miss. */
.create-btn {
  min-height: 56px;
  font-size: 1.05rem;
}
</style>
