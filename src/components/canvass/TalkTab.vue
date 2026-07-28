<script setup lang="ts">
import CanvassSearch from './CanvassSearch.vue'
import RosterList from './RosterList.vue'
import OutcomeButtons from './OutcomeButtons.vue'
import { computed } from 'vue'
import { hapticTap } from '@/lib/native'
import { OUTCOME_DOOR_LEVEL, OUTCOME_HEX, OUTCOME_INK, OUTCOME_LABELS, OUTCOME_SHORT, PIN_DEFAULT_HEX, outcomeRowTint } from '@/lib/outcomes'
import OutcomeSquare from './OutcomeSquare.vue'
import DoorOddsPanel from '@/components/odds/DoorOddsPanel.vue'
import { appointmentLabel } from '@/lib/appointments'
import { houseNumber, streetNameOf, titleCase } from '@/lib/streetWalk'
import { useTalkStore, type KnockHistoryEntry } from '@/stores/talk'
import type { Address, KnockOutcome } from '@/types'

const talk = useTalkStore()

// --- Walk navigation: the Up-next grid ---

/** House number alone — the chips all sit on the current door's street. A
 * numberless address (rare) falls back to its full line. */
function chipLabel(a: Address): string {
  const n = houseNumber(a.street)
  return n > 0 ? String(n) : a.street
}

function jumpChip(addressId: string) {
  hapticTap('light')
  void talk.jumpTo(addressId)
  // Same landing as Next: a new door starts at the top of the screen.
  window.scrollTo({ top: 0 })
}

/** The street the chips sit on (findUpcomingOnStreet never leaves the current
 * door's street), so the label can already say whose numbers are coming while
 * the spots below are still loading. */
const upStreet = computed(() => {
  const a = talk.selectedAddress
  return a ? titleCase(streetNameOf(a.street)) : ''
})

// Address-banner status — the same rules as the map pins (doorStatusOutcome
// in lib/outcomes.ts), with labels: green "Everyone signed" once the whole
// roster has signed, red while a door-level Skip/Hostile is the latest word
// (that's how a partly-signed door gets retired), yellow "1/3 signed" while
// somebody-but-not-everybody signed, and otherwise the latest HOUSEHOLD-level
// outcome floods — person-level outcomes stay on their roster bubbles.
// "Household-level" is two cases since 2026-07-25, when Not Interested and
// Maybe stopped requiring a person: an outcome that's inherently about the
// door (Not Home / Skip / Hostile, true even if a person was selected), or
// any knock logged with nobody picked — the answer of whoever opened the
// door. history is newest-first and optimistically updated, so this recolors
// the moment an outcome is logged (and reverts on undo).
const banner = computed<{ outcome: KnockOutcome; label: string } | null>(() => {
  const signedIds = new Set(
    talk.history.filter((h) => h.outcome === 'signed' && h.person_id).map((h) => h.person_id),
  )
  const total = talk.roster.length
  if (total > 0 && signedIds.size >= total) return { outcome: 'signed', label: 'Everyone signed' }
  const latest = talk.history[0]
  const householdLatest =
    latest && (OUTCOME_DOOR_LEVEL[latest.outcome] || !latest.person_id) ? latest.outcome : null
  if (householdLatest === 'skip' || householdLatest === 'hostile') {
    return { outcome: householdLatest, label: OUTCOME_SHORT[householdLatest] }
  }
  if (signedIds.size > 0) return { outcome: 'maybe', label: `${signedIds.size}/${total} signed` }
  if (householdLatest) return { outcome: householdLatest, label: OUTCOME_SHORT[householdLatest] }
  return null
})

