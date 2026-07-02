<script setup lang="ts">
import { computed } from 'vue'
import { OUTCOMES } from '@/lib/outcomes'
import { useTalkStore } from '@/stores/talk'

const talk = useTalkStore()

// Buttons stay fully functional with no person picked (anonymous walk-ups
// must work in two taps) — just visually muted as a hint that tapping will
// log against the household (or fully anonymously, with no address either)
// rather than a specific person.
const hasTarget = computed(() => talk.selectedPerson !== null)
</script>

<template>
  <div class="outcome-row">
    <div class="outcome-grid" :class="{ muted: !hasTarget }">
      <button
        v-for="o in OUTCOMES"
        :key="o.value"
        class="btn outcome-btn"
        :class="{ active: talk.pendingOutcome === o.value }"
        :style="{ '--outcome-color': o.color }"
        @click="talk.logOutcome(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
    <!-- Confirms before the screen clears — no silent auto-advance. Only
         appears once something is actually logged for the current target. -->
    <button v-if="talk.pendingOutcome" class="btn btn-primary next-btn" @click="talk.confirmNext()">
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

/* Muted (no person picked) — a near-black scrim over the whole button,
 * words included. Still fully clickable: anonymous walk-ups need this to
 * work in two taps, so the overlay never blocks pointer events. */
.outcome-grid.muted .outcome-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(10, 10, 10, 0.82);
  pointer-events: none;
}

.next-btn {
  min-height: 56px;
  font-size: 1.05rem;
  align-self: flex-end;
  min-width: 140px;
}
</style>
