<script setup lang="ts">
// Fix a knock you already logged (2026-07-26).
//
// Tap-again undo covers the knock still under your thumb. An hour later a
// wrong outcome, a wrong person or a wrong house was permanent — this is the
// repair. YOUR OWN rows only, which is also what RLS allows (knock_logs has
// carried own-row update/delete policies since it was created; no migration
// was needed for this).
//
// A real UPDATE, deliberately not delete-and-relog: re-inserting would restamp
// the row's squad and turf from today's dispatch (stamp_knock_context fires
// BEFORE INSERT) and quietly rewrite where last Tuesday's knock happened.
// Changing the person never changes the door, so the existing stamps stay true.
import { ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { hapticNotify, hapticTap } from '@/lib/native'
import { OUTCOMES, OUTCOME_REQUIRES_PERSON } from '@/lib/outcomes'
import type { KnockOutcome, Person } from '@/types'

export interface EditableKnock {
  id: string
  outcome: KnockOutcome
  occurred_at: string
  household_id: string | null
  person_id: string | null
  doorLabel: string
}

const props = defineProps<{ knock: EditableKnock | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  saved: [{ id: string; outcome: KnockOutcome; person_id: string | null; personName: string | null }]
  deleted: [string]
}>()

const outcome = ref<KnockOutcome>('not_home')
const personId = ref<string | null>(null)
const roster = ref<Person[]>([])
const busy = ref(false)
const error = ref('')
const confirmingDelete = ref(false)

watch(open, async (v) => {
  if (!v || !props.knock) return
  const k = props.knock
  outcome.value = k.outcome
  personId.value = k.person_id
  error.value = ''
  confirmingDelete.value = false
  roster.value = []
  if (!k.household_id) return
  const { data } = await supabase
    .from('persons')
    .select('*')
    .eq('household_id', k.household_id)
    .order('name')
  roster.value = (data ?? []) as Person[]
})

function pickOutcome(value: KnockOutcome) {
  hapticTap('light')
  outcome.value = value
}

function pickPerson(id: string | null) {
  hapticTap('light')
  personId.value = personId.value === id ? null : id
}

async function save() {
  const k = props.knock
  if (!k || busy.value) return
  // Signed is the one outcome that can't stand without a name — same rule the
  // door enforces (requiresPerson in lib/outcomes.ts).
  if (OUTCOME_REQUIRES_PERSON[outcome.value] && !personId.value) {
    error.value = 'Pick who signed.'
    return
  }
  busy.value = true
  error.value = ''
  const { error: err } = await supabase
    .from('knock_logs')
    .update({ outcome: outcome.value, person_id: personId.value })
    .eq('id', k.id)
  busy.value = false
  if (err) {
    error.value = 'Couldn’t save the change — try again.'
    return
  }
  hapticNotify('success')
  emit('saved', {
    id: k.id,
    outcome: outcome.value,
    person_id: personId.value,
    personName: roster.value.find((p) => p.id === personId.value)?.name ?? null,
  })
  open.value = false
}

async function remove() {
  const k = props.knock
  if (!k || busy.value) return
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  busy.value = true
  error.value = ''
  const { error: err } = await supabase.from('knock_logs').delete().eq('id', k.id)
  busy.value = false
  if (err) {
    error.value = 'Couldn’t delete it — try again.'
    return
  }
  hapticNotify('success')
  emit('deleted', k.id)
  open.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Fix this knock">
    <div v-if="knock" class="edit">
      <p class="where">
        {{ knock.doorLabel }}
        <span class="muted when">
          · {{ new Date(knock.occurred_at).toLocaleString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }) }}
        </span>
      </p>

      <div class="grid" role="group" aria-label="Outcome">
        <button
          v-for="o in OUTCOMES"
          :key="o.value"
          type="button"
          class="btn out-btn"
          :class="{ active: outcome === o.value }"
          :style="{ '--outcome-color': o.hex }"
          @click="pickOutcome(o.value)"
        >
          {{ o.label }}
        </button>
      </div>

      <div v-if="roster.length" class="people">
        <span class="people-label muted">Who</span>
        <div class="people-row">
          <button
            type="button"
            class="pill"
            :class="{ on: personId === null }"
            @click="pickPerson(null)"
          >
            Nobody — the household
          </button>
          <button
            v-for="p in roster"
            :key="p.id"
            type="button"
            class="pill"
            :class="{ on: personId === p.id }"
            @click="pickPerson(p.id)"
          >
            {{ p.name }}
          </button>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="actions">
        <button class="btn danger" type="button" :disabled="busy" @click="remove">
          {{ confirmingDelete ? 'Tap again to delete' : 'Delete' }}
        </button>
        <button class="btn btn-primary save" type="button" :disabled="busy" @click="save">
          {{ busy ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.edit {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.where {
  margin: 0;
  font-weight: 700;
  font-size: 0.95rem;
}

.when {
  font-weight: 500;
  font-size: 0.85rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.out-btn {
  min-height: 52px;
  padding-inline: 0.4rem;
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1.15;
  background: var(--surface);
  border: 2px solid var(--outcome-color);
  color: var(--outcome-color);
  white-space: normal;
}

.out-btn.active {
  background: var(--outcome-color);
  color: var(--accent-contrast);
}

.people {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.people-label {
  font-size: 0.8rem;
  font-weight: 700;
}

.people-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.pill {
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.pill.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  color: var(--accent);
}

.actions {
  display: flex;
  gap: 0.6rem;
}

.actions .btn {
  flex: 1;
  min-height: 52px;
}

.save {
  flex: 1.6;
  font-weight: 700;
}

/* Two taps to delete — the second is the confirmation, so there's no dialog
   to dismiss one-handed on a porch. */
.danger {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--surface);
}
</style>
