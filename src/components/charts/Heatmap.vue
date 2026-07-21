<script setup lang="ts">
// Rate heatmap (weekday × hour band). One sequential hue carries magnitude,
// cells separated by the surface itself (2px gap), per-cell tooltip with the
// rate AND the sample size, plus a gradient scale legend.
import { computed, ref } from 'vue'
import { sequentialColor, fmtPct } from '@/lib/chartTheme'
import { useChartWidth } from './useChartWidth'

const props = defineProps<{
  rowLabels: string[]
  colLabels: string[]
  /** rate per [row][col], null = no data */
  values: (number | null)[][]
  /** sample size per cell for the tooltip */
  counts: number[][]
  dark: boolean
}>()

const { el, width } = useChartWidth()
const LABEL_W = 44
const CELL_H = 26
const GAP = 2

const cellW = computed(
  () => (Math.max(80, width.value - LABEL_W) - GAP * props.colLabels.length) / Math.max(1, props.colLabels.length),
)
const maxRate = computed(() => {
  let m = 0
  for (const row of props.values) for (const v of row) if (v != null && v > m) m = v
  return m || 1
})
const height = computed(() => props.rowLabels.length * (CELL_H + GAP) + 24)

const fill = (v: number | null) =>
  v == null ? 'transparent' : sequentialColor(v / maxRate.value, props.dark)

const hover = ref<{ r: number; c: number } | null>(null)
const legendStops = Array.from({ length: 9 }, (_, i) => i / 8)
</script>

<template>
  <div ref="el" class="hm-wrap">
    <svg :width="width" :height="height" role="img">
      <g v-for="(rl, r) in rowLabels" :key="rl">
        <text class="tick" :x="LABEL_W - 8" :y="r * (CELL_H + GAP) + CELL_H / 2 + 4" text-anchor="end">
          {{ rl }}
        </text>
        <rect
          v-for="(cl, c) in colLabels"
          :key="cl"
          :x="LABEL_W + c * (cellW + GAP)"
          :y="r * (CELL_H + GAP)"
          :width="cellW"
          :height="CELL_H"
          rx="3"
          :fill="fill(values[r]?.[c] ?? null)"
          :class="{ empty: (values[r]?.[c] ?? null) == null, lifted: hover?.r === r && hover?.c === c }"
          @pointerenter="hover = { r, c }"
          @pointerleave="hover = null"
        />
      </g>
      <text
        v-for="(cl, c) in colLabels"
        :key="'c' + cl"
        class="tick"
        :x="LABEL_W + c * (cellW + GAP) + cellW / 2"
        :y="height - 6"
        text-anchor="middle"
      >
        {{ cl }}
      </text>
    </svg>

    <div v-if="hover && (values[hover.r]?.[hover.c] ?? null) != null" class="detail">
      <strong>{{ fmtPct(values[hover.r][hover.c]!, 1) }}</strong>
      <span class="muted">
        {{ rowLabels[hover.r] }} {{ colLabels[hover.c] }} · {{ counts[hover.r][hover.c] }} knocks</span
      >
    </div>
    <div v-else class="detail muted">Tap any cell</div>

    <div class="scale">
      <span class="muted">0%</span>
      <span class="ramp">
        <span
          v-for="t in legendStops"
          :key="t"
          class="ramp-step"
          :style="{ background: sequentialColor(t, dark) }"
        />
      </span>
      <span class="muted">{{ fmtPct(maxRate) }}</span>
    </div>
  </div>
</template>

<style scoped>
.hm-wrap {
  min-width: 0;
}
svg {
  display: block;
  max-width: 100%;
}
.tick {
  fill: var(--text-muted);
  font-size: 11px;
}
rect.empty {
  stroke: var(--border);
  stroke-width: 1;
  fill: transparent;
}
rect.lifted {
  stroke: var(--text);
  stroke-width: 1.5;
}
.detail {
  font-size: 0.8rem;
  margin-top: 0.35rem;
  min-height: 1.3em;
  display: flex;
  gap: 0.45rem;
  align-items: baseline;
}
.scale {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-top: 0.35rem;
  font-size: 0.72rem;
}
.ramp {
  display: inline-flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  flex: 0 1 140px;
}
.ramp-step {
  flex: 1;
}
</style>
