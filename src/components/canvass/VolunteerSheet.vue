<script setup lang="ts">
// Signed → would they knock doors? (2026-07-26)
//
// The ONE follow-up after a signature, in the same shape as AppointmentSheet:
// the knock is already logged by the time this appears, so answering is
// optional and closing it costs nothing.
//
// One question, one answer. No yard signs, no email or phone capture, no
// battery of chips — all considered and declined, because a supporter who'd
// canvass is worth more than any of them and every extra tap on a porch costs
// conversations later in the night.
//
// Only a YES is stored (see the migration). "Not now" writes nothing, so the
// table stays a list of people who would help rather than a survey.
import { ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { hapticNotify, hapticTap } from '@/lib/native'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'

const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()
const talk = useTalkStore()

const saving = ref(false)
const saveError = ref('')
/** Already on the list — so a second signature at the same door doesn't read
 *  as though the first answer was lost, and a mis-tap has an undo. */
const already = ref(false)

// The person and door are read when the sheet OPENS and held, because Next
// clears the talk store's selection out from under a sheet that's still up.
const person = ref<{ id: string; name: string } | null>(null)
const doorId = ref<string | null>(null)
const street = ref('')

watch(open, async (v) => {
  if (!v) return
  saveError.value = ''
  already.value = false
  const p = talk.selectedPerson
  person.value = p ? { id: p.id, name: p.name } : null
  doorId.value = talk.selectedAddress?.id ?? null
  street.value = talk.selectedAddress?.street ?? ''
  if (!p) return
  const { data } = await supabase
    .from('volunteer_interest')
    .select('person_id')
    .eq('person_id', p.id)
    .maybeSingle()
  already.value = !!data
})

async function yes() {
  const p = person.value
  const me = auth.profile
  if (!p || !me || saving.value) return
  hapticTap('medium')
  saving.value = true
  saveError.value = ''
  // upsert, not insert: two canvassers can reach the same person across a
  // campaign, and the second one shouldn't see a primary-key error.
  const { error } = await supabase.from('volunteer_interest').upsert(
    {
      person_id: p.id,
      household_id: doorId.value,
      canvasser_id: me.id,
    },
    { onConflict: 'person_id' },
  )
  saving.value = false
  if (error) {
    // No offline queue, for appointments' reason: a knock can be replayed
    // silently, but a person volunteering is worth saying out loud if it
    // didn't save.
    saveError.value = 'Couldn’t save — try again.'
    return
  }
  hapticNotify('success')
  open.value = false
}

async function remove() {
  const p = person.value
  if (!p || saving.value) return
  saving.value = true
  saveError.value = ''
  const { error } = await supabase.from('volunteer_interest').delete().eq('person_id', p.id)
  saving.value = false
  if (error) {
    saveError.value = 'Couldn’t remove it — try again.'
    return
  }
  already.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Would they knock doors?">
    <div class="vol">
      <p v-if="person" class="who">
        {{ person.name }}<template v-if="street"> · {{ street }}</template>
      </p>

      <div v-if="already" class="on-list">
        <span class="on-list-dot" aria-hidden="true"></span>
        <span class="on-list-text">On the volunteer list</span>
        <button class="btn btn-sm" type="button" :disabled="saving" @click="remove">Remove</button>
      </div>

      <p v-if="saveError" class="error">{{ saveError }}</p>

      <div class="actions">
        <button class="btn" type="button" @click="open = false">Not now</button>
        <button
          class="btn btn-primary yes"
          type="button"
          :disabled="!person || saving || already"
          @click="yes"
        >
          {{ saving ? 'Saving…' : 'Yes, they’d help' }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.vol {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.who {
  margin: 0;
  font-weight: 700;
  font-size: 0.95rem;
}

.on-list {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}

.on-list-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

.on-list-text {
  flex: 1;
  min-width: 0;
  font-size: 0.9rem;
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 0.6rem;
}

.actions .btn {
  flex: 1;
  min-height: 52px;
}

.yes {
  flex: 1.6;
  font-weight: 700;
}
</style>
