<script setup lang="ts">
import { computed } from 'vue'
import { useTalkStore, type PersonHit } from '@/stores/talk'
import type { Address } from '@/types'

const talk = useTalkStore()

const hasResults = computed(
  () => talk.searchResults.persons.length > 0 || talk.searchResults.addresses.length > 0,
)
const showDropdown = computed(() => talk.searchQuery.trim().length >= 2)

function formatAddress(a: Pick<Address, 'street' | 'unit' | 'city'>): string {
  return `${a.street}${a.unit ? ' ' + a.unit : ''}, ${a.city}`
}

async function pickPerson(hit: PersonHit) {
  if (hit.household_id) {
    await talk.loadAddress(hit.household_id, hit.id)
  } else {
    talk.clearSearch()
  }
}

function pickAddress(a: Address) {
  void talk.loadAddress(a.id)
}
</script>

<template>
  <div class="search">
    <input
      :value="talk.searchQuery"
      class="search-input"
      type="search"
      placeholder="Search name or address…"
      aria-label="Search people or addresses"
      autocomplete="off"
      @input="talk.search(($event.target as HTMLInputElement).value)"
    />
    <div v-if="showDropdown" class="results card">
      <template v-if="hasResults">
        <div v-if="talk.searchResults.persons.length" class="group">
          <div class="group-label">People</div>
          <button
            v-for="p in talk.searchResults.persons"
            :key="p.id"
            class="result"
            @click="pickPerson(p)"
          >
            <span class="result-main">{{ p.name }}</span>
            <span class="result-sub muted">
              {{ p.addresses ? formatAddress(p.addresses) : 'No address on file' }}
            </span>
          </button>
        </div>
        <div v-if="talk.searchResults.addresses.length" class="group">
          <div class="group-label">Addresses</div>
          <button
            v-for="a in talk.searchResults.addresses"
            :key="a.id"
            class="result"
            @click="pickAddress(a)"
          >
            <span class="result-main">{{ a.street }}{{ a.unit ? ' ' + a.unit : '' }}</span>
            <span class="result-sub muted">{{ a.city }}</span>
          </button>
        </div>
      </template>
      <div v-else-if="talk.searching" class="empty muted">Searching…</div>
      <!-- Anonymous walk-up logging was removed (outcomes need a loaded
           address), so don't suggest "log it anyway" here. -->
      <div v-else class="empty muted">No matches — try fewer letters, or find the door in Hunt.</div>
    </div>
  </div>
</template>

<style scoped>
.search {
  position: relative;
}

.search-input {
  width: 100%;
  min-height: 48px;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.search-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 320px;
  overflow-y: auto;
  padding: 0.4rem;
}

.group-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0.35rem 0.5rem 0.15rem;
}

.result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  width: 100%;
  padding: 0.55rem 0.5rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.result:hover,
.result:focus-visible {
  background: var(--surface-2);
}

.result-main {
  font-weight: 600;
}

.result-sub {
  font-size: 0.82rem;
}

.empty {
  padding: 0.75rem 0.5rem;
  font-size: 0.9rem;
}
</style>
