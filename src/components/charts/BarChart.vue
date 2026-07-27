<script setup lang="ts">
// Horizontal bars with optional confidence-interval whiskers. Value labels sit
// OUTSIDE the bar end (never clipped inside), the whole row is the hover
// target, and bars stay ≤18px thick with square baselines / rounded data-ends.
// With `selectable`, rows are tap targets (the Analytics drill-down); with
// `refValue`, a dashed marker shows the campaign-wide average for context.
//
// TOUCH (2026-07-26, reported from an Android phone: "I hold the button and
// it's making me copy some text instead of showing what's under my finger").
// Two separate causes, both fixed here and mirrored in every other chart:
//
//   1. A long press over SVG <text> is a TEXT SELECTION gesture — Chrome
//      raises its selection handles and the copy/share bar. `user-select` and
//      `-webkit-touch-callout` off the whole chart is the only thing that
//      stops it; nothing about the JS mattered.
//   2. Per-row `pointerenter`/`pointerleave` can't track a finger. Touch gets
//      an IMPLICIT pointer capture on whatever received `pointerdown`, so
//      moving to another row never fires that row's enter. The row is
//      resolved from the pointer's y against the SVG box instead, which works
//      for mouse and finger alike.
//
// The readout is STICKY after a finger lifts. There is no hover on a phone,
// so clearing on release would flash the answer and take it away again.
//
// TWO TAPS TO DRILL (2026-07-27, user call: "it's way too touchy and it's
// quick to link over. I have to double tap on another item in order to go over
// to it"). A single tap used to navigate, which meant a bar could not be READ
// without leaving the tab it was on — and reading is what the tooltip above
// exists for. So the first tap ARMS a row (lights it, pins its readout) and
// only a second tap on that same row emits `select`. Tapping a different row
// just moves the arming. There is deliberately no time window: the whole
// complaint was that the page acted too fast, and a 300ms double-tap would
// only move the trap rather than remove it. A quick double tap still works,
// because it is two taps on one row.
import { computed, ref, watch } from 'vue'
import { fmtCount, fmtPct } from '@/lib/chartTheme'
import { useChartWidth } from './useChartWidth'

export interface BarItem {
  label: string
  value: number
  /** confidence interval (same units as value) */
  lo?: number
  hi?: number
  color?: string
  /** Tooltip line 2: what the number is made of, e.g. "412 of 900 knocks". */
  detail?: string
  /** Tooltip line 3: the caveat, e.g. how sure a small sample lets us be. */
  note?: string
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
    /** What the bar length MEANS, named at the top of the tooltip so a finger
     * on a bar answers "information on what?" without leaving the chart. */
    measure?: string
    /** Long rankings show this many rows and hide the rest behind a "Show all
     * N" button (2026-07-27, user call: "some of these, like, just turf scraps
     * just go on so long"). 74 turfs is 2,200px of bars nobody scrolls past.
     * 0 disables the cap for a chart whose tail is the point. */
    cap?: number
  }>(),
  { percent: false, selectable: false, refLabel: 'average', cap: 12 },
)

const emit = defineEmits<{ (e: 'select', item: BarItem): void }>()

const { el, width } = useChartWidth()
const ROW_H = 30
const BAR_H = 16
const LABEL_W = 130
const VALUE_W = 52

// Taken over EVERY item, not just the shown ones, so expanding a capped list
// never rescales the bars already on screen.
const axisMax = computed(() => {
  // the reference marker must stay on-axis even when every bar sits below it
  if (props.max != null) return Math.max(props.max, props.refValue ?? 0) || 1
  let m = 0
  for (const it of props.items) m = Math.max(m, it.hi ?? it.value)
  return Math.max(m, props.refValue ?? 0) || 1
})

const expanded = ref(false)
const capped = computed(() => props.cap > 0 && props.items.length > props.cap)
const shown = computed(() =>
  capped.value && !expanded.value ? props.items.slice(0, props.cap) : props.items,
)

const plotW = computed(() => Math.max(40, width.value - LABEL_W - VALUE_W - 8))
const w = (v: number) => (Math.min(v, axisMax.value) / axisMax.value) * plotW.value
const height = computed(() => shown.value.length * ROW_H + 4 + (props.refValue != null ? 14 : 0))

const hover = ref<number | null>(null)
const held = ref(false)
/** Row waiting on its confirming tap. Indexes `shown`. */
const armed = ref<number | null>(null)
const fmt = (v: number) => (props.percent ? fmtPct(v, 1) : fmtCount(v))

// An index means nothing once the rows behind it change, so re-cutting the
// data (a day chip, a rate base, a new tab) or folding the list disarms.
watch([() => props.items, expanded], () => {
  armed.value = null
  hover.value = null
})

function onRowClick(i: number) {
  if (!props.selectable) return
  if (armed.value === i) {
    emit('select', shown.value[i])
    return
  }
  armed.value = i
  hover.value = i
}

