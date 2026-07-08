<script setup lang="ts">
import { computed } from 'vue'
import { paletteColor, type InfographicSpec } from '@/lib/infographic'

const props = defineProps<{ spec: InfographicSpec }>()

// A one-point "trend" can't draw a line — show it as a stat card instead.
const effectiveType = computed(() =>
  props.spec.type === 'line' && props.spec.data.length < 2 ? 'stat' : props.spec.type,
)

const colored = computed(() =>
  props.spec.data.map((d, i) => ({ ...d, color: d.color ?? paletteColor(i) })),
)

function fmt(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// --- bar ---
const barMax = computed(() => Math.max(...props.spec.data.map((d) => d.value), 1))
function barWidth(value: number): number {
  return Math.max(0, Math.min(100, (value / barMax.value) * 100))
}

// --- pie ---
const pieData = computed(() => {
  const positives = colored.value.filter((d) => d.value > 0)
  const total = positives.reduce((sum, d) => sum + d.value, 0)
  return positives.map((d) => ({ ...d, pct: total > 0 ? (d.value / total) * 100 : 0 }))
})
const pieGradient = computed(() => {
  let acc = 0
  const stops = pieData.value.map((d) => {
    const from = acc
    acc += d.pct
    return `${d.color} ${from}% ${acc}%`
  })
  return `conic-gradient(${stops.join(', ')})`
})

// --- line ---
const lineMin = computed(() => Math.min(...props.spec.data.map((d) => d.value)))
const lineMax = computed(() => Math.max(...props.spec.data.map((d) => d.value)))
const linePoints = computed(() => {
  const { data } = props.spec
  const span = lineMax.value - lineMin.value || 1
  return data
    .map((d, i) => {
      const x = 2 + (i / (data.length - 1)) * 96
      const y = 37 - ((d.value - lineMin.value) / span) * 34
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
})
const lineAreaPoints = computed(() => `${linePoints.value} 98,40 2,40`)
const lineColor = computed(() => props.spec.data[0]?.color ?? 'var(--accent)')
</script>

<template>
  <div class="ig">
    <div v-if="spec.title" class="ig-title">{{ spec.title }}</div>

    <div v-if="effectiveType === 'stat'" class="ig-stats">
      <div v-for="(d, i) in colored" :key="i" class="ig-stat">
        <div class="ig-stat-value" :style="{ color: d.color }">{{ fmt(d.value) }}</div>
        <div class="ig-stat-label">{{ d.label }}</div>
      </div>
    </div>

    <div v-else-if="effectiveType === 'bar'" class="ig-bars">
      <div v-for="(d, i) in colored" :key="i" class="ig-bar-row">
        <div class="ig-bar-label" :title="d.label">{{ d.label }}</div>
        <div class="ig-bar-track">
          <div class="ig-bar-fill" :style="{ width: `${barWidth(d.value)}%`, background: d.color }" />
        </div>
        <div class="ig-bar-value">{{ fmt(d.value) }}</div>
      </div>
    </div>

    <div v-else-if="effectiveType === 'pie'" class="ig-pie-wrap">
      <div class="ig-pie" :style="{ background: pieGradient }" />
      <ul class="ig-legend">
        <li v-for="(d, i) in pieData" :key="i">
          <span class="ig-dot" :style="{ background: d.color }" />
          <span class="ig-legend-label">{{ d.label }}</span>
          <span class="ig-legend-value">{{ fmt(d.value) }} · {{ d.pct.toFixed(1) }}%</span>
        </li>
      </ul>
    </div>

    <div v-else class="ig-line">
      <span class="ig-y ig-y-max">{{ fmt(lineMax) }}</span>
      <span class="ig-y ig-y-min">{{ fmt(lineMin) }}</span>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <polygon :points="lineAreaPoints" :fill="lineColor" opacity="0.12" />
        <polyline
          :points="linePoints"
          fill="none"
          :stroke="lineColor"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <div class="ig-line-x">
        <span>{{ spec.data[0]?.label }}</span>
        <span>{{ spec.data[spec.data.length - 1]?.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ig {
  width: 100%;
  margin: 0.5rem 0;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}

.ig-title {
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.55rem;
  opacity: 0.85;
}

/* stat */
.ig-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem 1.2rem;
}

.ig-stat-value {
  font-size: 1.45rem;
  font-weight: 700;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.ig-stat-label {
  font-size: 0.72rem;
  opacity: 0.65;
}

/* bar */
.ig-bars {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.ig-bar-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.78rem;
}

.ig-bar-label {
  flex: 0 0 5.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.ig-bar-track {
  flex: 1;
  height: 0.85rem;
  border-radius: 5px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  overflow: hidden;
}

.ig-bar-fill {
  height: 100%;
  border-radius: 5px;
  min-width: 2px;
}

.ig-bar-value {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

/* pie */
.ig-pie-wrap {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}

.ig-pie {
  flex: 0 0 auto;
  width: 92px;
  height: 92px;
  border-radius: 50%;
}

.ig-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.76rem;
  min-width: 0;
}

.ig-legend li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.ig-dot {
  flex: 0 0 auto;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
}

.ig-legend-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}

.ig-legend-value {
  flex: 0 0 auto;
  margin-left: auto;
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
}

/* line */
.ig-line {
  position: relative;
}

.ig-line svg {
  display: block;
  width: 100%;
  height: 110px;
}

.ig-y {
  position: absolute;
  left: 0.15rem;
  font-size: 0.66rem;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.ig-y-max {
  top: 0;
}

.ig-y-min {
  bottom: 1.35rem;
}

.ig-line-x {
  display: flex;
  justify-content: space-between;
  font-size: 0.7rem;
  opacity: 0.65;
  margin-top: 0.25rem;
  gap: 1rem;
}

.ig-line-x span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
