<script setup lang="ts">
// "Return" → when? (2026-07-26; the button read "Come back another time" for
// the first afternoon this shipped, before the label was shortened)
//
// Opens straight off the outcome button, and answering is optional: the knock
// is already logged by the time this appears, so closing it costs nothing.
// Windows come from the campaign's own settings (length + hours), so a crew
// that works 10–8 in 90-minute blocks sees exactly that.
//
// Everything is local time — "between four and six" means four o'clock on the
// porch. Only the ISO strings crossing to Postgres are absolute.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { hapticNotify, hapticTap } from '@/lib/native'
import {
  appointmentSettings,
  buildWindows,
  localAt,
  localDateKey,
  windowLabel,
  type ApptWindow,
} from '@/lib/appointments'
import { useAuthStore } from '@/stores/auth'
import { useTalkStore } from '@/stores/talk'

const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()
const talk = useTalkStore()

const dayKey = ref(localDateKey(new Date()))
/** Start-of-window as minutes past local midnight; null = nothing picked. */
const picked = ref<number | null>(null)
const saving = ref(false)
const saveError = ref('')

const todayKey = computed(() => localDateKey(new Date()))
const tomorrowKey = computed(() => {
  const n = new Date()
  return localDateKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))
})

const windows = computed<ApptWindow[]>(() => buildWindows(dayKey.value, appointmentSettings.value))

/** The window a canvasser typed by hand ("they said 4:30") — same length as
 * the chips, just off-grid. Kept as its own value so picking a chip and
 * typing a time can't both be true. */
const customTime = ref('')

const chosen = computed<ApptWindow | null>(() => {
  if (picked.value == null) return null
  const start = localAt(dayKey.value, picked.value)
  const end = localAt(dayKey.value, picked.value + appointmentSettings.value.window_minutes)
  return { start, end, label: windowLabel(start, end) }
})

/** A window that already closed can only ever be a missed appointment, so
 * Save won't take it. Only reachable through the typed time — the chips drop
 * ended windows on their own. A window you're standing INSIDE is fine ("come
 * back within the hour"), so this is end-of-window, not start. */
const chosenIsPast = computed(() => !!chosen.value && chosen.value.end.getTime() <= Date.now())

/** This door's soonest appointment that I booked — saving MOVES it rather
 * than stacking a second promise on the same door. Someone else's stays put
 * (their promise, and RLS wouldn't let us touch it anyway). */
const mine = computed(
  () => talk.appointments.find((a) => a.canvasser_id === auth.profile?.id) ?? null,
)

function pickDay(key: string) {
  hapticTap('light')
  dayKey.value = key
  picked.value = null
  customTime.value = ''
}

function pickWindow(w: ApptWindow) {
  hapticTap('light')
  customTime.value = ''
  picked.value = w.start.getHours() * 60 + w.start.getMinutes()
}

function onCustomTime(value: string) {
  customTime.value = value
  const [h, m] = value.split(':').map(Number)
  picked.value = Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}

// A fresh sheet every time: the door, the person and the clock have all moved
// since it last closed.
watch(open, (v) => {
  if (!v) return
  saveError.value = ''
  customTime.value = ''
  picked.value = null
  // Late enough that today has no windows left, tomorrow is the real answer.
  dayKey.value = buildWindows(todayKey.value).length ? todayKey.value : tomorrowKey.value
})

async function save() {
  const window = chosen.value
  const door = talk.selectedAddress
  const me = auth.profile
  if (!window || !door || !me) return
  saving.value = true
  saveError.value = ''
  const row = {
    household_id: door.id,
    person_id: talk.selectedPerson?.id ?? null,
    canvasser_id: me.id,
    starts_at: window.start.toISOString(),
    ends_at: window.end.toISOString(),
    status: 'scheduled' as const,
  }
  const existing = mine.value
  const { error } = existing
    ? await supabase
        .from('appointments')
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    : await supabase.from('appointments').insert(row)
  saving.value = false
  if (error) {
    // No offline queue here on purpose (unlike knocks): a promise to come
    // back is worth saying out loud when it didn't save.
    saveError.value = 'Couldn’t save. Try again.'
    return
  }
  hapticNotify('success')
  await talk.reloadAppointments()
  open.value = false
}

