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
//
// A number to ring them on appears beside the button once the mark is on
// (2026-07-26, user call) — a name on a list nobody can call is a list nobody
// acts on. It lives in its own table with its own RLS (volunteer_phones): the
// mark is org-readable, a member of the public's phone number is not.
import { computed, ref, watch } from 'vue'
import { supabase } from '@/lib/supabase'
import { embeddedPhone } from '@/lib/phone'
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

/** What's in the box. */
const phone = ref('')
/** What's actually stored — so Save is dead until something changed, and a
 *  blank save only issues a DELETE when there's a row to remove. */
const savedPhone = ref('')
const savingPhone = ref(false)
const phoneError = ref('')

// Matches the volunteer_phones CHECK constraint — reject it here with a human
// sentence rather than surfacing a Postgres error at a door.
const PHONE_RE = /^\+?[0-9() .-]{7,20}$/

const person = computed(() => talk.selectedPerson)
const phoneDirty = computed(() => phone.value.trim() !== savedPhone.value)

// The mark is keyed on the person alone, so it reloads whenever the pick
// changes — a primary-key lookup, cheap enough to run on every roster tap.
// immediate: Talk keeps its selection across tab flips, so there's often
// already somebody picked when this mounts.
watch(
  person,
  async (p) => {
    error.value = ''
    phoneError.value = ''
    on.value = false
    phone.value = ''
    savedPhone.value = ''
    if (!p) return
    const id = p.id
    // One trip for both — the number embeds off its FK to this row.
    const { data } = await supabase
      .from('volunteer_interest')
      .select('person_id, volunteer_phones(phone)')
      .eq('person_id', id)
      .maybeSingle()
    // The pick can move on while that's in flight — a stale answer must not
    // land on whoever is selected now.
    if (talk.selectedPerson?.id !== id) return
    on.value = !!data
    // RLS hands the number to whoever wrote it down and to managers. Anyone
    // else gets the mark with an empty box, which is the honest reading of
    // "on the list, but their number isn't yours to see".
    savedPhone.value = data ? (embeddedPhone(data.volunteer_phones) ?? '') : ''
    phone.value = savedPhone.value
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
    else {
      // The number cascades off the mark (volunteer_phones' FK) — it was given
      // so somebody could ring them about volunteering, and that's over.
      phone.value = ''
      savedPhone.value = ''
      phoneError.value = ''
    }
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
    error.value = 'Couldn’t save it. Try again.'
    return
  }
  hapticNotify('success')
  on.value = true
}

/** Save (or clear) the callback number. Submitted explicitly — the box is
 *  typed into mid-conversation and an autosave would fire on every digit. */
async function savePhone() {
  const p = person.value
  const me = auth.profile
  if (!p || !me || savingPhone.value || !on.value) return
  const value = phone.value.trim()
  const digits = value.replace(/\D/g, '').length
  if (value && (!PHONE_RE.test(value) || digits < 7 || digits > 15)) {
    phoneError.value = 'Needs at least 7 digits.'
    return
  }
  hapticTap('light')
  savingPhone.value = true
  phoneError.value = ''
  // Blank = take the number back off, same rule as /profile's own phone field.
  // recorded_by rides along on the upsert, so it means "who last wrote this
  // number down" — that's also the read gate, and the person fixing a typo is
  // the person who should still be able to see it.
  const { error: e } = value
    ? await supabase.from('volunteer_phones').upsert({
        person_id: p.id,
        phone: value,
        recorded_by: me.id,
        updated_at: new Date().toISOString(),
      })
    : await supabase.from('volunteer_phones').delete().eq('person_id', p.id)
  savingPhone.value = false
  if (e) {
    // Only whoever took the number down (or a manager) may change it — RLS
    // refuses everyone else, and the primary key refuses a second number for
    // the same person.
    phoneError.value =
      e.code === '42501' || e.code === '23505'
        ? 'Someone else has their number.'
        : 'Couldn’t save it. Try again.'
    return
  }
  hapticNotify('success')
  savedPhone.value = value
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
            ? 'On the volunteer list. Tap to remove'
            : 'Mark them as willing to knock doors'
      "
      @click="toggle"
    >
      <span class="vol-icon" aria-hidden="true">{{ on ? '✓' : '🙋' }}</span>
      Wants to volunteer
    </button>
    <span v-if="error" class="vol-error">{{ error }}</span>

    <!-- The number to ring them back on, once they're on the list. A form so
         the phone keyboard's Go key submits it, and explicitly submitted so
         nothing is written while a number is half-typed. -->
    <form v-if="on" class="phone-row" data-help="talk-volunteer-phone" @submit.prevent="savePhone">
      <input
        v-model="phone"
        class="phone-input"
        type="tel"
        inputmode="tel"
        maxlength="20"
        placeholder="Phone number"
        aria-label="Volunteer’s phone number"
      />
      <button type="submit" class="btn btn-sm phone-save" :disabled="!phoneDirty || savingPhone">Save</button>
    </form>
    <span v-if="phoneError" class="vol-error">{{ phoneError }}</span>
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

/* Beside the button where there's room, on its own line on a phone — the two
 * travel as one block so the box never orphans from the mark it belongs to. */
.phone-row {
  display: flex;
  gap: 0.4rem;
  flex: 1 1 12rem;
  min-width: 0;
}

/* Both 44px like the button they sit under, not the 34px .btn-sm default —
 * this is typed on a porch, one-handed, in the sun. */
.phone-input {
  flex: 1 1 auto;
  /* Without this a flex item floors at its content width and pushes the row
   * past the screen edge — the app never scrolls sideways. */
  min-width: 0;
  min-height: 44px;
}

.phone-save {
  flex: 0 0 auto;
  min-height: 44px;
  padding-inline: 0.9rem;
  font-weight: 700;
}

.phone-save:disabled {
  opacity: 0.45;
}

.vol-error {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--danger);
}
</style>
