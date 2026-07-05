<script setup lang="ts">
import CanvassSearch from './CanvassSearch.vue'
import RosterList from './RosterList.vue'
import OutcomeButtons from './OutcomeButtons.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { useTalkStore } from '@/stores/talk'

const talk = useTalkStore()

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

    <div v-if="talk.selectedAddress" class="card address-card">
      <div class="address-head">
        <div>
          <div class="address-line">
            {{ talk.selectedAddress.street
            }}{{ talk.selectedAddress.unit ? ' ' + talk.selectedAddress.unit : '' }}
          </div>
          <div class="muted address-city">{{ talk.selectedAddress.city }}</div>
        </div>
        <button class="btn btn-sm" @click="talk.clearAddress()">Clear</button>
      </div>
      <RosterList />
    </div>
    <p v-else class="muted walkup-hint">
      Load an address (search above, or via Hunt) to log an outcome.
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
  padding: 1rem;
}

.address-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
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
