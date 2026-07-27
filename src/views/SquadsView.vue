<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import AddMembersSheet from '@/components/squads/AddMembersSheet.vue'
import { fadeUp } from '@/lib/motion'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { defaultSquadName } from '@/lib/squadName'
import type { ChatProfile } from '@/types'

const router = useRouter()
const auth = useAuthStore()
const squads = useSquadsStore()
const chat = useChatStore()

/** A campaign manager can be out knocking too — their own squads float to
 * the top, wearing an "Open" button into the same squad page (map, member
 * cards, assign mode) everyone else lives on. */
const sortedSquads = computed(() =>
  [...squads.squads].sort((a, b) => Number(b.isMember) - Number(a.isMember)),
)

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
  // Born named after whoever is forming it, editable on the spot.
  squadName.value = defaultSquadName(auth.profile)
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
    // You just made today's crew — land on its squad page, not just a chat.
    void router.push('/squad')
  }
}

// Only campaign managers and admins reach this page (the router sends
// everyone else to their own /squad), so "assign anyone, moving them off
// another crew if that's where they are" is the right mode for every row.
const addTo = ref<SquadListItem | null>(null)
const addMembersOpen = ref(false)

function openAddMembers(squad: SquadListItem) {
  addTo.value = squad
  addMembersOpen.value = true
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
      <button class="btn btn-primary new-squad-btn" data-help="squads-new" @click="openComposer">+ New squad</button>

      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <p v-if="squads.loading && !squads.squads.length" class="muted">Loading today's squads…</p>
      <p v-else-if="!squads.squads.length" class="muted">
        No squads yet today.
      </p>

      <div
        v-for="(s, i) in sortedSquads"
        :key="s.id"
        v-motion="fadeUp(Math.min(i, 8) * 45)"
        class="card squad-card"
        data-help="squads-card"
      >
        <div class="squad-info">
          <span class="squad-name">👥 {{ s.name }}</span>
          <span class="muted squad-members">
            {{ s.members.length }} member{{ s.members.length === 1 ? '' : 's' }} ·
            {{ memberNames(s) }}
          </span>
        </div>
        <!-- Your own squad opens the full squad page (map, member cards,
             assign mode — leaving lives there too); Chat stays as the
             one-tap shortcut. Everyone else's squads offer Join. -->
        <div class="squad-actions">
          <button
            v-if="s.isMember"
            class="btn btn-sm btn-primary"
            @click="router.push({ path: '/squad', query: { squad: s.id } })"
          >
            Open
          </button>
          <button v-if="s.isMember" class="btn btn-sm btn-ghost" @click="openSquadChat(s)">
            Chat
          </button>
          <!-- This page is the manager's view of every crew out today, so it's
               where assigning people to them belongs (2026-07-25, user ask).
               The same sheet the squad page uses. -->
          <button class="btn btn-sm btn-ghost" data-help="squads-add" @click="openAddMembers(s)">
            Add people
          </button>
          <button v-if="!s.isMember" class="btn btn-sm btn-primary" @click="squads.joinSquad(s.id)">
            Join
          </button>
        </div>
      </div>
    </div>

    <AddMembersSheet v-model:open="addMembersOpen" :squad="addTo" can-move />

    <!-- New squad sheet -->
    <BottomSheet v-model:open="composing" title="New squad" aria-label="New squad">
      <div class="field">
        <label for="squad-name">Squad name</label>
        <input id="squad-name" v-model="squadName" :placeholder="`e.g. ${defaultSquadName(auth.profile)}`" />
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

/* Creating today's crew is a primary field action — full-width, can't-miss. */
.create-btn {
  min-height: 56px;
  font-size: 1.05rem;
}
</style>
