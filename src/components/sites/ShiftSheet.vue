<script setup lang="ts">
// Plan one site shift, or change one (2026-11-19): where, which day, what
// hours, who is standing there. The interactive half of the site planner;
// ImportSheet.vue is the half that reads somebody's existing spreadsheet.
//
// A site is found by NAME within the campaign: typing a name that already
// exists reuses that site (and its address), so the same grocery store on
// three Saturdays is one site with three shifts, not three sites.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { supabase } from '@/lib/supabase'
import { localToday } from '@/lib/day'
import { useAuthStore } from '@/stores/auth'
import type { SiteShift } from '@/lib/registration'
import type { ChatProfile } from '@/types'

const props = defineProps<{
  /** The shift being changed, or null to plan a new one. */
  shift: SiteShift | null
  /** Planning a new shift at a known place: its name, prefilled. */
  presetSite?: string
}>()
const emit = defineEmits<{ saved: []; deleted: [] }>()
const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()

const name = ref('')
const address = ref('')
const date = ref(localToday())
const start = ref('')
const end = ref('')
const goal = ref('')
const notes = ref('')
const crew = ref<ChatProfile[]>([])
const saving = ref(false)
const error = ref('')
const deleteArmed = ref(false)

interface KnownSite {
  id: string
  name: string
  address: string | null
}
const knownSites = ref<KnownSite[]>([])

async function loadSites() {
  const cid = auth.profile?.campaign_id
  if (!cid) return
  const { data } = await supabase.from('sites').select('id, name, address').eq('campaign_id', cid).order('name')
  knownSites.value = (data ?? []) as KnownSite[]
}

const matched = computed(
  () => knownSites.value.find((s) => s.name.toLowerCase() === name.value.trim().toLowerCase()) ?? null,
)

// Picking a known site fills in its address, but never over something typed.
watch(matched, (s) => {
  if (s?.address && !address.value.trim()) address.value = s.address
})

watch(open, (isOpen) => {
  if (!isOpen) return
  error.value = ''
  deleteArmed.value = false
  void loadSites()
  const s = props.shift
  name.value = s?.site.name ?? props.presetSite ?? ''
  address.value = s?.site.address ?? ''
  date.value = s?.shift_date ?? localToday()
  start.value = s?.start_time?.slice(0, 5) ?? ''
  end.value = s?.end_time?.slice(0, 5) ?? ''
  goal.value = s?.goal == null ? '' : String(s.goal)
  notes.value = s?.notes ?? ''
  crew.value = (s?.members ?? []).map((m) => ({ ...m }))
})

async function save() {
  const cid = auth.profile?.campaign_id
  const siteName = name.value.trim()
  if (!cid || !auth.profile) return
  if (!siteName) {
    error.value = 'Give the site a name.'
    return
  }
  if (!date.value) {
    error.value = 'Pick a date.'
    return
  }
  if (start.value && end.value && end.value <= start.value) {
    error.value = 'The end time is before the start.'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const addr = address.value.trim() || null
    let siteId = matched.value?.id ?? null
    if (siteId) {
      if (addr !== (matched.value?.address ?? null)) {
        const { error: e } = await supabase.from('sites').update({ address: addr }).eq('id', siteId)
        if (e) throw e
      }
    } else {
      const { data, error: e } = await supabase
        .from('sites')
        .insert({ campaign_id: cid, name: siteName, address: addr, created_by: auth.profile.id })
        .select('id')
        .single()
      if (e) throw e
      siteId = data.id as string
    }

    const goalNum = parseInt(goal.value, 10)
    const fields = {
      site_id: siteId,
      shift_date: date.value,
      start_time: start.value || null,
      end_time: end.value || null,
      goal: Number.isFinite(goalNum) && goalNum >= 0 ? goalNum : null,
      notes: notes.value.trim() || null,
    }
    let shiftId = props.shift?.id ?? null
    if (shiftId) {
      const { error: e } = await supabase.from('site_shifts').update(fields).eq('id', shiftId)
      if (e) throw e
    } else {
      const { data, error: e } = await supabase
        .from('site_shifts')
        .insert({ ...fields, created_by: auth.profile.id })
        .select('id')
        .single()
      if (e) throw e
      shiftId = data.id as string
    }

    // Crew: replace the roster with what is picked now.
    const want = new Set(crew.value.map((p) => p.id))
    const have = new Set((props.shift?.members ?? []).map((m) => m.id))
    const drop = [...have].filter((id) => !want.has(id))
    const add = [...want].filter((id) => !have.has(id))
    if (drop.length) {
      const { error: e } = await supabase
        .from('site_shift_members')
        .delete()
        .eq('shift_id', shiftId)
        .in('user_id', drop)
      if (e) throw e
    }
    if (add.length) {
      const { error: e } = await supabase
        .from('site_shift_members')
        .insert(add.map((user_id) => ({ shift_id: shiftId, user_id })))
      if (e) throw e
    }
    open.value = false
    emit('saved')
  } catch {
    error.value = 'Could not save. Try again.'
  } finally {
    saving.value = false
  }
}

