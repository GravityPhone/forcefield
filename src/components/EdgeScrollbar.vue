<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/** A big, easy-to-grab scrollbar thumb pinned to the left edge of the
 * viewport, for any screen whose content runs taller than the screen. Lets
 * a canvasser drag straight to the top or bottom without hunting for a
 * strip of bare background to swipe — the same problem Hunt's results-list
 * thumb solves for its own scroll region (see HuntTab.vue), just applied to
 * whole-page scroll everywhere AppShell is used.
 *
 * Only the thumb itself is clickable (not a big invisible strip down the
 * left edge) — a full-height hit target would sit on top of left-aligned
 * nav links, buttons, and list rows on every screen. Keeping the hit area
 * to the thumb's own (generous) footprint avoids that while still giving a
 * large, easy target — and it's inset slightly from x=0 so it doesn't fight
 * Android Chrome's edge-swipe "back" gesture. */

const MIN_THUMB = 52
const TRACK_MARGIN = 10

const thumbHeight = ref(0)
const thumbTop = ref(0)
const showThumb = ref(false)
let resizeObserver: ResizeObserver | null = null

function trackHeight() {
  return window.innerHeight - TRACK_MARGIN * 2
}

function recompute() {
  const doc = document.documentElement
  const scrollHeight = doc.scrollHeight
  const clientHeight = window.innerHeight
  if (scrollHeight <= clientHeight + 1) {
    showThumb.value = false
    return
  }
  showThumb.value = true
  const track = trackHeight()
  const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * track)
  const maxTop = track - height
  const scrollableMax = scrollHeight - clientHeight
  const top = scrollableMax > 0 ? (window.scrollY / scrollableMax) * maxTop : 0
  thumbHeight.value = height
  thumbTop.value = top + TRACK_MARGIN
}

function onThumbPointerDown(event: PointerEvent) {
  event.preventDefault()
  const thumb = event.currentTarget as HTMLElement
  thumb.setPointerCapture(event.pointerId)
  const doc = document.documentElement
  const scrollableMax = doc.scrollHeight - window.innerHeight
  const track = trackHeight()
  const startY = event.clientY
  const startScrollTop = window.scrollY

  function onMove(e: PointerEvent) {
    const deltaY = e.clientY - startY
    const maxTop = track - thumbHeight.value
    const scrollDelta = maxTop > 0 ? (deltaY / maxTop) * scrollableMax : 0
    window.scrollTo({ top: Math.min(scrollableMax, Math.max(0, startScrollTop + scrollDelta)) })
  }
  function onUp() {
    thumb.removeEventListener('pointermove', onMove)
    thumb.removeEventListener('pointerup', onUp)
  }
  thumb.addEventListener('pointermove', onMove)
  thumb.addEventListener('pointerup', onUp)
}

onMounted(() => {
  window.addEventListener('scroll', recompute, { passive: true })
  window.addEventListener('resize', recompute)
  resizeObserver = new ResizeObserver(recompute)
  resizeObserver.observe(document.body)
  recompute()
})

onUnmounted(() => {
  window.removeEventListener('scroll', recompute)
  window.removeEventListener('resize', recompute)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div
    v-if="showThumb"
    class="edge-scrollbar-thumb"
    :style="{ height: thumbHeight + 'px', transform: `translateY(${thumbTop}px)` }"
    @pointerdown="onThumbPointerDown"
  ></div>
</template>

<style scoped>
/* Deliberately never themed — this floats over arbitrary content on every
 * screen, so a solid/accent color would clash somewhere. A neutral frosted
 * pane reads the same (and stays unobtrusive) over any background, light,
 * dark, or mid-scroll between the two. */
.edge-scrollbar-thumb {
  position: fixed;
  top: 0;
  left: 0.4rem;
  width: 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  /* A dark outer rim plus a light inner ring — the seam shows up against
   * light content (dark rim) and dark content (light ring) alike, instead
   * of just disappearing when the border color happens to match the page
   * behind it. */
  border: 1px solid rgba(0, 0, 0, 0.35);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  backdrop-filter: blur(6px) saturate(140%);
  -webkit-backdrop-filter: blur(6px) saturate(140%);
  opacity: 0.55;
  z-index: 60;
  touch-action: none;
  transition: opacity 0.1s ease;
}

.edge-scrollbar-thumb:hover,
.edge-scrollbar-thumb:active {
  opacity: 0.9;
}

/* Small up/down chevrons baked into the ends so the pill reads as "a scroll
 * handle" at a glance rather than a stray glass sliver. White-on-dark-shadow
 * so they hold up against light and dark content alike. */
.edge-scrollbar-thumb::before,
.edge-scrollbar-thumb::after {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 7px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
}

.edge-scrollbar-thumb::before {
  content: '▲';
  top: 3px;
}

.edge-scrollbar-thumb::after {
  content: '▼';
  bottom: 3px;
}
</style>