// --- Appointments: somebody promised to be back at this door ---
// Soonest first (the store orders them), and the person is resolved off the
// roster already loaded for this address rather than a second query.
const nextAppointment = computed(() => {
  const a = talk.appointments[0]
  if (!a) return null
  const who = a.person_id ? (talk.roster.find((p) => p.id === a.person_id)?.name ?? null) : null
  return { when: appointmentLabel(a.starts_at, a.ends_at), who }
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

// Walk-order toggles — govern which house the Next button below advances to.
// Press-to-flip, not dropdowns (2026-07-28, user call): direction flips
// up/down, Evens and Odds are a radio-with-off pair (both off = both sides,
// the map layer buttons' idiom — one tap reaches any of the three states,
// which a single toggle can't), and the partly-signed square is symbol-only,
// wearing the pins' own green-with-a-yellow-band.
function flipDirection() {
  hapticTap('light')
  talk.setWalkDirection(talk.walkDirection === 'ascending' ? 'descending' : 'ascending')
}

function toggleParity(side: 'even' | 'odd') {
  hapticTap('light')
  talk.setWalkParity(talk.walkParity === side ? 'both' : side)
}

function togglePartlySigned() {
  hapticTap('light')
  talk.setKnockPartlySigned(!talk.knockPartlySigned)
}
</script>

<template>
  <div class="talk">
    <!-- Always-live search: attaches a person/address to the outcome about to
         be logged. Switching people/addresses happens here, inline — this
         screen never navigates away mid-conversation. -->
    <CanvassSearch />

    <!-- "My doors" — the crew's whole assignment by street — used to sit
         here under the search. It's a square in the Back/Next row now
         (OutcomeButtons), beside the turf filter: one row for every "which
         door next" control. -->

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
        <!-- Managers only, and deliberately tucked into the header row beside
             Clear: a planning number has no business in the middle of the
             screen somebody reads at a stranger's porch. -->
        <div class="head-actions">
          <DoorOddsPanel
            :household-id="talk.selectedAddress.id"
            :label="talk.selectedAddress.street"
            :residents="talk.roster.length"
          />
          <button class="btn btn-sm" @click="talk.clearAddress()">Clear</button>
        </div>
      </div>

      <!-- Somebody said come back at a time. Reads before the roster does:
           it's the reason you're standing here. -->
      <div v-if="nextAppointment" class="appt-line" data-help="talk-appointment">
        <span class="appt-dot" aria-hidden="true"></span>
        <span class="appt-when">Come back {{ nextAppointment.when }}</span>
        <span v-if="nextAppointment.who" class="muted appt-who">{{ nextAppointment.who }}</span>
      </div>

      <RosterList />

      <!-- Everything that's ever happened at this door, newest first. -->
      <div v-if="talk.history.length" class="history">
        <h4 class="history-title">
          Door history
          <span class="muted history-count">{{ talk.history.length }} visit{{ talk.history.length === 1 ? '' : 's' }}</span>
        </h4>
        <ul class="history-list">
          <li
            v-for="h in talk.history"
            :key="h.client_id"
            class="history-row"
            :style="outcomeRowTint(OUTCOME_HEX[h.outcome])"
          >
            <OutcomeSquare :fill="OUTCOME_HEX[h.outcome]" />
            <span class="history-main">
              <span class="history-what">
                <strong>{{ OUTCOME_LABELS[h.outcome] }}</strong>
                <template v-if="h.person?.name"> · {{ h.person.name }}</template>
              </span>
              <span class="muted history-meta">{{ historyWho(h) }} · {{ historyWhen(h.occurred_at) }}</span>
              <span v-if="h.notes" class="muted history-notes">“{{ h.notes }}”</span>
            </span>
          </li>
        </ul>
      </div>
      <p v-else class="muted history-none">No visits logged at this door yet.</p>
    </div>
    <p v-else class="muted walkup-hint">No address loaded.</p>

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
    <div class="walk-order" data-help="talk-walkorder">
      <span class="muted walk-label">Next house:</span>
      <div class="walk-toggles">
        <button
          type="button"
          class="btn walk-btn dir-btn"
          :title="
            talk.walkDirection === 'ascending'
              ? 'House numbers going up. Tap for going down'
              : 'House numbers going down. Tap for going up'
          "
          @click="flipDirection"
        >
          <span aria-hidden="true">{{ talk.walkDirection === 'ascending' ? '↑' : '↓' }}</span>
          {{ talk.walkDirection === 'ascending' ? 'Up' : 'Down' }}
        </button>
        <button
          type="button"
          class="btn walk-btn"
          :class="{ on: talk.walkParity === 'even' }"
          :aria-pressed="talk.walkParity === 'even'"
          :title="talk.walkParity === 'even' ? 'Even numbers only. Tap for both sides' : 'Even numbers only'"
          @click="toggleParity('even')"
        >
          Evens
        </button>
        <button
          type="button"
          class="btn walk-btn"
          :class="{ on: talk.walkParity === 'odd' }"
          :aria-pressed="talk.walkParity === 'odd'"
          :title="talk.walkParity === 'odd' ? 'Odd numbers only. Tap for both sides' : 'Odd numbers only'"
          @click="toggleParity('odd')"
        >
          Odds
        </button>
        <button
          type="button"
          class="btn walk-btn partly-btn"
          :class="{ on: talk.knockPartlySigned }"
          :aria-pressed="talk.knockPartlySigned"
          aria-label="Partly signed doors"
          :title="
            talk.knockPartlySigned
              ? 'Partly signed doors stay on the walk. Tap to skip them'
              : 'Skipping partly signed doors. Tap to knock them'
          "
          @click="togglePartlySigned"
        >
          <OutcomeSquare :fill="OUTCOME_HEX.signed" :band="OUTCOME_HEX.maybe" small />
        </button>
      </div>
    </div>

    <OutcomeButtons />

    <!-- Up next, at the very bottom below the outcome + Next/Back buttons:
         the next four houses the pattern above will visit, two by two —
         tap one to jump straight to it without logging anything. Dot =
         that door's status color (blue = never knocked). -->
    <div v-if="talk.selectedAddress" class="up-next" data-help="talk-upnext">
      <span class="muted up-label">Up next{{ upStreet ? ' on ' + upStreet : '' }}:</span>
      <!-- The grid keeps its two rows whatever is in them: dashed spots hold
           the cells while the walk loads (or pads a short street), so chips
           appear and disappear IN PLACE instead of growing a section of page
           under a scrolling thumb — that height change was the jitter. -->
      <div class="up-grid">
        <template v-if="talk.upcoming === null">
          <span v-for="i in 4" :key="'ghost-' + i" class="up-ghost" aria-hidden="true"></span>
        </template>
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
          <span
            v-for="i in 4 - talk.upcoming.length"
            :key="'pad-' + i"
            class="up-ghost"
            aria-hidden="true"
          ></span>
        </template>
        <!-- With "My turf" on, an empty grid usually means the rest of the
             street isn't yours — not that the street ran out. Say which. -->
        <span v-else class="muted up-none">
          {{
            talk.myDoorsOnly && talk.myTurfIds.size
              ? 'No more of your turf on this street'
              : 'End of the street'
          }}
        </span>
      </div>
    </div>
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
  /* --card-pad keeps the tinted banner's negative margins in lockstep with
   * the real padding. */
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

/* --- Appointment on this door --- */

.appt-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.45rem 0.65rem;
  /* The come-back-another-time amber, so the card, the pin and the promise
   * all say the same thing (fixed literal like every outcome color). */
  border: 1.5px solid #e0a02e;
  border-radius: var(--radius);
  background: color-mix(in srgb, #e0a02e 12%, var(--surface));
  font-size: 0.9rem;
}

.appt-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e0a02e;
  flex-shrink: 0;
}

.appt-when {
  font-weight: 700;
}

.appt-who {
  font-size: 0.85rem;
}

/* --- Door history --- */

/* Odds chip and Clear, kept together at the right of the address header. */
.head-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
}

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

