<script setup lang="ts">
import { OUTCOMES, OUTCOME_LABELS } from '@/lib/outcomes'
import { useTalkStore } from '@/stores/talk'

const talk = useTalkStore()
</script>

<template>
  <!-- After logging, the grid swaps to a confirmation strip: the canvasser
       confirms with Next before the screen clears (no silent auto-advance). -->
  <div v-if="talk.pendingOutcome" class="confirm-strip">
    <span class="logged">Logged: {{ OUTCOME_LABELS[talk.pendingOutcome] }} ✓</span>
    <button class="btn btn-primary next-btn" @click="talk.confirmNext()">Next</button>
  </div>
  <div v-else class="outcome-grid">
    <button
      v-for="o in OUTCOMES"
      :key="o.value"
      class="btn outcome-btn"
      :style="{ '--outcome-color': o.color }"
      @click="talk.logOutcome(o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.outcome-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.6rem;
}

.outcome-btn {
  min-height: 64px;
  font-size: 1.05rem;
  font-weight: 700;
  background: var(--surface);
  border: 2px solid var(--outcome-color);
  color: var(--outcome-color);
}

.outcome-btn:active {
  background: var(--outcome-color);
  color: var(--accent-contrast);
}

.confirm-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 64px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}

.logged {
  font-weight: 700;
}

.next-btn {
  min-height: 56px;
  min-width: 120px;
  font-size: 1.05rem;
}
</style>
