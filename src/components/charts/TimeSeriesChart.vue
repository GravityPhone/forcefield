<script setup lang="ts">
// Multi-series line chart with a crosshair tooltip: the hairline snaps to the
// nearest x position and the tooltip lists EVERY series at that x, so the
// pointer aims at a date, never at a 2px line. Null values break the line
// (used by rolling averages that don't exist for the first days). The legend
// is interactive — tapping a name hides that series and the chart re-scales
// to what's left, which is how a small series gets a close look.
import { computed, ref } from 'vue'
import { niceTicks, fmtCount, fmtPct } from '@/lib/chartTheme'
import { useChartWidth } from './useChartWidth'

export interface TimeSeries {
  name: string
  color: string
  values: (number | null)[]
  /** draw a ~10% opacity area wash under the line */
  area?: boolean
  /** stroke width (default 2) — rolling averages run thicker */
  width?: number
  /** dashed stroke — the "this is derived, not raw" signal */
  dash?: boolean
}

const props = withDefaults(
  defineProps<{
    labels: string[]
    series: TimeSeries[]
    height?: number
    percent?: boolean
  }>(),
  { height: 240, percent: false },
)

const { el, width } = useChartWidth()
const PAD = { top: 12, right: 14, bottom: 26, left: 44 }

const plotW = computed(() => Math.max(40, width.value - PAD.left - PAD.right))
const plotH = computed(() => props.height - PAD.top - PAD.bottom)

// Legend-toggled series. Hiding one re-scales the axis to the rest.
const hidden = ref<Set<string>>(new Set())
const shown = computed(() => props.series.filter((s) => !hidden.value.has(s.name)))
function toggle(name: string) {
  const next = new Set(hidden.value)
  if (!next.delete(name)) next.add(name)
  hidden.value = next
}

const maxVal = computed(() => {
  let m = 0
  for (const s of shown.value) for (const v of s.values) if (v != null && v > m) m = v
  return m || 1
})
const ticks = computed(() => niceTicks(0, maxVal.value))
const yMax = computed(() => ticks.value[ticks.value.length - 1] || 1)

const x = (i: number) =>
  PAD.left + (props.labels.length <= 1 ? plotW.value / 2 : (i / (props.labels.length - 1)) * plotW.value)
const y = (v: number) => PAD.top + plotH.value - (v / yMax.value) * plotH.value

function pathFor(values: (number | null)[]): string {
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v == null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    pen = true
  })
  return d
}

function areaFor(values: (number | null)[]): string {
  // one closed wash per contiguous non-null run, dropped to the baseline
  const base = (PAD.top + plotH.value).toFixed(1)
  let d = ''
  let run: number[] = []
  const flush = () => {
    if (run.length >= 2) {
      const pts = run.map((i) => `${x(i).toFixed(1)},${y(values[i]!).toFixed(1)}`).join(' L')
      d += `M${x(run[0]).toFixed(1)},${base} L${pts} L${x(run[run.length - 1]).toFixed(1)},${base} Z `
    }
    run = []
  }
  values.forEach((v, i) => {
    if (v == null) flush()
    else run.push(i)
  })
  flush()
  return d
}

// --- crosshair
const hoverIdx = ref<number | null>(null)
function onMove(ev: PointerEvent) {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect()
  const px = ev.clientX - rect.left
  const n = props.labels.length
  if (n === 0) return
  const t = (px - PAD.left) / Math.max(1, plotW.value)
  hoverIdx.value = Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))
}
const fmt = (v: number) => (props.percent ? fmtPct(v, 1) : fmtCount(v))
const tooltipLeft = computed(() => {
  if (hoverIdx.value == null) return 0
  const cx = x(hoverIdx.value)
  return cx > width.value * 0.62 ? cx - 158 : cx + 10
})
</script>

<template>
  <div ref="el" class="ts-wrap">
    <svg
      :width="width"
      :height="height"
      role="img"
      @pointermove="onMove"
      @pointerleave="hoverIdx = null"
    >
      <!-- grid + y ticks -->
      <g v-for="t in ticks" :key="t">
        <line class="grid" :x1="PAD.left" :x2="width - PAD.right" :y1="y(t)" :y2="y(t)" />
        <text class="tick" :x="PAD.left - 6" :y="y(t) + 3" text-anchor="end">
          {{ percent ? fmtPct(t) : fmtCount(t) }}
        </text>
      </g>
      <!-- x labels: first / middle / last -->
      <template v-if="labels.length">
        <text
          v-for="i in [0, Math.floor((labels.length - 1) / 2), labels.length - 1].filter((v, ix, a) => a.indexOf(v) === ix)"
          :key="'x' + i"
          class="tick"
          :x="x(i)"
          :y="height - 8"
          :text-anchor="i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'"
        >
          {{ labels[i] }}
        </text>
      </template>

      <!-- area washes under lines -->
      <path
        v-for="s in shown.filter((s) => s.area)"
        :key="'a' + s.name"
        :d="areaFor(s.values)"
        :fill="s.color"
        opacity="0.1"
      />
      <!-- lines -->
      <path
        v-for="s in shown"
        :key="s.name"
        class="line"
        :d="pathFor(s.values)"
        :stroke="s.color"
        :stroke-width="s.width ?? 2"
        :stroke-dasharray="s.dash ? '7 5' : undefined"
        fill="none"
      />

      <!-- crosshair + markers -->
      <g v-if="hoverIdx != null">
        <line class="crosshair" :x1="x(hoverIdx)" :x2="x(hoverIdx)" :y1="PAD.top" :y2="PAD.top + plotH" />
        <template v-for="s in shown" :key="'m' + s.name">
          <circle
            v-if="s.values[hoverIdx] != null"
            :cx="x(hoverIdx)"
            :cy="y(s.values[hoverIdx]!)"
            r="4.5"
            :fill="s.color"
            class="marker"
          />
        </template>
      </g>
    </svg>

    <div v-if="hoverIdx != null" class="tooltip" :style="{ left: tooltipLeft + 'px' }">
      <div class="tt-label">{{ labels[hoverIdx] }}</div>
      <div v-for="s in shown" :key="s.name" class="tt-row">
        <span class="key" :style="{ background: s.color }" />
        <strong>{{ s.values[hoverIdx] != null ? fmt(s.values[hoverIdx]!) : '—' }}</strong>
        <span class="muted">{{ s.name }}</span>
      </div>
    </div>

    <div v-if="series.length > 1" class="legend">
      <button
        v-for="s in series"
        :key="s.name"
        type="button"
        class="legend-item"
        :class="{ off: hidden.has(s.name) }"
        :aria-pressed="!hidden.has(s.name)"
        @click="toggle(s.name)"
      >
        <span class="key" :style="{ background: s.color }" />{{ s.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ts-wrap {
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
.line {
  /* stroke-width comes from the per-series attribute — no class default,
   * or the CSS would override the thicker rolling-average strokes */
  stroke-linejoin: round;
  stroke-linecap: round;
}
.crosshair {
  stroke: var(--text-muted);
  stroke-width: 1;
}
.marker {
  stroke: var(--surface);
  stroke-width: 2;
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
  min-width: 130px;
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
  gap: 0.35rem 1rem;
  margin-top: 0.35rem;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  appearance: none;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 0.78rem;
  color: var(--text-muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.legend-item.off {
  opacity: 0.45;
  text-decoration: line-through;
}
</style>
