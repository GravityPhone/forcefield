<script setup lang="ts">
import CanvassSearch from './CanvassSearch.vue'
import RosterList from './RosterList.vue'
import OutcomeButtons from './OutcomeButtons.vue'
import { computed } from 'vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { OUTCOME_HEX, OUTCOME_INK, OUTCOME_LABELS, OUTCOME_REQUIRES_PERSON } from '@/lib/outcomes'
import { useTalkStore, type KnockHistoryEntry } from '@/stores/talk'

const talk = useTalkStore()

// Household-level outcomes (Not Home / Skip / Hostile) belong to the door,
// not a person, so they flood the address banner up top — but only while
// they're the door's LATEST word. Once someone answers and gets a personal
// outcome, their roster bubble carries the signal and the banner clears.
// history[0] is newest-first and optimistically updated, so this recolors
// the moment an outcome is logged (and reverts on undo).
const householdOutcome = computed(() => {
  const latest = talk.history[0]
  if (!latest || OUTCOME_REQUIRES_PERSON[latest.outcome]) return null
  return latest.outcome
})

// --- Door history display helpers ---

function historyWho(h: KnockHistoryEntry): string {
  return h.canvasser ? h.canvasser.display_name || h.canvasser.username : 'unknown'
}

/** "Sat, Jul 5 · 3:12 PM" — day AND time for every visit, with the year
 * spelled out once it isn't this year's. */
