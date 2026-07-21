<script setup lang="ts">
// Horizontal bars with optional confidence-interval whiskers. Value labels sit
// OUTSIDE the bar end (never clipped inside), the whole row is the hover
// target, and bars stay ≤18px thick with square baselines / rounded data-ends.
// With `selectable`, rows are tap targets (the Analytics drill-down); with
// `refValue`, a dashed marker shows the campaign-wide average for context.
import { computed, ref } from 'vue'
import { fmtCount, fmtPct } from '@/lib/chartTheme'
import { useChartWidth } from './useChartWidth'

export interface BarItem {
  label: string
  value: number
  /** confidence interval (same units as value) */
  lo?: number
  hi?: number
  color?: string
  /** shown in the tooltip, e.g. "412 knocks" */
  detail?: string
  /** opaque handle for select handlers (e.g. a profile id behind a name) */
  id?: string
}

const props = withDefaults(
  defineProps<{
    items: BarItem[]
    percent?: boolean
    /** default fill when an item has no color (slot-1 blue set by caller) */
    color: string
    /** upper bound of the axis; defaults to data max (or 1 for percent) */
    max?: number
    /** rows become tap targets; each tap emits `select` with its item */
    selectable?: boolean
    /** dashed reference marker (campaign average) across the rows */
    refValue?: number
    refLabel?: string
  }>(),
  { percent: false, selectable: false, refLabel: 'avg' },
)

const emit = defineEmits<{ (e: 'select', item: BarItem): void }>()

const { el, width } = useChartWidth()
const ROW_H = 30
const BAR_H = 16
const LABEL_W = 130
const VALUE_W = 52

const axisMax = computed(() => {
  // the reference marker must stay on-axis even when every bar sits below it
  if (props.max != null) return Math.max(props.max, props.refValue ?? 0) || 1
  let m = 0
  for (const it of props.items) m = Math.max(m, it.hi ?? it.value)
  return Math.max(m, props.refValue ?? 0) || 1
})
const plotW = computed(() => Math.max(40, width.value - LABEL_W - VALUE_W - 8))
const w = (v: number) => (Math.min(v, axisMax.value) / axisMax.value) * plotW.value
const height = computed(() => props.items.length * ROW_H + 4 + (props.refValue != null ? 14 : 0))

const hover = ref<number | null>(null)
const fmt = (v: number) => (props.percent ? fmtPct(v, 1) : fmtCount(v))
</script>

<template>
  <div ref="el" class="bars">
    <svg :width="width" :height="height" role="img">
      <!-- reference marker sits under the rows so it never steals their taps -->
      <g v-if="refValue != null" class="ref">
        <line
          :x1="LABEL_W + w(refValue)"
          :x2="LABEL_W + w(refValue)"
          :y1="0"
          :y2="items.length * ROW_H"
        />
        <text class="ref-label" :x="LABEL_W + w(refValue)" :y="items.length * ROW_H + 11" text-anchor="middle">
          {{ refLabel }}
        </text>
      </g>
      <g
        v-for="(it, i) in items"
        :key="it.label"
        class="row"
        :class="{ sel: selectable }"
        :opacity="hover === null || hover === i ? 1 : 0.55"
        @pointerenter="hover = i"
        @pointerleave="hover = null"
        @click="selectable && emit('select', it)"
      >
        <!-- full-row hit target -->
        <rect :x="0" :y="i * ROW_H" :width="width" :height="ROW_H" fill="transparent" />
        <text class="label" :x="LABEL_W - 8" :y="i * ROW_H + ROW_H / 2 + 4" text-anchor="end">
          {{ it.label }}
        </text>
        <!-- bar: square at baseline, rounded data-end -->
        <path
          :d="`M${LABEL_W},${i * ROW_H + (ROW_H - BAR_H) / 2}
              h${Math.max(0, w(it.value) - 4)}
              a4,4 0 0 1 4,4 v${BAR_H - 8} a4,4 0 0 1 -4,4
              h${-Math.max(0, w(it.value) - 4)} Z`"
          :fill="it.color ?? color"
        />
        <!-- CI whisker -->
        <g v-if="it.lo != null && it.hi != null" class="whisker">
          <line
            :x1="LABEL_W + w(it.lo)"
            :x2="LABEL_W + w(it.hi)"
            :y1="i * ROW_H + ROW_H / 2"
            :y2="i * ROW_H + ROW_H / 2"
          />
          <line
            v-for="end in [it.lo, it.hi]"
            :key="end"
            :x1="LABEL_W + w(end!)"
            :x2="LABEL_W + w(end!)"
            :y1="i * ROW_H + ROW_H / 2 - 4"
            :y2="i * ROW_H + ROW_H / 2 + 4"
          />
        </g>
        <!-- value outside the bar end -->
        <text class="value" :x="LABEL_W + w(it.hi ?? it.value) + 6" :y="i * ROW_H + ROW_H / 2 + 4">
          {{ fmt(it.value) }}
        </text>
      </g>
    </svg>
    <div v-if="hover !== null && items[hover]?.detail" class="detail muted">
      {{ items[hover].label }}: {{ items[hover].detail }}
    </div>
  </div>
</template>

<style scoped>
.bars {
  min-width: 0;
}
svg {
  display: block;
  max-width: 100%;
}
.label {
  fill: var(--text);
  font-size: 12px;
}
.value {
  fill: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.whisker line {
  stroke: var(--text);
  stroke-width: 1.5;
  opacity: 0.75;
}
.detail {
  font-size: 0.78rem;
  min-height: 1.2em;
  margin-top: 0.2rem;
}
.row {
  transition: opacity 0.1s ease;
}
.row.sel {
  cursor: pointer;
}
.ref line {
  stroke: var(--text-muted);
  stroke-width: 1.5;
  stroke-dasharray: 4 4;
  opacity: 0.8;
}
.ref-label {
  fill: var(--text-muted);
  font-size: 10px;
}
</style>
