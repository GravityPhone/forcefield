<script setup lang="ts">
// Putting people on a crew (2026-07-25, user asks): the squad page's roster
// control for a squad leader, and the campaign manager's way to assign anyone
// to any of today's squads. One sheet for both — the difference is entirely in
// who the picker will offer.
//
// A leader adds people who aren't out with another crew today, so those people
// simply aren't in the list. A manager dispatches, so they are — and picking
// one says out loud that it's a move, because the person comes off the other
// crew and out of its chat. Both rules are the add_squad_member RPC's; this
// just keeps the UI from offering what the DB will refuse.

import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import type { ChatProfile } from '@/types'

const props = defineProps<{
  open: boolean
  squad: SquadListItem | null
  /** Manager: may take someone off another crew to put them on this one. */
  canMove: boolean
}>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const squads = useSquadsStore()
const picked = ref<ChatProfile[]>([])
const saving = ref(false)
const error = ref('')

function nameOf(p: ChatProfile): string {
  return p.display_name || p.username
}

/** Who's already out today, and with whom. Every squad's roster is already
 * loaded for this page, so this costs nothing. */
const crewByUser = computed(() => {
  const out = new Map<string, string>()
  for (const s of squads.squads) {
    if (s.id === props.squad?.id) continue
    for (const m of s.members) out.set(m.id, s.name)
  }
  return out
})

const exclude = computed(() => {
  const onThisCrew = (props.squad?.members ?? []).map((m) => m.id)
  return props.canMove ? onThisCrew : [...onThisCrew, ...crewByUser.value.keys()]
})

/** Picked people who are somebody else's today — a manager can take them. */
const moving = computed(() => picked.value.filter((p) => crewByUser.value.has(p.id)))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    picked.value = []
    error.value = ''
  },
)

async function save() {
  const squad = props.squad
  if (!squad || saving.value || !picked.value.length) return
  saving.value = true
  error.value = ''
  const failed: string[] = []
  for (const person of picked.value) {
    const reason = await squads.addMember(squad.id, person.id)
    if (reason) failed.push(`${nameOf(person)}: ${reason}`)
  }
  await squads.loadToday()
  saving.value = false
  if (failed.length) {
    error.value = failed.join(' · ')
    picked.value = picked.value.filter((p) => failed.some((f) => f.startsWith(`${nameOf(p)}:`)))
    return
  }
  emit('update:open', false)
}
</script>

<template>
  <BottomSheet
    :open="open"
    :title="squad ? `Add to ${squad.name}` : 'Add people'"
    aria-label="Add people to this squad"
    @update:open="emit('update:open', $event)"
  >
    <UserPicker v-model="picked" :exclude="exclude" />

    <p v-for="p in moving" :key="p.id" class="muted move-note">
      {{ nameOf(p) }} is out with {{ crewByUser.get(p.id) }}. Adding them here moves them.
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <button
      class="btn btn-primary btn-block add-btn"
      :disabled="saving || !picked.length || !squad"
      @click="save"
    >
      {{ saving ? 'Adding…' : picked.length > 1 ? `Add ${picked.length} people` : 'Add to squad' }}
    </button>
  </BottomSheet>
</template>

<style scoped>
.move-note {
  margin: 0.4rem 0 0;
  font-size: 0.85rem;
}

.error {
  color: var(--danger);
  margin: 0.5rem 0 0;
  font-size: 0.88rem;
}

.add-btn {
  margin-top: 0.75rem;
  min-height: 56px;
  font-size: 1.05rem;
}
</style>