function historyWhen(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const day = d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${day} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

// Walk-order options — govern which house the Next button below advances to.
const DIRECTION_OPTIONS = [
  { value: 'ascending', label: 'Ascending' },
  { value: 'descending', label: 'Descending' },
]
const PARITY_OPTIONS = [
  { value: 'both', label: 'Both sides' },
  { value: 'even', label: 'Evens only' },
  { value: 'odd', label: 'Odds only' },
]
const PARTLY_SIGNED_OPTIONS = [
  { value: 'knock', label: 'Knock partly-signed' },
  { value: 'skip', label: 'Skip partly-signed' },
]
</script>

<template>
  <div class="talk">
    <!-- Always-live search: attaches a person/address to the outcome about to
         be logged. Switching people/addresses happens here, inline — this
         screen never navigates away mid-conversation. -->
    <CanvassSearch />

    <div
      v-if="talk.selectedAddress"
      class="card address-card"
      :style="householdOutcome ? { borderColor: OUTCOME_HEX[householdOutcome] } : undefined"
    >
      <div
        class="address-head"
        :class="{ tinted: householdOutcome }"
        :style="householdOutcome ? { background: OUTCOME_HEX[householdOutcome], color: OUTCOME_INK[householdOutcome] } : undefined"
      >
        <div>
          <div class="address-line">
            {{ talk.selectedAddress.street
            }}{{ talk.selectedAddress.unit ? ' ' + talk.selectedAddress.unit : '' }}
          </div>
          <div class="muted address-city">{{ talk.selectedAddress.city }}</div>
          <span v-if="householdOutcome" class="address-outcome">
            {{ OUTCOME_LABELS[householdOutcome] }}
          </span>
        </div>
        <button class="btn btn-sm" @click="talk.clearAddress()">Clear</button>
      </div>
      <RosterList />

      <!-- Everything that's ever happened at this door, newest first. -->
      <div v-if="talk.history.length" class="history">
        <h4 class="history-title">
          Door history
          <span class="muted history-count">{{ talk.history.length }} visit{{ talk.history.length === 1 ? '' : 's' }}</span>
        </h4>
        <ul class="history-list">
          <li v-for="h in talk.history" :key="h.client_id" class="history-row">
            <span class="history-dot" :style="{ background: OUTCOME_HEX[h.outcome] }" aria-hidden="true"></span>
            <span class="history-main">
              <span class="history-what">
                <strong>{{ OUTCOME_LABELS[h.outcome] }}</strong>
                <template v-if="h.person?.name"> — {{ h.person.name }}</template>
              </span>
              <span class="muted history-meta">{{ historyWho(h) }} · {{ historyWhen(h.occurred_at) }}</span>
              <span v-if="h.notes" class="muted history-notes">“{{ h.notes }}”</span>
            </span>
          </li>
        </ul>
      </div>
      <p v-else class="muted history-none">No visits logged at this door yet.</p>
    </div>
    <p v-else class="muted walkup-hint">
      Load an address (search above, or via Scout) to log an outcome.
    </p>

    <label class="notes-label" for="talk-notes">Notes</label>
    <textarea
      id="talk-notes"
      v-model="talk.notes"
      class="notes"
      rows="2"
      placeholder="Optional notes…"
    ></textarea>

    <!-- Governs the "Next" button's auto-advance — which way to walk a
         street once you start logging outcomes. -->
    <div class="walk-order">
      <span class="muted walk-label">Next house:</span>
      <AppSelect
        class="walk-select"
        :model-value="talk.walkDirection"
        :options="DIRECTION_OPTIONS"
        aria-label="Walk direction"
        @update:model-value="talk.setWalkDirection($event as 'ascending' | 'descending')"
      />
      <AppSelect
        class="walk-select"
        :model-value="talk.walkParity"
        :options="PARITY_OPTIONS"
        aria-label="Walk side of street"
        @update:model-value="talk.setWalkParity($event as 'both' | 'even' | 'odd')"
      />
      <AppSelect
        class="walk-select"
        :model-value="talk.knockPartlySigned ? 'knock' : 'skip'"
        :options="PARTLY_SIGNED_OPTIONS"
        aria-label="Doors where someone already signed but others have not"
        @update:model-value="talk.setKnockPartlySigned($event === 'knock')"
      />
    </div>

    <OutcomeButtons />
  </div>
</template>

<style scoped>
.talk {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.address-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  /* --card-pad (overridden by compact mode in style.css) keeps the tinted
   * banner's negative margins in lockstep with the real padding. */
  --card-pad: 1rem;
  padding: var(--card-pad);
}

.address-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

/* A household-level outcome (Not Home / Skip / Hostile) floods the address
 * strip edge-to-edge in that outcome's fixed color — bleed through the
 * card's 1rem padding so it reads as a banner, not a highlight. */
.address-head.tinted {
  margin: calc(-1 * var(--card-pad)) calc(-1 * var(--card-pad)) 0;
  padding: 0.85rem var(--card-pad);
  border-radius: calc(var(--radius) - 1px) calc(var(--radius) - 1px) 0 0;
}

.address-head.tinted .address-city {
  color: inherit;
  opacity: 0.85;
}

.address-head.tinted .btn {
  border-color: color-mix(in srgb, currentColor 55%, transparent);
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
}

.address-outcome {
  display: inline-block;
  margin-top: 0.35rem;
  padding: 0.1rem 0.55rem;
  border: 1.5px solid currentColor;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.address-line {
  font-weight: 700;
  font-size: 1.05rem;
}

.address-city {
  font-size: 0.88rem;
}

.walkup-hint {
  margin: 0;
  font-size: 0.88rem;
}

/* --- Door history --- */

.history {
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
}

.history-title {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.history-count {
  font-weight: 500;
  font-size: 0.8rem;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  /* Long histories scroll inside the card instead of stretching the page. */
  max-height: 14rem;
  overflow-y: auto;
}

.history-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.history-dot {
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  margin-top: 0.25rem;
  border: 1.5px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
}

.history-main {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.history-what {
  font-size: 0.9rem;
}

.history-meta {
  font-size: 0.8rem;
}

.history-notes {
  font-size: 0.82rem;
  font-style: italic;
  overflow-wrap: anywhere;
}

.history-none {
  margin: 0;
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
  font-size: 0.85rem;
}

.notes-label {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: -0.55rem;
}

.notes {
  width: 100%;
  padding: 0.6rem 0.8rem;
  font: inherit;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  resize: vertical;
}

.notes:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.walk-order {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.walk-label {
  font-size: 0.85rem;
  flex-shrink: 0;
}

/* AppSelect triggers share the row; the class lands on the trigger button
 * (attrs fall through) but parent-scoped rules don't, hence :deep. */
.walk-order :deep(.walk-select) {
  flex: 1;
  min-width: 0;
  width: auto;
  font-size: 0.92rem;
}
</style>
