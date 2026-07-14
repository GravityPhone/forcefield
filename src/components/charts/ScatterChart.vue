<script setup lang="ts">
// Scatter with an optional OLS fit line. Dots are ≥8px with a 2px surface
// ring; hovering uses NEAREST-point search over the whole plot (nobody has to
// land on a dot dead-center), and the hovered point's label + values show in
// a tooltip.
import { computed, ref } from 'vue'
import { niceTicks, fmtCount, fmtPct } from '@/lib/chartTheme'
import type { LinearFit } from '@/lib/stats'
import { useChartWidth } from './useChartWidth'

export interface ScatterPoint {
  x: number
  y: number
  label: string
  color?: string
}

const props = withDefaults(
  defineProps<{
    points: ScatterPoint[]
    color: string
    fit?: LinearFit | null
    height?: number
    xLabel: string
    yLabel: string
    yPercent?: boolean
  }>(),
  { height: 260, yPercent: false },
)

const { el, width } = useChartWidth()
const PAD = { top: 12, right: 14, bottom: 34, left: 48 }
const plotW = computed(() => Math.max(40, width.value - PAD.left - PAD.right))
const plotH = computed(() => props.height - PAD.top - PAD.bottom)

const xMaxData = computed(() => Math.max(...props.points.map((p) => p.x), 1))
const yMaxData = computed(() => Math.max(...props.points.map((p) => p.y), props.yPercent ? 0.1 : 1))
const xTicks = computed(() => niceTicks(0, xMaxData.value))
const yTicks = computed(() => niceTicks(0, yMaxData.value))
const xMax = computed(() => xTicks.value[xTicks.value.length - 1] || 1)
const yMax = computed(() => yTicks.value[yTicks.value.length - 1] || 1)

const px = (v: number) => PAD.left + (v / xMax.value) * plotW.value
const py = (v: number) => PAD.top + plotH.value - (v / yMax.value) * plotH.value

const fitPath = computed(() => {
  if (!props.fit) return ''
  const y0 = props.fit.predict(0)
  const y1 = props.fit.predict(xMax.value)
  const clampY = (v: number) => Math.min(yMax.value, Math.max(0, v))
  return `M${px(0)},${py(clampY(y0))} L${px(xMax.value)},${py(clampY(y1))}`
})

const hover = ref<number | null>(null)
function onMove(ev: PointerEvent) {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect()
  const mx = ev.clientX - rect.left
  const my = ev.clientY - rect.top
  let best = -1
  let bestD = Infinity
  props.points.forEach((p, i) => {
    const d = (px(p.x) - mx) ** 2 + (py(p.y) - my) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  hover.value = best >= 0 && bestD < 48 ** 2 ? best : null
}
const fmtY = (v: number) => (props.yPercent ? fmtPct(v, 1) : fmtCount(v))
const tooltipLeft = computed(() => {
  if (hover.value == null) return 0
  const cx = px(props.points[hover.value].x)
  return cx > width.value * 0.6 ? cx - 150 : cx + 12
})
</script>

<template>
  <div ref="el" class="sc-wrap">
    <svg :width="width" :height="height" role="img" @pointermove="onMove" @pointerleave="hover = null">
      <g v-for="t in yTicks" :key="'y' + t">
        <line class="grid" :x1="PAD.left" :x2="width - PAD.right" :y1="py(t)" :y2="py(t)" />
        <text class="tick" :x="PAD.left - 6" :y="py(t) + 3" text-anchor="end">{{ fmtY(t) }}</text>
      </g>
      <g v-for="t in xTicks" :key="'x' + t">
        <text class="tick" :x="px(t)" :y="height - 20" text-anchor="middle">{{ fmtCount(t) }}</text>
      </g>
      <text class="axis-label" :x="PAD.left + plotW / 2" :y="height - 4" text-anchor="middle">{{ xLabel }}</text>
      <text
        class="axis-label"
        :transform="`rotate(-90 12 ${PAD.top + plotH / 2})`"
        :x="12"
        :y="PAD.top + plotH / 2"
        text-anchor="middle"
      >
        {{ yLabel }}
      </text>

      <path v-if="fit" class="fit" :d="fitPath" :stroke="color" />

      <circle
        v-for="(p, i) in points"
        :key="i"
        :cx="px(p.x)"
        :cy="py(p.y)"
        :r="hover === i ? 6 : 4.5"
        :fill="p.color ?? color"
        class="dot"
        :opacity="hover === null || hover === i ? 1 : 0.5"
      />
    </svg>

    <div v-if="hover != null" class="tooltip" :style="{ left: tooltipLeft + 'px' }">
      <div class="tt-label">{{ points[hover].label }}</div>
      <div><strong>{{ fmtCount(points[hover].x) }}</strong> <span class="muted">{{ xLabel }}</span></div>
      <div><strong>{{ fmtY(points[hover].y) }}</strong> <span class="muted">{{ yLabel }}</span></div>
    </div>
    <p v-if="fit" class="fit-note muted">
      Fit: {{ yLabel }} ≈ {{ fit.intercept.toFixed(3) }} + {{ fit.slope.toFixed(4) }} × {{ xLabel }} · R²
      {{ fit.r2.toFixed(2) }} · n {{ fit.n }}
    </p>
  </div>
</template>

<style scoped>
.sc-wrap {
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
.axis-label {
  fill: var(--text-muted);
  font-size: 11px;
}
.dot {
  stroke: var(--surface);
  stroke-width: 2;
  transition: r 0.08s ease;
}
.fit {
  stroke-width: 2;
  stroke-dasharray: none;
  opacity: 0.45;
  fill: none;
}
.tooltip {
  position: absolute;
  top: 8px;
  pointer-events: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 0.6);
  box-shadow: var(--shadow);
  padding: 0.45rem 0.6rem;
  font-size: 0.78rem;
  min-width: 120px;
  z-index: 3;
}
.tt-label {
  color: var(--text-muted);
  margin-bottom: 0.15rem;
}
.fit-note {
  font-size: 0.75rem;
  margin: 0.3rem 0 0;
}
</style>
