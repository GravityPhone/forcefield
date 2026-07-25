<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { OUTCOMES } from '@/lib/outcomes'
import { popIn } from '@/lib/motion'
import { hapticNotify, hapticTap } from '@/lib/native'
import { useTalkStore } from '@/stores/talk'
import type { KnockOutcome } from '@/types'

const talk = useTalkStore()

// A physical tick under the finger confirms the tap registered without
// looking down at the screen — this pair of buttons is the highest-frequency
// interaction in the whole app.
function logOutcome(value: KnockOutcome) {
  hapticTap('medium')
  talk.logOutcome(value)
}

function confirmNext() {
  hapticNotify('success')
  void talk.confirmNext()
}

function confirmPrevious() {
  hapticNotify('success')
  void talk.confirmPrevious()
}

// Not Home / Skip / Hostile describe the door interaction, so they only need
// a household loaded. Signed / Didn't Sign / Maybe are a real answer from a
// real person — those stay disabled until someone's actually picked from
// the roster, even once an address is loaded.
// Whether to offer the "My doors" switch at all — it needs turf to filter to.
// Loaded once here so the switch is on screen before the first Next.
onMounted(() => void talk.ensureMyTurf())
const haveMyTurf = computed(() => talk.myTurfIds.size > 0)

function toggleMyDoors() {
  hapticTap('light')
  talk.setMyDoorsOnly(!talk.myDoorsOnly)
}

const hasHousehold = computed(() => talk.selectedAddress !== null)
const hasPerson = computed(() => talk.selectedPerson !== null)
function disabledFor(requiresPerson: boolean): boolean {
  return requiresPerson ? !hasPerson.value : !hasHousehold.value
}
</script>

<template>
  <div class="outcome-row">
    <div class="outcome-grid" data-help="talk-outcomes">
      <button
        v-for="o in OUTCOMES"
        :key="o.value"
        class="btn outcome-btn"
        :class="{ active: talk.pendingOutcome === o.value }"
        :style="{ '--outcome-color': o.hex }"
        :disabled="disabledFor(o.requiresPerson)"
        @click="logOutcome(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
    <!-- On deck whenever a door is loaded — no outcome required (with one
         logged, moving on doubles as the confirm; nothing auto-advances).
         Next walks the street per the direction pref above; Back steps
         back through YOUR knock history (the doors you've logged, newest
         first) — retracing your day, not the street. -->
    <div v-if="talk.selectedAddress" v-motion="popIn()" class="advance-row" data-help="talk-advance">
      <button class="btn prev-btn" title="Back through the doors you've knocked" @click="confirmPrevious">‹ Back</button>
      <button class="btn btn-primary next-btn" @click="confirmNext">Next ›</button>
      <!-- The walk's one filter, right where the walking happens: on, Next,
           Back and the Up-next chips only offer doors on turf that's yours
           today; off, they offer the whole street so you can wander a block
           nobody cut and knock whatever's closest. With no turf of your own
           today it stays on screen but disabled and says why — hiding it
           would read as the feature being missing. -->
      <button
        type="button"
        class="btn mine-btn"
        :class="{ on: talk.myDoorsOnly && haveMyTurf }"
        role="switch"
        :aria-checked="talk.myDoorsOnly && haveMyTurf"
        :disabled="!haveMyTurf"
        :title="
          !haveMyTurf
            ? 'No turf is yours today — a manager sends turf out to each day’s crews'
            : talk.myDoorsOnly
              ? 'Only walking doors assigned to you — tap for every door'
              : 'Walking every door — tap to stick to yours'
        "
        @click="toggleMyDoors"
      >
        <span class="mine-box" aria-hidden="true">{{ talk.myDoorsOnly && haveMyTurf ? '✓' : '' }}</span>
        <span class="mine-label">My doors</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.outcome-row {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.outcome-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.6rem;
}

.outcome-btn {
  position: relative;
  min-height: 64px;
  font-size: 1.05rem;
  font-weight: 700;
  background: var(--surface);
  border: 2px solid var(--outcome-color);
  color: var(--outcome-color);
}

.outcome-btn:active {
  filter: brightness(0.95);
}

.outcome-btn.active {
  background: var(--outcome-color);
  color: var(--accent-contrast);
}

/* Next stays the single most-tapped button in the app — Back shares the
 * row but Next keeps the lion's share of the width, primary-filled, so the
 * default thumb target is still can't-miss walking between doors in the sun. */
.advance-row {
  display: flex;
  gap: 0.6rem;
}

.prev-btn {
  flex: 1;
  min-height: 64px;
  font-size: 1rem;
  font-weight: 700;
}

.next-btn {
  flex: 1.7;
  min-height: 64px;
  font-size: 1.15rem;
  font-weight: 700;
}

/* Narrow on purpose: it rides beside Next without stealing thumb room from
 * it. Reads as a checkbox — pressed state is the accent, the way the outcome
 * buttons and every other toggle in the app read as "on". */
.mine-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  flex: 0 0 auto;
  min-width: 68px;
  min-height: 64px;
  padding: 0.35rem 0.5rem;
  font-weight: 700;
  line-height: 1.1;
}

.mine-btn.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  color: var(--accent);
}

.mine-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 2px solid currentColor;
  border-radius: 4px;
  font-size: 0.85rem;
  line-height: 1;
}

.mine-btn.on .mine-box {
  background: var(--accent);
  color: var(--accent-contrast);
}

.mine-label {
  font-size: 0.72rem;
  white-space: nowrap;
}

.mine-btn:disabled {
  opacity: 0.45;
}
</style>
