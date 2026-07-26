<script setup lang="ts">
/**
 * The "?" walkthrough. Every screen's help is a short deck of steps, and each
 * step can point at the actual control it's describing: the page dims, the
 * thing gets a ring around it, and a card explains it with Next / Back.
 *
 * Steps name their target with a `target` key in helpContent.ts, matched
 * against a `data-help="<key>"` attribute in the view. Nothing breaks when the
 * element isn't there (wrong tab, role without that button, screen still
 * loading) — the step just shows as a plain centered card, so the copy is
 * never lost. Grep `data-help=` to find every anchor.
 *
 * Semi-interactive on purpose: the dim is four rectangles AROUND the target,
 * not a sheet over it, so the highlighted control can still be tapped while
 * the tour is open — and the ring follows it (it re-measures every frame,
 * which also keeps it glued through scrolling, map moves, and layout shifts).
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { HelpSwatch, HelpTopic } from '@/lib/helpContent'
import { hapticTap } from '@/lib/native'

/** One dot of a color key: the fill, an optional inner band (partly-signed
 * green-with-yellow), an optional outer halo (knocked today). Same three
 * bands the canvas renderer paints, so the key and the map agree by
 * construction. */
function swatchStyle(sw: HelpSwatch) {
  const shadows = [
    sw.band ? `inset 0 0 0 3px ${sw.band}` : '',
    sw.halo ? `0 0 0 2.5px ${sw.halo}` : '',
  ].filter(Boolean)
  return {
    background: sw.fill,
    boxShadow: shadows.length ? shadows.join(', ') : undefined,
  }
}

const props = defineProps<{ topic: HelpTopic | null }>()
const open = defineModel<boolean>('open', { required: true })

const index = ref(0)
const steps = computed(() => props.topic?.sections ?? [])
const step = computed(() => steps.value[index.value] ?? null)
const total = computed(() => steps.value.length)
const isLast = computed(() => index.value >= total.value - 1)

interface Box {
  top: number
  left: number
  width: number
  height: number
}

const spot = ref<Box | null>(null)
const viewport = ref({ w: 0, h: 0 })
let rafId = 0

/** Padding around the target so the ring never crops what it's ringing. */
const PAD = 8

function targetEl(): HTMLElement | null {
  const key = step.value?.target
  if (!key) return null
  const els = Array.from(document.querySelectorAll<HTMLElement>(`[data-help="${key}"]`))
  // The first one that's actually rendered: v-show'd tabs and role-gated
  // controls leave zero-sized elements behind.
  return (
    els.find((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }) ?? null
  )
}

function measure() {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  const el = targetEl()
  if (!el) {
    spot.value = null
    return
  }
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight
  // Off-screen (the page scrolled past it) counts as nothing to point at —
  // better a plain card than a ring hugging the edge of nowhere.
  if (r.bottom < 0 || r.top > vh) {
    spot.value = null
    return
  }
  spot.value = {
    top: Math.max(0, r.top - PAD),
    left: Math.max(0, r.left - PAD),
    width: Math.min(window.innerWidth, r.width + PAD * 2),
    height: r.height + PAD * 2,
  }
}

function track() {
  measure()
  rafId = requestAnimationFrame(track)
}

function startTracking() {
  if (!rafId) rafId = requestAnimationFrame(track)
}

function stopTracking() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

/** Bring the step's target into view, but only when it isn't already there. */
async function focusStep() {
  await nextTick()
  const el = targetEl()
  if (el) {
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    if (r.top < 80 || r.bottom > vh - 200) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }
  measure()
}

/** The card sits opposite the highlight so it can never cover it. */
const cardAtTop = computed(() => {
  const s = spot.value
  if (!s || !viewport.value.h) return false
  return s.top + s.height / 2 > viewport.value.h * 0.55
})

/** Four dim panels around the hole — the target itself stays live. */
const masks = computed<Box[]>(() => {
  const { w, h } = viewport.value
  const s = spot.value
  if (!s || !w || !h) return [{ top: 0, left: 0, width: w || 0, height: h || 0 }]
  const bottomY = s.top + s.height
  const rightX = s.left + s.width
  return [
    { top: 0, left: 0, width: w, height: Math.max(0, s.top) },
    { top: bottomY, left: 0, width: w, height: Math.max(0, h - bottomY) },
    { top: s.top, left: 0, width: Math.max(0, s.left), height: s.height },
    { top: s.top, left: rightX, width: Math.max(0, w - rightX), height: s.height },
  ]
})

function boxStyle(b: Box) {
  return {
    top: `${b.top}px`,
    left: `${b.left}px`,
    width: `${b.width}px`,
    height: `${b.height}px`,
  }
}

function next() {
  if (isLast.value) {
    close()
    return
  }
  index.value += 1
  hapticTap('light')
}

function back() {
  if (index.value === 0) return
  index.value -= 1
  hapticTap('light')
}

