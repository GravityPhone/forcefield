<script setup lang="ts">
import { computed } from 'vue'
import { useTalkStore } from '@/stores/talk'
import { OUTCOME_HEX, OUTCOME_INK, OUTCOME_LABELS } from '@/lib/outcomes'
import type { KnockLog } from '@/types'

const talk = useTalkStore()

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
  return `${OUTCOME_LABELS[log.outcome]} · ${date}`
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
  color: var(--bubble-ink);
  opacity: 0.85;
}

.person.colored .badge {
  background: color-mix(in srgb, var(--bubble-ink) 22%, transparent);
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
</style>
