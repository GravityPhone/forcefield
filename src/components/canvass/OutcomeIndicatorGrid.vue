<script setup lang="ts">
import { computed } from 'vue'
import { OUTCOMES } from '@/lib/outcomes'
import type { HouseholdKnockSummary } from '@/types'

const props = defineProps<{ summary: HouseholdKnockSummary | null }>()

const countKey: Record<string, keyof HouseholdKnockSummary> = {
  signed: 'signed_count',
  didnt_sign: 'didnt_sign_count',
  maybe: 'maybe_count',
  not_home: 'not_home_count',
  skip: 'skip_count',
  hostile: 'hostile_count',
}

/** One cell per Talk-mode outcome button, same colors, same order — filled
 * when that outcome has happened at this door at least once, hollow when it
 * hasn't. A compact visual fingerprint instead of a text line that has to
 * fit "3 knocks · 2/4 signed · Reached" into a tight row. */
const cells = computed(() =>
  OUTCOMES.map((o) => ({
    ...o,
    count: props.summary ? (props.summary[countKey[o.value]] as number) : 0,
  })),
)

const tooltip = computed(() => {
  const active = cells.value.filter((c) => c.count)
  return active.length ? active.map((c) => `${c.label}: ${c.count}`).join(', ') : 'Not knocked'
})
</script>

<template>
  <span class="outcome-grid" :title="tooltip">
    <span
      v-for="c in cells"
      :key="c.value"
      class="cell"
      :class="{ filled: c.count > 0 }"
      :style="{ '--cell-color': c.hex }"
    ></span>
  </span>
</template>

<style scoped>
.outcome-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3px;
  width: fit-content;
}

.cell {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  border: 1.5px solid var(--cell-color);
  background: transparent;
  opacity: 0.4;
}

.cell.filled {
  background: var(--cell-color);
  opacity: 1;
}
</style>
