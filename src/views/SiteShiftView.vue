<script setup lang="ts">
// One site shift, worked (2026-11-19): the registration screen with no map.
//
// At a site there are no doors, no roster and nowhere to walk to, so the
// whole screen is the tally: five buttons, one tap per person talked to, each
// showing the crew's running count. Undo takes back YOUR last tap.
//
// Each tap is its own row in registration_logs, written straight away. There
// is no offline queue here on purpose for a first version: a site is usually
// somewhere with signal, and a tap that fails says so and gives the count
// back rather than pretending.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import ShiftSheet from '@/components/sites/ShiftSheet.vue'
import { avatarUrl } from '@/lib/avatars'
import { localToday } from '@/lib/day'
import { memberColor } from '@/lib/memberColors'
import { hapticTap } from '@/lib/native'
import { onPageEnter } from '@/lib/pageState'
import {
  REG_RESULTS,
  conversations,
  fetchShift,
  personName,
  shiftDayLabel,
  shiftTimeLabel,
  type RegResult,
  type SiteShift,
} from '@/lib/registration'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'

defineOptions({ name: 'SiteShiftView' })

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const shift = ref<SiteShift | null>(null)
const loading = ref(true)
const missing = ref(false)
const error = ref('')
/** My own taps this session at this shift, newest last: what Undo pops. */
const myTaps = ref<{ id: string; result: RegResult }[]>([])
const editOpen = ref(false)

const shiftId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))

const canPlan = computed(() => {
  const role = auth.profile?.role
  return role === 'campaign_manager' || role === 'admin'
})

let seq = 0
async function load() {
  const id = shiftId.value
  if (!id || route.name !== 'site-shift') return
  const mine = ++seq
  try {
    const row = await fetchShift(id)
    if (mine !== seq) return
    shift.value = row
    missing.value = !row
    if (row && auth.profile) {
      // Undo should reach back past this visit to the screen: my own rows at
      // this shift, oldest first, so the last one is the one to take back.
      const { data } = await supabase
        .from('registration_logs')
        .select('id, result')
        .eq('shift_id', id)
        .eq('canvasser_id', auth.profile.id)
        .order('occurred_at')
        .order('id')
        .limit(1000)
      if (mine === seq) myTaps.value = (data ?? []) as { id: string; result: RegResult }[]
    }
  } catch {
    if (mine === seq) error.value = 'Couldn’t load this shift.'
  } finally {
    if (mine === seq) loading.value = false
  }
}

onPageEnter(load)
// One cached component serves every /sites/:id, so a different id is a
// different shift arriving in the same instance.
watch(shiftId, (id, old) => {
  if (!id || id === old) return
  shift.value = null
  myTaps.value = []
  loading.value = true
  void load()
})

const today = localToday()
const registered = computed(() => (shift.value ? shift.value.counts.registered + shift.value.counts.updated : 0))
const talked = computed(() => (shift.value ? conversations(shift.value.counts) : 0))
const goalPct = computed(() => {
  const g = shift.value?.goal
  if (!g) return 0
  return Math.min(100, Math.round((registered.value / g) * 100))
})

async function tap(result: RegResult) {
  const s = shift.value
  if (!s || !auth.profile) return
  hapticTap('medium')
  error.value = ''
  // Count first: the number has to move under the thumb, not after a round
  // trip. A failed write hands it back.
  s.counts[result]++
  const { data, error: e } = await supabase
    .from('registration_logs')
    .insert({ canvasser_id: auth.profile.id, site_id: s.site_id, shift_id: s.id, result })
    .select('id')
    .single()
  if (e || !data) {
    s.counts[result] = Math.max(0, s.counts[result] - 1)
    error.value = 'That one didn’t save. Tap it again.'
    return
  }
  myTaps.value.push({ id: data.id as string, result })
}

async function undo() {
  const s = shift.value
  const last = myTaps.value[myTaps.value.length - 1]
  if (!s || !last) return
  hapticTap('light')
  error.value = ''
  myTaps.value.pop()
  s.counts[last.result] = Math.max(0, s.counts[last.result] - 1)
  const { error: e } = await supabase.from('registration_logs').delete().eq('id', last.id)
  if (e) {
    myTaps.value.push(last)
    s.counts[last.result]++
    error.value = 'Couldn’t undo. Try again.'
  }
}

