<script setup lang="ts">
// "Would they knock doors too?" — a button you press when they say yes
// (2026-07-26, user call), replacing the sheet that used to open itself on
// every signature (VolunteerSheet.vue, deleted).
//
// WHY THE SHEET WENT: a signature is the busiest moment at a door — pen,
// clipboard, address, the next name — and a modal arriving unasked in the
// middle of it is a thing to dismiss, not a question to ask. Tying the ask to
// the signature also made it the signature's business: undo the knock and the
// ask had to be suppressed, log it offline and the sheet raced the write. As
// its own button it's just a mark on a person, pressed if and when the
// conversation actually goes there, and Signed goes back to doing one thing.
//
// Still one ask with one answer, and still YES-ONLY (see the migration): the
// mark exists or it doesn't. Pressing again removes it — the same
// tap-again-to-undo gesture as the outcome buttons above.
import { computed, ref, watch } from 'vue'
import { supabase } from '@/lib/supabase'
import { hapticNotify, hapticTap } from '@/lib/native'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'

const auth = useAuthStore()
const talk = useTalkStore()

/** On the list. Read from the DB rather than assumed, so a person somebody
 *  else already recorded shows as marked instead of inviting a second ask. */
const on = ref(false)
const saving = ref(false)
const error = ref('')

const person = computed(() => talk.selectedPerson)

// The mark is keyed on the person alone, so it reloads whenever the pick
// changes — a primary-key lookup, cheap enough to run on every roster tap.
// immediate: Talk keeps its selection across tab flips, so there's often
// already somebody picked when this mounts.
watch(
  person,
  async (p) => {
    error.value = ''
    on.value = false
    if (!p) return
    const id = p.id
    const { data } = await supabase
      .from('volunteer_interest')
      .select('person_id')
      .eq('person_id', id)
      .maybeSingle()
    // The pick can move on while that's in flight — a stale answer must not
    // land on whoever is selected now.
    if (talk.selectedPerson?.id !== id) return
    on.value = !!data
  },
  { immediate: true },
)

async function toggle() {
  const p = person.value
  const me = auth.profile
  if (!p || !me || saving.value) return
  hapticTap('medium')
  saving.value = true
  error.value = ''
  if (on.value) {
    await supabase.from('volunteer_interest').delete().eq('person_id', p.id)
    // Only whoever recorded it may delete it (RLS), so a delete can quietly
    // remove nothing — read the row back rather than assume the undo landed.
    const { data } = await supabase
      .from('volunteer_interest')
      .select('person_id')
      .eq('person_id', p.id)
      .maybeSingle()
    saving.value = false
    on.value = !!data
    if (data) error.value = 'Recorded by someone else.'
    return
  }
  // insert, not upsert: there's no UPDATE policy on the table (nothing about a
  // row is editable), and a duplicate key IS the answer — they're on the list
  // already because another canvasser got there first.
  const { error: e } = await supabase.from('volunteer_interest').insert({
    person_id: p.id,
    household_id: talk.selectedAddress?.id ?? null,
    canvasser_id: me.id,
  })
  saving.value = false
  if (e && e.code !== '23505') {
    // No offline queue, for appointments' reason: a knock can be replayed
    // silently, but a person volunteering is worth saying out loud if it
    // didn't save.
    error.value = 'Couldn’t save it — try again.'
    return
  }
  hapticNotify('success')
  on.value = true
}
</script>

<template>
  <div class="vol-wrap">
    <!-- Disabled rather than hidden when nobody's picked, same as Signed
         above: the mark is a person's, and a control that vanishes reads as a
         feature that isn't there. -->
    <button
      type="button"
      class="btn vol-btn"
      :class="{ on }"
      data-help="talk-volunteer"
      :aria-pressed="on"
      :disabled="!person || saving"
      :title="
        !person
          ? 'Pick who from the list above'
          : on
            ? 'On the volunteer list — tap to remove'
            : 'Mark them as willing to knock doors'
      "
      @click="toggle"
    >
      <span class="vol-icon" aria-hidden="true">{{ on ? '✓' : '🙋' }}</span>
      Wants to volunteer
    </button>
    <span v-if="error" class="vol-error">{{ error }}</span>
  </div>
</template>

<style scoped>
.vol-wrap {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* Shorter and rounder than the outcome buttons it sits under, and never in an
 * outcome color — this isn't one of the six, and must not read as a seventh. */
.vol-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 44px;
  padding-inline: 0.85rem;
  border-radius: 999px;
  font-size: 0.95rem;
  font-weight: 700;
}

.vol-btn.on {
  border-color: var(--success);
  background: color-mix(in srgb, var(--success) 16%, var(--surface));
  color: var(--success);
}

.vol-btn:disabled {
  opacity: 0.45;
}

.vol-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.15rem;
  font-size: 1rem;
  line-height: 1;
}

.vol-error {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--danger);
}
</style>