function close() {
  open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    back()
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    index.value = 0
    // Measure before the first paint so the dim never flashes full-screen on
    // a step that has a target.
    measure()
    startTracking()
    void focusStep()
    window.addEventListener('keydown', onKeydown)
  } else {
    stopTracking()
    spot.value = null
    window.removeEventListener('keydown', onKeydown)
  }
})

watch(index, () => {
  if (open.value) void focusStep()
})

// The screen changed under the tour — a tab flip on Analytics, or a tap on a
// highlighted link, since targets stay live. Start the new screen's deck from
// the top; if the new screen has no help at all, the tour is over.
watch(
  () => props.topic,
  (topic) => {
    if (!open.value) return
    if (!topic) {
      close()
      return
    }
    index.value = 0
    void focusStep()
  },
)

onBeforeUnmount(() => {
  stopTracking()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open && topic && step" class="tour" role="dialog" aria-modal="true" :aria-label="topic.title">
      <div
        v-for="(m, i) in masks"
        :key="i"
        class="tour-mask"
        :style="boxStyle(m)"
        @click="next"
      ></div>
      <div v-if="spot" class="tour-ring" :style="boxStyle(spot)" aria-hidden="true"></div>

      <div class="tour-card" :class="{ 'tour-card-top': cardAtTop }">
        <div class="tour-head">
          <span class="tour-kicker">{{ topic.title }} · {{ index + 1 }} of {{ total }}</span>
          <button class="tour-close" aria-label="Close the walkthrough" @click="close">✕</button>
        </div>
        <h3 v-if="step.heading" class="tour-title">{{ step.heading }}</h3>
        <p class="tour-body">{{ step.body }}</p>
        <!-- Color mappings are shown, not described (2026-07-25): a labelled
             dot painted with the map's own literal hexes can't drift out of
             sync with the pins the way a sentence about "yellow" did. -->
        <ul v-if="step.swatches" class="tour-key">
          <li v-for="sw in step.swatches" :key="sw.label" class="tour-key-row">
            <span class="tour-swatch" :style="swatchStyle(sw)" aria-hidden="true"></span>
            {{ sw.label }}
          </li>
        </ul>
        <div class="tour-dots" aria-hidden="true">
          <span v-for="n in total" :key="n" class="tour-dot" :class="{ on: n - 1 === index }"></span>
        </div>
        <div class="tour-actions">
          <button v-if="index > 0" class="btn btn-ghost btn-sm" @click="back">‹ Back</button>
          <button v-else class="btn btn-ghost btn-sm" @click="close">Skip</button>
          <button class="btn btn-primary btn-sm tour-next" @click="next">
            {{ isLast ? 'Done' : 'Next ›' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 70;
  pointer-events: none;
}

/* No transitions on the geometry: these boxes are re-measured every frame, so
   a transition would spend its life chasing a value that already moved and the
   ring would lag behind the thing it's ringing during a scroll. */
.tour-mask {
  position: fixed;
  background: rgba(6, 10, 20, 0.6);
  pointer-events: auto;
  cursor: pointer;
}

.tour-ring {
  position: fixed;
  border: 2px solid var(--accent);
  border-radius: 10px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent);
  pointer-events: none;
  animation: tour-pulse 1.8s ease-in-out infinite;
}

@keyframes tour-pulse {
  50% {
    box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 18%, transparent);
  }
}

.tour-card {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(0.85rem + env(safe-area-inset-bottom, 0px));
  width: min(420px, calc(var(--frame-w) - 1.5rem));
  max-height: 48dvh;
  overflow-y: auto;
  z-index: 71;
  pointer-events: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: min(calc(var(--radius) * 1.4), 16px);
  padding: 0.7rem 0.9rem 0.85rem;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.35);
}

.tour-card-top {
  bottom: auto;
  top: calc(0.85rem + env(safe-area-inset-top, 0px));
}

.tour-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.tour-kicker {
  flex: 1;
  min-width: 0;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.tour-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
}

.tour-title {
  margin: 0.35rem 0 0.2rem;
  font-size: 1rem;
  font-weight: 800;
}

/* pre-line so a step can be a short list — the copy is written as manual
   lines, not paragraphs (2026-07-25). */
.tour-body {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.5;
  color: var(--text-muted);
  white-space: pre-line;
}

.tour-key {
  list-style: none;
  margin: 0.55rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.tour-key-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  color: var(--text);
}

.tour-swatch {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border-radius: 50%;
}

.tour-dots {
  display: flex;
  flex-wrap: wrap;
  gap: 0.28rem;
  margin: 0.7rem 0 0.55rem;
}

.tour-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
}

.tour-dot.on {
  background: var(--accent);
  transform: scale(1.25);
}

.tour-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.tour-next {
  margin-left: auto;
  min-width: 6rem;
}
</style>
