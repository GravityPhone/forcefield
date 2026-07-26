<script setup lang="ts">
/**
 * One solid square carrying a door's status color — the whole indicator,
 * replacing the 2×3 grid of six outcome cells that used to sit in Scout's
 * rows (2026-07-26, user call: "instead of having the grid of six outcomes…
 * let's just have a large square that shows the color").
 *
 * WHY THE GRID WENT: it answered "which of the six outcomes has ever happened
 * here", six 9px cells at a time, which is a question nobody asks at a door
 * and unreadable at arm's length in daylight. The square answers the question
 * the map already answers — what IS this door right now — in the same colors
 * the pin uses, at a size you can read while walking.
 *
 * Deliberately dumb: the caller resolves the color (doorPaint() for a door's
 * standing status, OUTCOME_HEX[outcome] for one logged knock), so the same
 * square serves Scout, /history, /member/:id, Talk's door history and the
 * Squad sheet without knowing where its data came from.
 */

defineProps<{
  /** Status fill. An OUTCOME_HEX, or PIN_DEFAULT_HEX for a door nobody has
   * reached yet — never a theme token: these colors have to match the map
   * pins whatever scheme the user picked. */
  fill: string
  /** Inset stripe for the partly-signed door: green square, yellow band —
   * the same two-color story the pins tell. Null for everything else. */
  band?: string | null
  /** Names the color for screen readers and a long-press tooltip. Without it
   * the square is decorative and hidden from the accessibility tree. */
  label?: string | null
}>()
</script>

<template>
  <span
    class="outcome-square"
    :style="{ '--sq-fill': fill }"
    :title="label ?? undefined"
    :role="label ? 'img' : undefined"
    :aria-label="label ?? undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <span v-if="band" class="sq-band" :style="{ background: band }"></span>
  </span>
</template>

<style scoped>
.outcome-square {
  flex: 0 0 auto;
  display: block;
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--sq-fill);
  /* A hairline of the row's own surface, so a red square against a red-washed
   * row still reads as a distinct object rather than a smear. */
  box-shadow: 0 0 0 1.5px var(--surface), 0 0 0 2.5px color-mix(in srgb, var(--sq-fill) 55%, transparent);
  overflow: hidden;
}

/* Matches the pins: the band is INSIDE the fill, not a border around it, so
 * "some of them signed" reads as progress within the door. */
.sq-band {
  position: absolute;
  inset: 30% 0;
  display: block;
}
</style>