/* Square, and the visit's color across the whole line (2026-07-26, user
 * call) — the door's story reads as a stack of colors before you read a
 * word of it. */
.history-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: calc(var(--radius) - 2px);
  background: var(--row-tint, transparent);
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
  white-space: nowrap;
}

.walk-toggles {
  display: flex;
  gap: 0.5rem;
  flex: 1;
  /* Never squeeze the buttons into clipping their words — on a narrow phone
   * (or a big text scale) the whole group wraps below the label instead. */
  min-width: fit-content;
}

/* Widths come from flex, not content, so the direction button swapping
 * Up for Down never shifts its neighbors. */
.walk-btn {
  flex: 1;
  min-width: 0;
  min-height: 46px;
  padding: 0.3rem 0.4rem;
  font-size: 0.92rem;
  font-weight: 700;
  white-space: nowrap;
}

.dir-btn {
  flex: 1.25;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
}

/* Pressed = the accent, the way every other toggle in the app reads as on. */
.walk-btn.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  color: var(--accent);
}

/* Symbol-only: the partly-signed square the pins draw. Dim it while those
 * doors are being skipped. */
.partly-btn {
  flex: 0 0 auto;
  min-width: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.partly-btn:not(.on) .outcome-square {
  opacity: 0.4;
}

/* --- Up next grid --- */

.up-next {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  /* Reads as one block with the Next/Back row above it. */
  margin-top: -0.35rem;
}

.up-label {
  font-size: 0.85rem;
}

/* Always two side by side — an odd remainder near the end of the street
 * leaves a half-width cell rather than one stretched full-width chip.
 * Rows are pinned at two so the block is the same height loading, full,
 * short, or empty — the page must not grow or shrink as chips land. */
.up-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, minmax(52px, auto));
  gap: 0.6rem;
}

/* A spot a chip will land in (or an empty one at the end of the street). */
.up-ghost {
  border: 1.5px dashed var(--border);
  border-radius: 999px;
  opacity: 0.55;
}

.up-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 52px;
  padding: 0.3rem 0.7rem;
  font: inherit;
  font-size: 1.02rem;
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

.up-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

/* The end-of-street message sits centered across the same reserved rows the
 * chips would occupy — saying it never changes the page's height either. */
.up-none {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 0.85rem;
}
</style>
