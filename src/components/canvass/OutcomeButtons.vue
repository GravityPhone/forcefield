<script setup lang="ts">
import { computed } from 'vue'
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
  talk.confirmNext()
}

// Not Home / Skip / Hostile describe the door interaction, so they only need
// a household loaded. Signed / Didn't Sign / Maybe are a real answer from a
// real person — those stay disabled until someone's actually picked from
// the roster, even once an address is loaded.
const hasHousehold = computed(() => talk.selectedAddress !== null)
const hasPerson = computed(() => talk.selectedPerson !== null)
function disabledFor(requiresPerson: boolean): boolean {
  return requiresPerson ? !hasPerson.value : !hasHousehold.value
}
</script>

<template>
  <div class="outcome-row">
    <div class="outcome-grid">
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
    <!-- Confirms before the screen clears — no silent auto-advance. Only
         appears once something is actually logged for the current target. -->
    <button
      v-if="talk.pendingOutcome"
      v-motion="popIn()"
      class="btn btn-primary next-btn"
      @click="confirmNext"
    >
      Next
    </button>
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

/* The single most-tapped button in the app — full width, can't miss it
 * walking between doors in the sun. */
.next-btn {
  width: 100%;
  min-height: 64px;
  font-size: 1.15rem;
  font-weight: 700;
}
</style>