function rowAt(ev: PointerEvent): number | null {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect()
  const i = Math.floor((ev.clientY - rect.top) / ROW_H)
  return i >= 0 && i < shown.value.length ? i : null
}
function onDown(ev: PointerEvent) {
  held.value = true
  hover.value = rowAt(ev)
}
function onMove(ev: PointerEvent) {
  // A mouse reads on hover; a finger only while it's down, or the synthetic
  // move a tap leaves behind would drag the readout to a row nobody touched.
  if (ev.pointerType === 'mouse' || held.value) hover.value = rowAt(ev)
}
function onLeave(ev: PointerEvent) {
  held.value = false
  if (ev.pointerType === 'mouse') hover.value = null
}

/** Tooltip sits just off the touched row, flipping above it in the bottom
 * half so it never runs off the card. */
const tipRow = computed(() => (hover.value ?? 0) * ROW_H)
const tipAbove = computed(() => hover.value != null && hover.value > shown.value.length / 2)
/** Only the armed row invites the second tap; a mouse hovering elsewhere
 * afterwards is reading, not aiming. */
const tipArmed = computed(() => props.selectable && hover.value != null && hover.value === armed.value)
</script>

<template>
  <div ref="el" class="bars">
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
      <!-- reference marker sits under the rows so it never steals their taps -->
      <g v-if="refValue != null" class="ref">
        <line
          :x1="LABEL_W + w(refValue)"
          :x2="LABEL_W + w(refValue)"
          :y1="0"
          :y2="shown.length * ROW_H"
        />
        <text class="ref-label" :x="LABEL_W + w(refValue)" :y="shown.length * ROW_H + 11" text-anchor="middle">
          {{ refLabel }}
        </text>
      </g>
      <g
        v-for="(it, i) in shown"
        :key="it.label"
        class="row"
        :class="{ sel: selectable }"
        :opacity="hover === null || hover === i ? 1 : 0.55"
        @click="onRowClick(i)"
      >
        <!-- full-row hit target: lit while it's being read, accented once it's
             armed and one tap from opening -->
        <rect
          :x="0"
          :y="i * ROW_H"
          :width="width"
          :height="ROW_H"
          rx="4"
          :class="{ lit: hover === i, armed: armed === i }"
          class="hit"
        />
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
    <!-- Names the measure first, so a finger on a bar answers "this is what
         you're looking at" before it answers "and here's the number". -->
    <div
      v-if="hover !== null"
      class="tip"
      :class="{ above: tipAbove }"
      :style="{ top: tipRow + 'px' }"
    >
      <div v-if="measure" class="tip-measure muted">{{ measure }}</div>
      <div class="tip-head">
        <span class="tip-name">{{ shown[hover].label }}</span>
        <strong class="tip-value">{{ fmt(shown[hover].value) }}</strong>
      </div>
      <div v-if="shown[hover].detail" class="tip-detail muted">{{ shown[hover].detail }}</div>
      <div v-if="shown[hover].note" class="tip-note muted">{{ shown[hover].note }}</div>
      <div v-if="tipArmed" class="tip-open">Tap again to open</div>
    </div>
    <!-- Kept in the layout while a readout is up, so the button below it can't
         hop under a thumb that's about to press it. -->
    <p class="tip-hint muted" :class="{ hidden: hover !== null }">
      Hold a bar for the numbers behind it
    </p>
    <button v-if="capped" type="button" class="more-btn" @click="expanded = !expanded">
      {{ expanded ? 'Show fewer' : `Show all ${fmtCount(items.length)}` }}
    </button>
  </div>
</template>

<style scoped>
.bars {
  min-width: 0;
  position: relative;
}
svg {
  display: block;
  max-width: 100%;
  /* A long press must read the bar out, not select the axis labels. */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  /* pan-y, not none: a bar chart can be taller than the screen, so a drag
     still has to scroll the page. Holding still is what reads a row. */
  touch-action: pan-y;
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
.hit {
  fill: transparent;
}
.hit.lit {
  fill: var(--surface-2);
}
.hit.armed {
  fill: color-mix(in srgb, var(--accent) 18%, var(--surface));
  stroke: var(--accent);
  stroke-width: 1.5;
}
.tip-hint {
  font-size: 0.74rem;
  margin: 0.25rem 0 0;
}
.tip-hint.hidden {
  visibility: hidden;
}
.more-btn {
  appearance: none;
  margin-top: 0.35rem;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.35rem 0.8rem;
  border-radius: 999px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.more-btn:hover {
  color: var(--text);
}
.tip {
  position: absolute;
  left: 0;
  right: 0;
  margin-top: calc(30px + 6px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 0.6);
  box-shadow: var(--shadow), 0 6px 20px rgba(0, 0, 0, 0.16);
  padding: 0.45rem 0.6rem;
  font-size: 0.8rem;
  pointer-events: none;
  z-index: 3;
}
.tip.above {
  margin-top: -6px;
  transform: translateY(-100%);
}
.tip-measure {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.tip-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}
.tip-name {
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tip-value {
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.tip-detail,
.tip-note {
  font-size: 0.75rem;
  line-height: 1.35;
}
.tip-open {
  margin-top: 0.2rem;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--accent);
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
