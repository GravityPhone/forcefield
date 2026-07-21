<script setup lang="ts">
import CanvassSearch from './CanvassSearch.vue'
import RosterList from './RosterList.vue'
import OutcomeButtons from './OutcomeButtons.vue'
import { computed } from 'vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { hapticTap } from '@/lib/native'
import { OUTCOME_HEX, OUTCOME_INK, OUTCOME_LABELS, OUTCOME_REQUIRES_PERSON, PIN_DEFAULT_HEX } from '@/lib/outcomes'
import { houseNumber } from '@/lib/streetWalk'
import { useTalkStore, type KnockHistoryEntry } from '@/stores/talk'
import type { Address, KnockOutcome } from '@/types'

const talk = useTalkStore()

// --- Walk navigation: the Up-next chips + Back ---

/** House number alone — the chips all sit on the current door's street. A
 * numberless address (rare) falls back to its full line. */
function chipLabel(a: Address): string {
  const n = houseNumber(a.street)
  return n > 0 ? String(n) : a.street
}

function jumpChip(addressId: string) {
  hapticTap('light')
  void talk.jumpTo(addressId)
}

function stepBack() {
  hapticTap('light')
  void talk.confirmPrevious()
}

// Address-banner status — the same rules as the map pins (doorStatusOutcome
// in lib/outcomes.ts), with labels: green "Everyone signed" once the whole
// roster has signed, red while a door-level Skip/Hostile is the latest word
// (that's how a partly-signed door gets retired), yellow "1/3 signed" while
// somebody-but-not-everybody signed, and otherwise a household-level latest
// outcome (Not Home / Skip / Hostile) floods as before — person-level
// outcomes stay on their roster bubbles. history is newest-first and
// optimistically updated, so this recolors the moment an outcome is logged
// (and reverts on undo).
const banner = computed<{ outcome: KnockOutcome; label: string } | null>(() => {
  const signedIds = new Set(
    talk.history.filter((h) => h.outcome === 'signed' && h.person_id).map((h) => h.person_id),
  )
  const total = talk.roster.length
  if (total > 0 && signedIds.size >= total) return { outcome: 'signed', label: 'Everyone signed' }
  const latest = talk.history[0]
  const householdLatest = latest && !OUTCOME_REQUIRES_PERSON[latest.outcome] ? latest.outcome : null
  if (householdLatest === 'skip' || householdLatest === 'hostile') {
    return { outcome: householdLatest, label: OUTCOME_LABELS[householdLatest] }
  }
  if (signedIds.size > 0) return { outcome: 'maybe', label: `${signedIds.size}/${total} signed` }
  if (householdLatest) return { outcome: householdLatest, label: OUTCOME_LABELS[householdLatest] }
  return null
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
      :style="banner ? { borderColor: OUTCOME_HEX[banner.outcome] } : undefined"
    >
      <div
        class="address-head"
        :class="{ tinted: banner }"
        :style="banner ? { background: OUTCOME_HEX[banner.outcome], color: OUTCOME_INK[banner.outcome] } : undefined"
      >
        <div>
          <div class="address-line">
            {{ talk.selectedAddress.street
            }}{{ talk.selectedAddress.unit ? ' ' + talk.selectedAddress.unit : '' }}
          </div>
          <div class="muted address-city">{{ talk.selectedAddress.city }}</div>
          <span v-if="banner" class="address-outcome">
            {{ banner.label }}
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

    <!-- Walk navigation without logging: Back retraces your own knock
         history one door at a time (same as the Previous button below);
         the Up-next chips are the next houses the pattern above will visit
         — tap one to jump straight to it. Dot = that door's status color
         (blue = never knocked). -->
    <div v-if="talk.selectedAddress" class="up-next">
      <button class="up-chip back-chip" title="Back through the doors you've knocked" @click="stepBack">
        ‹ Back
      </button>
      <span class="muted up-label">Up next:</span>
      <span v-if="talk.upcoming === null" class="muted up-none">…</span>
      <template v-else-if="talk.upcoming.length">
        <button
          v-for="u in talk.upcoming"
          :key="u.address.id"
          class="up-chip"
          :title="u.address.street"
          @click="jumpChip(u.address.id)"
        >
          <span
            class="up-dot"
            :style="{ background: u.status ? OUTCOME_HEX[u.status] : PIN_DEFAULT_HEX }"
            aria-hidden="true"
          ></span>
          {{ chipLabel(u.address) }}
        </button>
      </template>
      <span v-else class="muted up-none">end of the street</span>
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

/* --- Up next / Back chips --- */

.up-next {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  /* Reads as one block with the walk-order row above it. */
  margin-top: -0.35rem;
}

.up-label {
  font-size: 0.85rem;
  flex-shrink: 0;
}

.up-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  flex: 1;
  min-height: 42px;
  padding: 0.3rem 0.7rem;
  font: inherit;
  font-size: 0.98rem;
  font-weight: 700;
  border: 1.5px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.up-chip:active {
  filter: brightness(0.95);
}

.back-chip {
  flex: 0 0 auto;
}

.up-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.up-none {
  font-size: 0.85rem;
}
</style>