// Two taps, no dialog (KnockEditSheet's precedent). Registrations already
// counted at this shift are kept: the log rows lose their shift, not their
// existence.
async function remove() {
  if (!props.shift) return
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  saving.value = true
  const { error: e } = await supabase.from('site_shifts').delete().eq('id', props.shift.id)
  saving.value = false
  if (e) {
    error.value = 'Could not delete. Try again.'
    return
  }
  open.value = false
  emit('deleted')
}
</script>

<template>
  <BottomSheet v-model:open="open" :title="shift ? 'Edit shift' : 'Add shift'">
    <div class="shift-form">
      <div class="field">
        <label for="shift-site">Site</label>
        <input
          id="shift-site"
          v-model="name"
          type="text"
          list="known-sites"
          placeholder="Kroger on Coleman's Crossing"
          autocomplete="off"
        />
        <datalist id="known-sites">
          <option v-for="s in knownSites" :key="s.id" :value="s.name" />
        </datalist>
      </div>
      <div class="field">
        <label for="shift-address">Address</label>
        <input id="shift-address" v-model="address" type="text" autocomplete="off" />
      </div>
      <div class="field">
        <label for="shift-date">Date</label>
        <input id="shift-date" v-model="date" class="plain-input" type="date" />
      </div>
      <div class="pair">
        <div class="field">
          <label for="shift-start">Start</label>
          <input id="shift-start" v-model="start" class="plain-input" type="time" />
        </div>
        <div class="field">
          <label for="shift-end">End</label>
          <input id="shift-end" v-model="end" class="plain-input" type="time" />
        </div>
        <div class="field">
          <label for="shift-goal">Goal</label>
          <input id="shift-goal" v-model="goal" type="number" min="0" inputmode="numeric" />
        </div>
      </div>
      <div class="field">
        <label>Crew</label>
        <UserPicker v-model="crew" />
      </div>
      <div class="field">
        <label for="shift-notes">Notes</label>
        <textarea id="shift-notes" v-model="notes" rows="2" />
      </div>

      <p v-if="error" class="form-error">{{ error }}</p>

      <div class="actions">
        <button class="btn btn-primary save-btn" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button
          v-if="shift"
          class="btn delete-btn"
          :class="{ armed: deleteArmed }"
          :disabled="saving"
          @click="remove"
        >
          {{ deleteArmed ? 'Delete?' : 'Delete' }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.shift-form {
  display: flex;
  flex-direction: column;
}

.shift-form .field {
  margin-bottom: 0.75rem;
  min-width: 0;
}

.pair {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.6rem;
}

/* date and time inputs sit outside style.css's typed-field rule, so they get
 * the 16px floor here: under it iOS Safari zooms the page on focus. */
.plain-input {
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: max(16px, calc(1rem * var(--ui-scale)));
}

.form-error {
  margin: 0 0 0.6rem;
  color: var(--danger);
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 0.6rem;
}

.save-btn {
  flex: 1;
}

.delete-btn {
  border: 1.5px solid var(--danger);
  color: var(--danger);
  background: transparent;
}

.delete-btn.armed {
  background: var(--danger);
  color: #fff;
}
</style>
