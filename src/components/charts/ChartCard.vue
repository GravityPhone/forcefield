<script setup lang="ts">
// Card frame every analytics chart lives in: title, optional subtitle, and a
// chart ⇄ table toggle. The table twin is the accessibility contract — every
// value a chart or tooltip shows must also be readable as plain text.
import { ref } from 'vue'

defineProps<{
  title: string
  subtitle?: string
  /** Table-view twin. Omit only for pure stat tiles. */
  columns?: string[]
  rows?: (string | number)[][]
  /** The table IS the content — no chart slot, no toggle. */
  tableOnly?: boolean
}>()

const showTable = ref(false)
</script>

<template>
  <div class="card chart-card">
    <div class="chart-head">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="subtitle" class="muted sub">{{ subtitle }}</p>
      </div>
      <button
        v-if="columns && rows && !tableOnly"
        class="btn btn-sm table-toggle"
        type="button"
        :aria-pressed="showTable"
        @click="showTable = !showTable"
      >
        {{ showTable ? 'Chart' : 'Table' }}
      </button>
    </div>

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
          <tr v-for="(r, i) in rows" :key="i">
            <td v-for="(cell, j) in r" :key="j" :class="{ num: j > 0 }">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chart-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}
.chart-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
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
</style>