async function cancelExisting() {
  const existing = mine.value
  if (!existing) return
  saving.value = true
  saveError.value = ''
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('id', existing.id)
  saving.value = false
  if (error) {
    saveError.value = 'Couldn’t remove it. Try again.'
    return
  }
  await talk.reloadAppointments()
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Come back when?">
    <div class="appt">
      <p v-if="talk.selectedAddress" class="where">
        {{ talk.selectedAddress.street
        }}<template v-if="talk.selectedPerson"> · {{ talk.selectedPerson.name }}</template>
      </p>

      <!-- Already promised. Shown so a second tap reschedules knowingly
           instead of quietly stacking two visits on one door. -->
      <div v-if="mine" class="booked">
        <span class="booked-dot" aria-hidden="true"></span>
        <span class="booked-text">
          Booked {{ new Date(mine.starts_at).toLocaleDateString([], { weekday: 'short' }) }}
          {{ windowLabel(new Date(mine.starts_at), new Date(mine.ends_at)) }}
        </span>
        <button class="btn btn-sm" :disabled="saving" @click="cancelExisting">Remove</button>
      </div>

      <div class="chip-row" role="group" aria-label="Day">
        <button
          type="button"
          class="chip"
          :class="{ on: dayKey === todayKey }"
          @click="pickDay(todayKey)"
        >
          Today
        </button>
        <button
          type="button"
          class="chip"
          :class="{ on: dayKey === tomorrowKey }"
          @click="pickDay(tomorrowKey)"
        >
          Tomorrow
        </button>
        <input
          class="day-input"
          type="date"
          :min="todayKey"
          :value="dayKey"
          aria-label="Another day"
          @change="pickDay(($event.target as HTMLInputElement).value || todayKey)"
        />
      </div>

      <div v-if="windows.length" class="win-grid">
        <button
          v-for="w in windows"
          :key="w.label"
          type="button"
          class="win"
          :class="{ on: !customTime && chosen?.label === w.label }"
          @click="pickWindow(w)"
        >
          {{ w.label }}
        </button>
      </div>
      <p v-else class="muted state">No windows left today.</p>

      <label class="other">
        <span class="other-label">Other time</span>
        <input
          type="time"
          :value="customTime"
          @input="onCustomTime(($event.target as HTMLInputElement).value)"
        />
        <span v-if="customTime && chosen" class="other-window">{{ chosen.label }}</span>
      </label>

      <p v-if="saveError" class="error">{{ saveError }}</p>

      <div class="actions">
        <button class="btn" type="button" @click="open = false">Not now</button>
        <button
          class="btn btn-primary save"
          type="button"
          :disabled="!chosen || chosenIsPast || saving"
          :title="chosenIsPast ? 'That window already closed' : undefined"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.appt {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.where {
  margin: 0;
  font-weight: 700;
  font-size: 0.95rem;
}

.booked {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 0.9rem;
}

.booked-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e0a02e;
  flex-shrink: 0;
}

.booked-text {
  flex: 1;
  min-width: 0;
  font-weight: 700;
}

.chip-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

/* Same pill the analytics scope row uses — a bit taller here, since this one
 * gets tapped on a porch. */
.chip {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}

.chip.on {
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  border-color: var(--accent);
  color: var(--text);
}

.day-input {
  flex: 1;
  min-width: 8.5rem;
  width: auto;
  padding: 0.35rem 0.5rem;
  font: inherit;
  font-size: max(16px, 0.88rem);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
}

/* Window chips are the main target here — thumb-sized, two or three up. */
.win-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: 0.5rem;
}

.win {
  min-height: 52px;
  padding: 0.4rem 0.6rem;
  font: inherit;
  font-size: 1rem;
  font-weight: 700;
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.win:active {
  filter: brightness(0.95);
}

.win.on {
  border-color: #e0a02e;
  background: color-mix(in srgb, #e0a02e 16%, var(--surface));
}

.other {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.other-label {
  color: var(--text-muted);
  flex-shrink: 0;
}

.other input {
  width: auto;
  padding: 0.35rem 0.5rem;
  font: inherit;
  font-size: max(16px, 0.9rem);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
}

.other-window {
  font-weight: 700;
}

.state {
  margin: 0;
  font-size: 0.9rem;
}

.error {
  margin: 0;
  color: var(--danger, #c0392b);
  font-size: 0.9rem;
}

.actions {
  display: flex;
  gap: 0.6rem;
}

/* Equal halves on purpose. Elsewhere the forward action takes the width
 * (Next in the walk row), but booking a time is genuinely optional here —
 * "Not now" is a right answer, not a bail-out, so it gets the same thumb. */
.actions .btn {
  flex: 1;
  min-height: 52px;
  font-size: 1rem;
  font-weight: 700;
}
</style>
