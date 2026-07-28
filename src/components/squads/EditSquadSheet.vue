<script setup lang="ts">
// Editing a crew (2026-07-28, user ask): rename it, take people off it. One
// sheet for both the manager's all-squads page and the squad page itself —
// the gates live in the RPCs (rename_squad / remove_squad_member: managers,
// squad leaders, or whoever started the crew), so this only ever offers what
// the caller reached it with. Adding people stays the AddMembersSheet's job;
// the parent wires the "Add people" button to it.

import { ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import { useAuthStore } from '@/stores/auth'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import type { ChatProfile } from '@/types'

const props = defineProps<{
  open: boolean
  squad: SquadListItem | null
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; add: [] }>()

const squads = useSquadsStore()
const auth = useAuthStore()

const name = ref('')
const savingName = ref(false)
const removingId = ref<string | null>(null)
const error = ref('')
const nameSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = props.squad?.name ?? ''
    error.value = ''
    nameSaved.value = false
  },
)

function nameOf(p: ChatProfile): string {
  return p.display_name || p.username
}

async function saveName() {
  const squad = props.squad
  const trimmed = name.value.trim()
  if (!squad || savingName.value || !trimmed || trimmed === squad.name) return
  savingName.value = true
  error.value = ''
  const reason = await squads.renameSquad(squad.id, trimmed)
  savingName.value = false
  if (reason) {
    error.value = reason
    return
  }
  nameSaved.value = true
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => (nameSaved.value = false), 1600)
}

async function removeMember(memberId: string) {
  const squad = props.squad
  if (!squad || removingId.value) return
  removingId.value = memberId
  error.value = ''
  const reason = await squads.removeMember(squad.id, memberId)
  removingId.value = null
  if (reason) error.value = reason
}
</script>

<template>
  <BottomSheet
    :open="open"
    :title="squad ? `Edit ${squad.name}` : 'Edit squad'"
    aria-label="Edit this squad"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="squad" class="edit-body">
      <p v-if="error" class="error">{{ error }}</p>

      <div class="section">
        <div class="section-head">
          <span class="section-label">Name</span>
          <Transition name="fade">
            <span v-if="nameSaved" class="saved">Saved ✓</span>
          </Transition>
        </div>
        <div class="name-row">
          <input v-model="name" aria-label="Squad name" @keydown.enter="saveName" />
          <button
            class="btn btn-sm btn-primary"
            :disabled="savingName || !name.trim() || name.trim() === squad.name"
            @click="saveName"
          >
            {{ savingName ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-label">
            {{ squad.members.length }} member{{ squad.members.length === 1 ? '' : 's' }}
          </span>
        </div>
        <ul class="member-list">
          <li v-for="m in squad.members" :key="m.id" class="member-row" :style="{ '--member-color': memberColor(m) }">
            <span class="member-avatar" :style="!avatarUrl(m.avatar) ? { background: memberColor(m) } : {}">
              <img v-if="avatarUrl(m.avatar)" :src="avatarUrl(m.avatar)" alt="" />
              <template v-else>{{ nameOf(m).slice(0, 1).toUpperCase() }}</template>
            </span>
            <span class="member-name">
              {{ nameOf(m) }}
              <span v-if="m.id === auth.profile?.id" class="muted you-tag">(you)</span>
            </span>
            <button
              class="btn btn-sm remove-btn"
              :disabled="removingId === m.id"
              :aria-label="`Remove ${nameOf(m)} from the squad`"
              @click="removeMember(m.id)"
            >
              {{ removingId === m.id ? '…' : 'Remove' }}
            </button>
          </li>
        </ul>
        <button class="btn btn-block add-people-btn" @click="emit('add')">+ Add people</button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.edit-body {
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

.name-row {
  display: flex;
  gap: 0.5rem;
}

.name-row input {
  flex: 1;
  min-width: 0;
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 52px;
  padding: 0.45rem 0.7rem;
  background: var(--surface);
}

.member-row + .member-row {
  border-top: 1px solid var(--border);
}

.member-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid var(--member-color);
  overflow: hidden;
  flex-shrink: 0;
  font-weight: 800;
  color: #fff;
  font-size: 0.85rem;
}

.member-avatar img {
  width: 80%;
  height: 80%;
  object-fit: contain;
}

.member-name {
  font-weight: 600;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.you-tag {
  font-weight: 500;
  font-size: 0.82rem;
}

.remove-btn {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--danger, #c0392b) 45%, var(--border));
  color: var(--danger, #c0392b);
  background: transparent;
  font-weight: 700;
}

.add-people-btn {
  border: 1px dashed var(--border);
  background: var(--surface);
  font-weight: 700;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
