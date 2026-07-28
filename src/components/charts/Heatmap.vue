<script setup lang="ts">
// Rate heatmap (weekday × hour band). One sequential hue carries magnitude,
// cells separated by the surface itself (2px gap), per-cell tooltip with the
// rate AND the sample size, plus a gradient scale legend.
//
// Column headers sit ABOVE the grid, not below (2026-07-28, user call: "it
// should just have the time of day at the top"), and each one can carry a
// second, smaller line — colSubLabels — so a header says both what a block
// is called and when it runs ("Midday" / "Noon to 2:30 PM") instead of
// leaving the hours to a caption elsewhere on the page.
import { computed, ref } from 'vue'
import { sequentialColor, fmtPct } from '@/lib/chartTheme'
import { useChartWidth } from './useChartWidth'

const props = defineProps<{
  rowLabels: string[]
  colLabels: string[]
  /** A second, muted line under each column name — the hours that block
   *  covers. Omit it for a plain single-line header. */
  colSubLabels?: string[]
  /** rate per [row][col], null = no data */
  values: (number | null)[][]
  /** sample size per cell for the tooltip */
  counts: number[][]
  dark: boolean
  /** what one sample IS in the tooltip ("knocks", "interactions") */
  unit?: string
  /** Room for the row labels. 44 fits "Mon"; a grid whose rows are words
   *  ("Weekday") has to say so or they are clipped from the left. */
  labelWidth?: number
}>()

const { el, width } = useChartWidth()
const LABEL_W = props.labelWidth ?? 44
const CELL_H = 26
const GAP = 2
/** Header band above the grid: one line for the block's name, a second and
 *  smaller one for its hours when colSubLabels is given. */
const TOP_H = computed(() => (props.colSubLabels?.length ? 34 : 20))

const cellW = computed(
  () => (Math.max(80, width.value - LABEL_W) - GAP * props.colLabels.length) / Math.max(1, props.colLabels.length),
)
const maxRate = computed(() => {
  let m = 0
  for (const row of props.values) for (const v of row) if (v != null && v > m) m = v
  return m || 1
})
const height = computed(() => props.rowLabels.length * (CELL_H + GAP) + TOP_H.value)

const fill = (v: number | null) =>
  v == null ? 'transparent' : sequentialColor(v / maxRate.value, props.dark)

// Cells are resolved from the pointer's position rather than per-rect
// `pointerenter`, so a finger can slide across the grid: touch gets an
// implicit capture on whatever it first pressed, and every other cell's enter
// never fires. See the BarChart header for the whole story. A tap alone
// already reads a cell — onDown fires on first contact whether or not it's
// held — the drag is there for sliding across cells, not a requirement.
const hover = ref<{ r: number; c: number } | null>(null)
const held = ref(false)
function cellAt(ev: PointerEvent): { r: number; c: number } | null {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect()
  const r = Math.floor((ev.clientY - rect.top - TOP_H.value) / (CELL_H + GAP))
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
      <g v-for="(cl, c) in colLabels" :key="'c' + cl">
        <text
          class="tick col-name"
          :x="LABEL_W + c * (cellW + GAP) + cellW / 2"
          :y="colSubLabels?.length ? 13 : 14"
          text-anchor="middle"
        >
          {{ cl }}
        </text>
        <text
          v-if="colSubLabels?.[c]"
          class="tick col-hours"
          :x="LABEL_W + c * (cellW + GAP) + cellW / 2"
          :y="27"
          text-anchor="middle"
        >
          {{ colSubLabels[c] }}
        </text>
      </g>
      <g v-for="(rl, r) in rowLabels" :key="rl">
        <text
          class="tick"
          :x="LABEL_W - 8"
          :y="TOP_H + r * (CELL_H + GAP) + CELL_H / 2 + 4"
          text-anchor="end"
        >
          {{ rl }}
        </text>
        <rect
          v-for="(cl, c) in colLabels"
          :key="cl"
          :x="LABEL_W + c * (cellW + GAP)"
          :y="TOP_H + r * (CELL_H + GAP)"
          :width="cellW"
          :height="CELL_H"
          rx="3"
          :fill="fill(values[r]?.[c] ?? null)"
          :class="{ empty: (values[r]?.[c] ?? null) == null, lifted: hover?.r === r && hover?.c === c }"
        />
      </g>
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
    <div v-else class="detail muted">Tap a section for more info.</div>

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
/* The block's name outranks a plain axis tick — it's the header of its
   column now, not a label underneath it. */
.col-name {
  fill: var(--text);
  font-weight: 700;
}
.col-hours {
  font-size: 9px;
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
