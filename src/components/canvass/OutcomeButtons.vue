<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MyDoorsSheet from './MyDoorsSheet.vue'
import { OUTCOMES } from '@/lib/outcomes'
import { popIn } from '@/lib/motion'
import { hapticNotify, hapticTap } from '@/lib/native'
import { useTalkStore } from '@/stores/talk'
import type { KnockOutcome } from '@/types'

const talk = useTalkStore()

// A physical tick under the finger confirms the tap registered without
// looking down at the screen — this pair of buttons is the highest-frequency
// interaction in the whole app.
function logOutcome(value: KnockOutcome) {
  hapticTap('medium')
  talk.logOutcome(value)
}

function confirmNext() {
  hapticNotify('success')
  void talk.confirmNext()
}

function confirmPrevious() {
  hapticNotify('success')
  void talk.confirmPrevious()
}

// Not Home / Skip / Hostile describe the door interaction, so they only need
// a household loaded. Signed / Didn't Sign / Maybe are a real answer from a
// real person — those stay disabled until someone's actually picked from
// the roster, even once an address is loaded.
// Whether to offer the "My turf" switch at all — it needs turf to filter to.
// (Labeled "My turf", not "My doors": it filters to the CREW's assignment,
// which is what myTurfIds means. "My doors" is Scout's narrower filter — the
// share with your name on it.)
// Loaded once here so the switch is on screen before the first Next.
onMounted(() => void talk.ensureMyTurf())
const haveMyTurf = computed(() => talk.myTurfIds.size > 0)

function toggleMyDoors() {
  hapticTap('light')
  talk.setMyDoorsOnly(!talk.myDoorsOnly)
}

// The door list lives in this row too since 2026-07-25 (user call) — it used
// to be a wide button up under the search. Same square as the turf switch
// beside it: the walk's two "which doors" controls sit together.
const myDoorsOpen = ref(false)

function openMyDoors() {
  hapticTap('light')
  myDoorsOpen.value = true
}

const hasHousehold = computed(() => talk.selectedAddress !== null)
const hasPerson = computed(() => talk.selectedPerson !== null)
function disabledFor(requiresPerson: boolean): boolean {
  return requiresPerson ? !hasPerson.value : !hasHousehold.value
}
</script>

<template>
  <div class="outcome-row">
    <div class="outcome-grid" data-help="talk-outcomes">
      <button
        v-for="o in OUTCOMES"
        :key="o.value"
        class="btn outcome-btn"
        :class="{ active: talk.pendingOutcome === o.value }"
        :style="{ '--outcome-color': o.hex }"
        :disabled="disabledFor(o.requiresPerson)"
        @click="logOutcome(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
    <!-- Back and Next ride here whenever a door is loaded — no outcome
         required (with one logged, moving on doubles as the confirm; nothing
         auto-advances). Next walks the street per the direction pref above;
         Back steps back through YOUR knock history (the doors you've logged,
         newest first) — retracing your day, not the street. The row itself is
         always on screen: with no door loaded, My doors is how you pick one. -->
    <div v-motion="popIn()" class="advance-row" data-help="talk-advance">
      <template v-if="talk.selectedAddress">
        <button class="btn prev-btn" title="Back through the doors you've knocked" @click="confirmPrevious">‹ Back</button>
        <button class="btn btn-primary next-btn" @click="confirmNext">Next ›</button>
      </template>
      <!-- The two squares travel as one block so a big text scale drops both
           to a second line together instead of orphaning one. -->
      <div class="sq-group">
        <!-- The walk's one filter, right where the walking happens: on, Next,
             Back and the Up-next chips only offer doors on turf that's yours
             today; off, they offer the whole street so you can wander a block
             nobody cut and knock whatever's closest. With no turf of your own
             today it stays on screen but disabled and says why — hiding it
             would read as the feature being missing. -->
        <button
          type="button"
          class="btn sq-btn mine-btn"
          :class="{ on: talk.myDoorsOnly && haveMyTurf }"
          role="switch"
          :aria-checked="talk.myDoorsOnly && haveMyTurf"
          :disabled="!haveMyTurf"
          :title="
            !haveMyTurf
              ? 'No turf is yours today — a manager sends turf out to each day’s crews'
              : talk.myDoorsOnly
                ? 'Only walking your crew’s turf — tap for every door'
                : 'Walking every door — tap to stick to your turf'
          "
          @click="toggleMyDoors"
        >
          <span class="mine-box" aria-hidden="true">{{ talk.myDoorsOnly && haveMyTurf ? '✓' : '' }}</span>
          <span class="sq-label">My turf</span>
        </button>
        <!-- The whole list of what the crew holds today, grouped by street —
             the other way of finding a door when you don't know its name. -->
        <button
          type="button"
          class="btn sq-btn"
          data-help="talk-mydoors"
          title="Every door your crew holds today, by street"
          @click="openMyDoors"
        >
          <span class="sq-icon" aria-hidden="true">🚪</span>
          <span class="sq-label">My doors</span>
        </button>
      </div>
    </div>
    <MyDoorsSheet v-model:open="myDoorsOpen" />
  </div>
