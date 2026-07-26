<script setup lang="ts">
import { computed, ref } from 'vue'
import VoterSearchSheet from './VoterSearchSheet.vue'
import { useTalkStore } from '@/stores/talk'
import { OUTCOME_HEX, OUTCOME_INK, OUTCOME_SHORT } from '@/lib/outcomes'
import type { KnockLog } from '@/types'

const talk = useTalkStore()

// Whoever answered isn't always on this door's roster — a spouse, an adult
// kid, a new tenant. Searching the county roll is how their signature gets
// logged at all; before this it simply couldn't be.
const rollOpen = ref(false)

/** The picked person, when they came from the roll rather than this roster —
 *  they have no row above to highlight, so they get their own. */
const offRoll = computed(() => {
  const p = talk.selectedPerson
  if (!p) return null
  return talk.roster.some((r) => r.id === p.id) ? null : p
})

// Latest prior contact per person, shown inline on each roster row — and,
// via bubbleStyle, as the row's whole fill color. history is newest-first
// and optimistically updated the moment an outcome is logged, so bubbles
// recolor instantly (and un-color on undo).
const lastContactByPerson = computed(() => {
  const map = new Map<string, KnockLog>()
  for (const log of talk.history) {
    if (log.person_id && !map.has(log.person_id)) map.set(log.person_id, log)
  }
  return map
})

function contactSummary(personId: string): string | null {
  const log = lastContactByPerson.value.get(personId)
  if (!log) return null
  const date = new Date(log.occurred_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  return `${OUTCOME_SHORT[log.outcome]} · ${date}`
}

/** The person's latest outcome floods their whole bubble — outcome hex for
 * the fill (fixed literals, never theme tokens), matching ink for the text. */
function bubbleStyle(personId: string): Record<string, string> | undefined {
  const log = lastContactByPerson.value.get(personId)
  if (!log) return undefined
  return {
    '--bubble-bg': OUTCOME_HEX[log.outcome],
    '--bubble-ink': OUTCOME_INK[log.outcome],
  }
}
</script>

<template>
  <div class="roster">
    <div class="roster-label muted">
      At this address ({{ talk.roster.length }})
      <span v-if="talk.selectedPerson">— talking to {{ talk.selectedPerson.name }}</span>
    </div>
    <button
      v-for="p in talk.roster"
      :key="p.id"
      class="person"
      :class="{ selected: talk.selectedPerson?.id === p.id, colored: !!bubbleStyle(p.id) }"
      :style="bubbleStyle(p.id)"
      @click="talk.selectPerson(p)"
    >
      <span class="person-name">{{ p.name }}</span>
      <span class="person-meta">
        <span v-if="p.registered_voter" class="badge">Registered</span>
        <span v-if="contactSummary(p.id)" class="muted contact">{{ contactSummary(p.id) }}</span>
      </span>
    </button>
    <p v-if="!talk.roster.length" class="muted empty">No people on file at this address.</p>

    <!-- Picked from the county roll: no row above to highlight, so they get
         their own. When they're registered elsewhere the line says where the
         signature will land — the visit still records at this door. -->
    <div v-if="offRoll" class="off-roll" :class="{ away: !!talk.signerHome }">
      <span class="off-roll-name">{{ offRoll.name }}</span>
      <span v-if="talk.signerHome" class="off-roll-where">
        Signs for {{ talk.signerHome.label }}
      </span>
      <button class="off-roll-clear" type="button" aria-label="Clear" @click="talk.selectPerson(offRoll)">
        ✕
      </button>
    </div>

    <button class="roll-btn" type="button" data-help="talk-roll" @click="rollOpen = true">
      Someone else?
    </button>

    <VoterSearchSheet v-model:open="rollOpen" />
  </div>
</template>

<style scoped>
.roster {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.roster-label {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.person {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  min-height: 52px;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.person:hover {
  background: var(--surface-2);
}

.person.selected {
  border-color: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

/* A logged outcome floods the whole bubble with that outcome's fixed color
 * so the door's state reads at arm's length. Ink carries the matching
 * readable text color; muted bits just drop a little opacity instead of
 * using the theme's muted token (which may vanish on the fill). */
.person.colored,
.person.colored:hover {
  background: var(--bubble-bg);
  border-color: var(--bubble-bg);
  color: var(--bubble-ink);
}

.person.colored .muted {
  /* Full-opacity ink — the smaller size already de-emphasizes; fading it
   * would push borderline fills below readable contrast. */
  color: var(--bubble-ink);
}

.person.colored .badge {
  /* Outline instead of a tint pill: text stays ink-on-fill (max contrast)
   * and the border alone marks it as a badge. */
  background: transparent;
  border: 1.5px solid currentColor;
  color: var(--bubble-ink);
}

/* Selection ring needs to survive on top of any fill — draw it inset in
 * the bubble's own ink rather than the theme accent. */
.person.colored.selected {
  outline: 2px solid var(--bubble-ink);
  outline-offset: -4px;
}

.person-name {
  font-weight: 600;
}

.person-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.contact {
  font-size: 0.82rem;
  white-space: nowrap;
}

.empty {
  font-size: 0.9rem;
}

/* The roll pick, sitting under the roster it isn't part of. Amber when the
   signature is headed to another door — that's the one thing about this
   flow a canvasser has to be able to see before tapping Signed. */
.off-roll {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.15rem 0.5rem;
  padding: 0.5rem 0.7rem;
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}

.off-roll.away {
  border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, var(--surface));
}

.off-roll-name {
  font-weight: 700;
  flex: 1 1 auto;
  min-width: 0;
}

.off-roll-where {
  flex: 1 1 100%;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--warning);
}

.off-roll-clear {
  flex-shrink: 0;
  border: none;
  background: none;
  color: inherit;
  font-size: 1rem;
  line-height: 1;
  padding: 0.2rem 0.3rem;
  cursor: pointer;
}

.roll-btn {
  align-self: flex-start;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: none;
  color: var(--accent);
  font-size: 0.85rem;
  font-weight: 700;
  padding: 0.4rem 0.7rem;
  cursor: pointer;
}
</style>