function onDeleted() {
  void router.replace('/sites')
}
</script>

<template>
  <AppShell :title="shift?.site.name ?? 'Site'">
    <div class="site-page">
      <router-link class="back" to="/sites">‹ Sites</router-link>

      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="missing" class="muted">This shift is gone.</p>

      <template v-else-if="shift">
        <div class="card head">
          <div class="head-main">
            <span v-if="shift.site.address" class="muted site-sub">{{ shift.site.address }}</span>
            <span class="site-sub">
              {{ shiftDayLabel(shift.shift_date, today) }}<template v-if="shiftTimeLabel(shift)"> · {{ shiftTimeLabel(shift) }}</template>
            </span>
            <span v-if="shift.notes" class="muted site-sub">{{ shift.notes }}</span>
          </div>
          <button v-if="canPlan" class="btn btn-sm" @click="editOpen = true">Edit</button>
        </div>

        <div v-if="shift.members.length" class="crew">
          <router-link v-for="m in shift.members" :key="m.id" class="crew-chip" :to="`/member/${m.id}`">
            <img v-if="m.avatar" class="crew-face" :src="avatarUrl(m.avatar)" alt="" :style="{ borderColor: memberColor(m) }" />
            {{ personName(m) }}
          </router-link>
        </div>

        <div class="card progress">
          <div class="progress-nums">
            <span class="big">{{ registered }}</span>
            <span class="progress-lbl">
              registered<template v-if="shift.goal != null"> of {{ shift.goal }}</template> · {{ talked }} conversations
            </span>
          </div>
          <div v-if="shift.goal" class="bar" role="progressbar" :aria-valuenow="goalPct" aria-valuemin="0" aria-valuemax="100">
            <div class="bar-fill" :style="{ width: goalPct + '%' }" />
          </div>
        </div>

        <div class="tally-grid">
          <button
            v-for="r in REG_RESULTS"
            :key="r.value"
            class="btn tally-btn"
            :class="{ wide: r.value === 'registered' }"
            :style="{ '--result-color': r.hex }"
            @click="tap(r.value)"
          >
            <span class="tally-n">{{ shift.counts[r.value] }}</span>
            <span class="tally-l">{{ r.label }}</span>
          </button>
        </div>

        <p v-if="error" class="error-line">{{ error }}</p>

        <button class="btn undo-btn" :disabled="!myTaps.length" @click="undo">Undo my last tap</button>
      </template>

      <p v-else-if="error" class="error-line">{{ error }}</p>
    </div>

    <ShiftSheet v-model:open="editOpen" :shift="shift" @saved="load" @deleted="onDeleted" />
  </AppShell>
</template>

<style scoped>
.site-page {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.back {
  align-self: flex-start;
  color: var(--accent);
  font-weight: 700;
  text-decoration: none;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem;
}

.head-main {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.site-sub {
  font-size: 0.86rem;
  overflow-wrap: anywhere;
}

.crew {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.crew-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
}

.crew-face {
  width: 22px;
  height: 22px;
  border: 2px solid transparent;
  border-radius: 50%;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.7rem 0.85rem;
}

.progress-nums {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.45rem;
}

.big {
  font-size: 2rem;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.progress-lbl {
  font-size: 0.9rem;
  font-weight: 600;
}

.bar {
  height: 10px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: #2e9e5b;
}

/* Registered is the one the shift exists for, so it takes the full width
 * and the rest pair up under it. */
.tally-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.tally-btn {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-height: 92px;
  padding: 0.6rem 0.5rem;
  border: 2px solid var(--result-color);
  background: var(--surface);
  color: var(--result-color);
  white-space: normal;
  line-height: 1.15;
}

.tally-btn.wide {
  grid-column: 1 / -1;
  min-height: 112px;
  background: var(--result-color);
  color: #fff;
}

.tally-btn:active {
  filter: brightness(0.93);
}

.tally-n {
  font-size: 2rem;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.tally-l {
  font-size: 1rem;
  font-weight: 700;
}

.undo-btn {
  align-self: stretch;
}

.error-line {
  margin: 0;
  color: var(--danger);
  font-weight: 600;
}
</style>
