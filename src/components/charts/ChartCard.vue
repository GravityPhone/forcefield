<script setup lang="ts">
// Card frame every analytics chart lives in: title, optional subtitle (keep it
// to a 2–3 word hint — teaching copy belongs in the per-tab help sheet), and a
// chart ⇄ table toggle. The table twin is the accessibility contract — every
// value a chart or tooltip shows must also be readable as plain text.
//
// THE HEADING IS A SWITCH (2026-07-27, user call: "I'd like it to be, like, in
// a header where you just tap the header, and there are various headers and
// you can open and close them"). Cards open by default — a manager landing on
// a tab must see its numbers, not a stack of closed lids — and each card
// remembers what it was left as, keyed by title, so closing one that never
// gets read closes it for good. Note the heading is its own <button> BESIDE
// the Table toggle rather than wrapping it: a button inside a button is
// invalid markup that browsers silently unnest.
//
// Table rows drill on the SECOND tap, matching the bars. See BarChart's header
// for why one tap was too fast.
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  title: string
  subtitle?: string
  /** Table-view twin. Omit only for pure stat tiles. */
  columns?: string[]
  rows?: (string | number)[][]
  /** The table IS the content — no chart slot, no toggle. */
  tableOnly?: boolean
  /** Rows are tap targets; each tap emits `select-row` with the row index. */
  selectableRows?: boolean
}>()

const emit = defineEmits<{ (e: 'select-row', index: number): void }>()

const showTable = ref(false)

// --- open / closed, remembered per card ---

const storeKey = computed(() => `forcefield.analytics.card.${props.title}`)
function readOpen(): boolean {
  try {
    return localStorage.getItem(storeKey.value) !== 'closed'
  } catch {
    return true
  }
}
const open = ref(readOpen())
watch(open, (v) => {
  try {
    localStorage.setItem(storeKey.value, v ? 'open' : 'closed')
  } catch {
    /* private mode: the card still opens and closes, it just won't remember */
  }
})
// Vue reuses this instance when a v-for swaps one card's title for another's.
watch(
  () => props.title,
  () => (open.value = readOpen()),
)

// --- two taps to drill ---

const armedRow = ref<number | null>(null)
watch(
  () => props.rows,
  () => (armedRow.value = null),
)
function onRowTap(i: number) {
  if (!props.selectableRows) return
  if (armedRow.value === i) emit('select-row', i)
  else armedRow.value = i
}
</script>

<template>
  <div class="card chart-card" :class="{ shut: !open }">
    <div class="chart-head">
      <button class="head-main" type="button" :aria-expanded="open" @click="open = !open">
        <span class="caret" :class="{ down: open }" aria-hidden="true">▸</span>
        <span class="head-text">
          <h3>{{ title }}</h3>
          <p v-if="subtitle" class="muted sub">{{ subtitle }}</p>
        </span>
      </button>
      <button
        v-if="open && columns && rows && !tableOnly"
        class="btn btn-sm table-toggle"
        type="button"
        :aria-pressed="showTable"
        @click="showTable = !showTable"
      >
        {{ showTable ? 'Chart' : 'Table' }}
      </button>
    </div>

    <template v-if="open">
      <div v-if="!showTable && !tableOnly" class="chart-body">
        <slot />
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th v-for="c in columns" :key="c">{{ c }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in rows"
              :key="i"
              :class="{ sel: selectableRows, armed: armedRow === i }"
              @click="onRowTap(i)"
            >
              <td v-for="(cell, j) in r" :key="j" :class="{ num: j > 0 }">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chart-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}
/* A closed card is just its heading, so it keeps no body gap. */
.chart-card.shut {
  gap: 0;
}
.chart-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}
/* The whole heading is the switch. Against the UA button styles it needs its
   text left and unclamped, exactly like the Squad page's member tiles. */
.head-main {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  white-space: normal;
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  min-width: 0;
  flex: 1 1 auto;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.head-text {
  min-width: 0;
}
.caret {
  color: var(--text-muted);
  font-size: 0.8rem;
  line-height: 1.5;
  transition: transform 0.12s ease;
}
.caret.down {
  transform: rotate(90deg);
}
.chart-head h3 {
  margin: 0;
  font-size: 1rem;
}
.sub {
  margin: 0.15rem 0 0;
  font-size: 0.8rem;
}
.table-toggle {
  flex-shrink: 0;
}
.chart-body {
  min-width: 0;
}
.table-wrap {
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
  /* Two taps in quick succession must open the row, never zoom the page. */
  touch-action: manipulation;
}
th,
td {
  text-align: left;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--text-muted);
  font-weight: 600;
  position: sticky;
  top: 0;
  background: var(--surface);
}
td.num {
  font-variant-numeric: tabular-nums;
}
tr.sel {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
tr.sel:hover td {
  background: var(--surface-2);
}
/* Armed: one more tap opens it. The chevron says which way that tap goes. */
tr.sel.armed td {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface));
}
tr.sel.armed td:first-child::after {
  content: ' ›';
  color: var(--accent);
  font-weight: 800;
}
</style>
