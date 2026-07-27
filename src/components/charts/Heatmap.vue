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
  /** what one sample IS in the tooltip ("knocks", "interactions") */
  unit?: string
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

// Cells are resolved from the pointer's position rather than per-rect
// `pointerenter`, so a finger can slide across the grid: touch gets an
// implicit capture on whatever it first pressed, and every other cell's enter
// never fires. See the BarChart header for the whole story.
const hover = ref<{ r: number; c: number } | null>(null)
const held = ref(false)
function cellAt(ev: PointerEvent): { r: number; c: number } | null {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect()
  const r = Math.floor((ev.clientY - rect.top) / (CELL_H + GAP))
  const c = Math.floor((ev.clientX - rect.left - LABEL_W) / (cellW.value + GAP))
  if (r < 0 || r >= props.rowLabels.length) return null
  if (c < 0 || c >= props.colLabels.length) return null
  return { r, c }
}
function onDown(ev: PointerEvent) {
  held.value = true
  hover.value = cellAt(ev)
}
function onMove(ev: PointerEvent) {
  if (ev.pointerType === 'mouse' || held.value) hover.value = cellAt(ev)
}
function onLeave(ev: PointerEvent) {
  held.value = false
  if (ev.pointerType === 'mouse') hover.value = null
}

const legendStops = Array.from({ length: 9 }, (_, i) => i / 8)
</script>

<template>
  <div ref="el" class="hm-wrap">
    <svg
      :width="width"
      :height="height"
      role="img"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="held = false"
      @pointercancel="held = false"
      @pointerleave="onLeave"
    >
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
      <strong>{{ rowLabels[hover.r] }} at {{ colLabels[hover.c] }}</strong>
      <span class="muted">
        {{ fmtPct(values[hover.r][hover.c]!, 1) }} answered, out of
        {{ counts[hover.r][hover.c] }} {{ unit ?? 'knocks' }}</span
      >
    </div>
    <div v-else-if="hover" class="detail muted">
      {{ rowLabels[hover.r] }} at {{ colLabels[hover.c] }}: too few {{ unit ?? 'knocks' }} to say
    </div>
    <div v-else class="detail muted">Hold a square to read it</div>

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
  /* A long press reads the cell out; it must never start a text selection. */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: pan-y;
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
