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
import { useSquadsStore } from '@/stores/squads'
import { clockLabel, shiftDayLabel, type SiteShift } from '@/lib/registration'
import type { ChatProfile } from '@/types'

const props = defineProps<{
  /** The shift being changed, or null to plan a new one. */
  shift: SiteShift | null
  /** Planning a new shift at a known place: its name, prefilled. */
  presetSite?: string
  /** The day a NEW shift is for (YYYY-MM-DD): the one picked on the plan.
   * The form asks no date question; a shift being changed keeps its own. */
  day?: string
}>()
const emit = defineEmits<{ saved: []; deleted: [] }>()
const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()

// A whole squad onto the crew in one tap (2026-11-19, user call: "any squad
// to any site"). Squads last a day, so these are today's; adding one copies
// its people onto the shift, and the crew stays a plain list of people, which
// is what lets a shift next week outlive the squad it was staffed from.
const squads = useSquadsStore()
function addSquad(id: string) {
  const squad = squads.squads.find((s) => s.id === id)
  if (!squad) return
  const have = new Set(crew.value.map((p) => p.id))
  crew.value = [...crew.value, ...squad.members.filter((m) => !have.has(m.id)).map((m) => ({ ...m }))]
}
function squadAllIn(id: string): boolean {
  const squad = squads.squads.find((s) => s.id === id)
  const have = new Set(crew.value.map((p) => p.id))
  return !!squad && squad.members.every((m) => have.has(m.id))
}

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

// TIMES AND THE GOAL ARE BUTTONS (2026-11-20, user call: "make it a little
// bit easier to just do with a couple button presses"). A native time picker
// is a wheel per field; a shift is almost always "starts on the hour, runs a
// few hours". So: one tap for the start, one for how long, one for the goal.
// Tapping the lit one clears it. A shift that arrived from a sheet with an
// odd time (10:30) keeps it; no chip lights and the line underneath says it.
const START_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
const LENGTHS = [2, 3, 4, 5, 6]
const GOALS = [5, 10, 15, 20, 25, 30]

const hhmm = (h: number, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
const minutesOf = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5)

/** Whole hours between start and end, or null when it is not a round number. */
const lengthHours = computed(() => {
  if (!start.value || !end.value) return null
  const d = (minutesOf(end.value) - minutesOf(start.value)) / 60
  return Number.isInteger(d) && d > 0 ? d : null
})

function pickStart(h: number) {
  const next = hhmm(h)
  if (start.value === next) {
    start.value = ''
    end.value = ''
    return
  }
  // Moving the start keeps the length; a first pick assumes four hours.
  const len = lengthHours.value ?? 4
  start.value = next
  end.value = hhmm(Math.min(23, h + len))
}

function pickLength(n: number) {
  if (!start.value) return
  if (lengthHours.value === n) {
    end.value = ''
    return
  }
  const total = Math.min(23 * 60 + 59, minutesOf(start.value) + n * 60)
  end.value = hhmm(Math.floor(total / 60), total % 60)
}

function pickGoal(n: number) {
  goal.value = goal.value === String(n) ? '' : String(n)
}

const timeLine = computed(() => {
  if (start.value && end.value) return `${clockLabel(start.value)} to ${clockLabel(end.value)}`
  if (start.value) return `From ${clockLabel(start.value)}`
  return 'No time set'
})
const hourLabel = (h: number) => clockLabel(hhmm(h))

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
  void squads.loadToday()
  const s = props.shift
  name.value = s?.site.name ?? props.presetSite ?? ''
  address.value = s?.site.address ?? ''
  date.value = s?.shift_date ?? props.day ?? localToday()
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
  <BottomSheet v-model:open="open" :title="`${shift ? 'Edit shift' : 'Add shift'}, ${shiftDayLabel(date, localToday())}`">
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
        <div v-if="!shift && knownSites.length" class="pick-row site-picks">
          <button
            v-for="s in knownSites"
            :key="s.id"
            type="button"
            class="pick"
            :class="{ on: matched?.id === s.id }"
            @click="name = s.name"
          >
            {{ s.name }}
          </button>
        </div>
      </div>
      <div class="field">
        <label>Starts</label>
        <div class="pick-row">
          <button
            v-for="h in START_HOURS"
            :key="h"
            type="button"
            class="pick"
            :class="{ on: start === hhmm(h) }"
            @click="pickStart(h)"
          >
            {{ hourLabel(h) }}
          </button>
        </div>
      </div>
      <div class="field">
        <label>Hours</label>
        <div class="pick-row">
          <button
            v-for="n in LENGTHS"
            :key="n"
            type="button"
            class="pick"
            :class="{ on: lengthHours === n }"
            :disabled="!start"
            @click="pickLength(n)"
          >
            {{ n }}
          </button>
        </div>
        <span class="time-line muted">{{ timeLine }}</span>
      </div>
      <div class="field">
        <label>Goal</label>
        <div class="pick-row">
          <button
            v-for="n in GOALS"
            :key="n"
            type="button"
            class="pick"
            :class="{ on: goal === String(n) }"
            @click="pickGoal(n)"
          >
            {{ n }}
          </button>
        </div>
      </div>
      <div class="field">
        <label>Crew</label>
        <UserPicker v-model="crew" />
        <div v-if="squads.squads.length" class="squad-chips" data-help="sites-add-squad">
          <span class="muted squad-chips-label">Add a squad:</span>
          <button
            v-for="s in squads.squads"
            :key="s.id"
            type="button"
            class="squad-chip"
            :disabled="squadAllIn(s.id)"
            @click="addSquad(s.id)"
          >
            {{ s.name }} ({{ s.members.length }})
          </button>
        </div>
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
.squad-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
}

.squad-chips-label {
  font-size: 0.82rem;
}

.squad-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 0.3rem 0.7rem;
  font-size: 0.85rem;
  font-weight: 600;
  min-height: 32px;
}

.squad-chip:disabled {
  opacity: 0.5;
}

.shift-form {
  display: flex;
  flex-direction: column;
}

.shift-form .field {
  margin-bottom: 0.75rem;
  min-width: 0;
}

.pick-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.pick {
  min-width: 46px;
  min-height: 40px;
  padding: 0.3rem 0.6rem;
  border: 1.5px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.88rem;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
}

.site-picks {
  margin-top: 0.45rem;
}

.site-picks .pick {
  white-space: normal;
  text-align: left;
  border-radius: var(--radius);
}

.pick.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.pick:disabled {
  opacity: 0.45;
}

.time-line {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.85rem;
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