</template>

<style scoped>
.outcome-row {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.outcome-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.6rem;
}

.outcome-btn {
  position: relative;
  min-height: 64px;
  font-size: 1.05rem;
  font-weight: 700;
  background: var(--surface);
  border: 2px solid var(--outcome-color);
  color: var(--outcome-color);
}

.outcome-btn:active {
  filter: brightness(0.95);
}

.outcome-btn.active {
  background: var(--outcome-color);
  color: var(--accent-contrast);
}

/* Next stays the single most-tapped button in the app — Back shares the
 * row but Next keeps the lion's share of the width, primary-filled, so the
 * default thumb target is still can't-miss walking between doors in the sun. */
.advance-row {
  display: flex;
  gap: 0.6rem;
  /* Four controls on a phone: at a big text scale the squares drop to a
   * second line rather than pushing the row past the screen edge. */
  flex-wrap: wrap;
}

/* Trimmed side padding — the two squares now share this row, and Next keeps
 * the width they'd otherwise take. */
.prev-btn {
  flex: 1;
  min-height: 64px;
  padding-inline: 0.6rem;
  font-size: 1rem;
  font-weight: 700;
}

.next-btn {
  flex: 1.7;
  min-height: 64px;
  padding-inline: 0.7rem;
  font-size: 1.15rem;
  font-weight: 700;
}

.sq-group {
  display: flex;
  gap: 0.6rem;
  flex: 0 0 auto;
}

/* The two squares riding beside Next — the walk's turf filter and the way
 * into the door list. Narrow on purpose: neither may steal thumb room from
 * Next, the most-tapped button in the app. */
.sq-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  flex: 0 0 auto;
  min-width: 62px;
  min-height: 64px;
  padding: 0.35rem 0.4rem;
  font-weight: 700;
  line-height: 1.1;
}

/* Sits in the same 20px slot the turf switch's checkbox occupies, so the two
 * squares line up glyph-to-glyph and label-to-label. */
.sq-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  font-size: 1.1rem;
}

.sq-label {
  font-size: 0.72rem;
  white-space: nowrap;
}

/* The turf square is the only one of the two that has an on state — it reads
 * as a checkbox, pressed = the accent, the way every other toggle in the app
 * reads as "on". The door list next to it just opens a sheet. */
.mine-btn.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  color: var(--accent);
}

.mine-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 2px solid currentColor;
  border-radius: 4px;
  font-size: 0.85rem;
  line-height: 1;
}

.mine-btn.on .mine-box {
  background: var(--accent);
  color: var(--accent-contrast);
}

.mine-btn:disabled {
  opacity: 0.45;
}
</style>
