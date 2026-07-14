<script setup lang="ts">
// Stacked daily columns (outcome mix per day). Segments are separated by a
// 2px surface gap — never a stroke — and each column is one big hover target
// whose tooltip lists every series. Colors are passed in (OUTCOME_HEX here),
// with the legend carrying identity.
import { computed, ref } from 'vue'
import { niceTicks, fmtCount } from '@/lib/chartTheme'
import { useChartWidth } from './useChartWidth'

export interface StackSeries {
  name: string
  color: string
  values: number[]
}

const props = withDefaults(
  defineProps<{
    labels: string[]
    series: StackSeries[]
    height?: number
  }>(),
  { height: 240 },
)

const { el, width } = useChartWidth()
const PAD = { top: 10, right: 8, bottom: 26, left: 44 }
const plotW = computed(() => Math.max(40, width.value - PAD.left - PAD.right))
const plotH = computed(() => props.height - PAD.top - PAD.bottom)

const totals = computed(() =>
  props.labels.map((_, i) => props.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)),
)
const ticks = computed(() => niceTicks(0, Math.max(...totals.value, 1)))
const yMax = computed(() => ticks.value[ticks.value.length - 1] || 1)

const slot = computed(() => plotW.value / Math.max(1, props.labels.length))
const barW = computed(() => Math.min(24, Math.max(3, slot.value - 3)))
const xOf = (i: number) => PAD.left + i * slot.value + (slot.value - barW.value) / 2
const hOf = (v: number) => (v / yMax.value) * plotH.value

/** y-stacked segments with a 2px surface gap between non-empty neighbors */
function segments(i: number): { color: string; name: string; y: number; h: number; v: number }[] {
  const out = []
  let acc = 0
  for (const s of props.series) {
    const v = s.values[i] ?? 0
    if (v <= 0) continue
    const hRaw = hOf(v)
    const yTop = PAD.top + plotH.value - hOf(acc) - hRaw
    out.push({ color: s.color, name: s.name, y: yTop + (out.length ? 1 : 0), h: Math.max(1, hRaw - (out.length ? 2 : 0)), v })
    acc += v
  }
  return out
}

const hover = ref<number | null>(null)
function onMove(ev: PointerEvent) {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect()
  const i = Math.floor((ev.clientX - rect.left - PAD.left) / Math.max(1, slot.value))
  hover.value = i >= 0 && i < props.labels.length ? i : null
}
const tooltipLeft = computed(() => {
  if (hover.value == null) return 0
  const cx = xOf(hover.value)
  return cx > width.value * 0.6 ? cx - 168 : cx + barW.value + 8
})
</script>

<template>
  <div ref="el" class="sb-wrap">
    <svg :width="width" :height="height" role="img" @pointermove="onMove" @pointerleave="hover = null">
      <g v-for="t in ticks" :key="t">
        <line
          class="grid"
          :x1="PAD.left"
          :x2="width - PAD.right"
          :y1="PAD.top + plotH - (t / yMax) * plotH"
          :y2="PAD.top + plotH - (t / yMax) * plotH"
        />
        <text class="tick" :x="PAD.left - 6" :y="PAD.top + plotH - (t / yMax) * plotH + 3" text-anchor="end">
          {{ fmtCount(t) }}
        </text>
      </g>
      <template v-if="labels.length">
        <text
          v-for="i in [0, Math.floor((labels.length - 1) / 2), labels.length - 1].filter((v, ix, a) => a.indexOf(v) === ix)"
          :key="'x' + i"
          class="tick"
          :x="xOf(i) + barW / 2"
          :y="height - 8"
          :text-anchor="i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'"
        >
          {{ labels[i] }}
        </text>
      </template>

      <g
        v-for="(label, i) in labels"
        :key="label"
        :opacity="hover === null || hover === i ? 1 : 0.55"
      >
        <rect
          v-for="seg in segments(i)"
          :key="seg.name"
          :x="xOf(i)"
          :y="seg.y"
          :width="barW"
          :height="seg.h"
          :fill="seg.color"
          rx="1.5"
        />
      </g>
    </svg>

    <div v-if="hover != null" class="tooltip" :style="{ left: tooltipLeft + 'px' }">
      <div class="tt-label">{{ labels[hover] }} · {{ fmtCount(totals[hover]) }} total</div>
      <div v-for="s in series" :key="s.name" class="tt-row">
        <span class="key" :style="{ background: s.color }" />
        <strong>{{ fmtCount(s.values[hover] ?? 0) }}</strong>
        <span class="muted">{{ s.name }}</span>
      </div>
    </div>

    <div class="legend">
      <span v-for="s in series" :key="s.name" class="legend-item">
        <span class="swatch" :style="{ background: s.color }" />{{ s.name }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.sb-wrap {
  position: relative;
  min-width: 0;
}
svg {
  display: block;
  max-width: 100%;
  touch-action: none;
}
.grid {
  stroke: var(--border);
  stroke-width: 1;
}
.tick {
  fill: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tooltip {
  position: absolute;
  top: 6px;
  pointer-events: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 0.6);
  box-shadow: var(--shadow);
  padding: 0.45rem 0.6rem;
  font-size: 0.78rem;
  min-width: 140px;
  z-index: 3;
}
.tt-label {
  color: var(--text-muted);
  margin-bottom: 0.2rem;
}
.tt-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  line-height: 1.5;
}
.key {
  display: inline-block;
  width: 12px;
  height: 3px;
  border-radius: 2px;
  flex-shrink: 0;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.9rem;
  margin-top: 0.4rem;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}
</style>
