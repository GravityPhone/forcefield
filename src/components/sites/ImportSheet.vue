<script setup lang="ts">
// Bring a site plan in from a spreadsheet (2026-11-19).
//
// Three ways to hand it over, one matching step:
//   - a Google Sheets LINK (the sheet shared as "Anyone with the link"). The
//     link is remembered, and Refresh re-reads it later;
//   - rows PASTED out of any spreadsheet (they arrive tab-separated);
//   - a .csv file.
// Then the columns: every field shows the header it was guessed to be, and
// any guess can be corrected before anything is saved. That step is the whole
// reason this works on a sheet nobody here has seen.
//
// What a refresh will and will not change is spelled out at the top of
// lib/sitePlanImport.ts. Crew names are matched to people already in the app;
// a name with no match is reported, never turned into an account.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import { shiftDayLabel, clockLabel } from '@/lib/registration'
import { localToday } from '@/lib/day'
import {
  PLAN_FIELDS,
  guessColumns,
  parseTable,
  readPlan,
  type PlanField,
} from '@/lib/sheetImport'
import {
  describeResult,
  fetchSheet,
  fetchSources,
  saveSource,
  syncSource,
  writePlan,
  type PlanSource,
  type SheetRead,
} from '@/lib/sitePlanImport'
import { supabase } from '@/lib/supabase'

const emit = defineEmits<{ imported: [] }>()
const open = defineModel<boolean>('open', { required: true })

const link = ref('')
const text = ref('')
const table = ref<string[][]>([])
/** Set when the table on screen came from a link: importing it links it. */
const linked = ref<{ read: SheetRead; url: string } | null>(null)
// AppSelect models are strings and Reka refuses an empty-string value, so a
// column is its index as text and "none" is the unmapped state.
const NONE = 'none'
const mapping = ref<Record<PlanField, string>>(blankMapping())
const busy = ref('')
const error = ref('')
const result = ref('')
const sources = ref<PlanSource[]>([])
const unlinkArmed = ref('')

function blankMapping(): Record<PlanField, string> {
  return { site: NONE, address: NONE, date: NONE, start: NONE, end: NONE, goal: NONE, crew: NONE, notes: NONE }
}

async function loadSources() {
  sources.value = await fetchSources()
}

watch(open, (isOpen) => {
  if (!isOpen) return
  link.value = ''
  text.value = ''
  table.value = []
  linked.value = null
  mapping.value = blankMapping()
  error.value = ''
  result.value = ''
  unlinkArmed.value = ''
  void loadSources()
})

const headers = computed(() => table.value[0] ?? [])

const columnOptions = computed<SelectOption[]>(() => [
  { value: NONE, label: 'Not in this sheet' },
  ...headers.value.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
])

function showTable(rows: string[][]): boolean {
  if (rows.length < 2) {
    error.value = 'Need a header row and at least one row under it.'
    return false
  }
  table.value = rows
  const guess = guessColumns(rows[0])
  const next = blankMapping()
  for (const f of PLAN_FIELDS) next[f.key] = guess[f.key] >= 0 ? String(guess[f.key]) : NONE
  mapping.value = next
  return true
}

function readPasted() {
  error.value = ''
  result.value = ''
  linked.value = null
  showTable(parseTable(text.value))
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  text.value = await file.text()
  readPasted()
}

async function readLink() {
  const url = link.value.trim()
  if (!url || busy.value) return
  busy.value = 'link'
  error.value = ''
  result.value = ''
  try {
    const read = await fetchSheet(url)
    if (showTable(parseTable(read.csv))) linked.value = { read, url }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not read that sheet.'
  } finally {
    busy.value = ''
  }
}

const plan = computed(() => {
  const cols = {} as Record<PlanField, number>
  for (const f of PLAN_FIELDS) cols[f.key] = mapping.value[f.key] === NONE ? -1 : Number(mapping.value[f.key])
  return readPlan(table.value.slice(1), cols)
})

const ready = computed(() => mapping.value.site !== NONE && mapping.value.date !== NONE)
const today = localToday()
const preview = computed(() => plan.value.rows.slice(0, 3))

function previewLine(r: (typeof plan.value.rows)[number]): string {
  const bits = [shiftDayLabel(r.date, today)]
  if (r.start) bits.push(r.end ? `${clockLabel(r.start)} to ${clockLabel(r.end)}` : clockLabel(r.start))
  if (r.crew.length) bits.push(r.crew.join(', '))
  return bits.join(' · ')
}

function backToStart() {
  table.value = []
  linked.value = null
  error.value = ''
}

async function runImport() {
  const rows = plan.value.rows
  if (!rows.length || busy.value) return
  busy.value = 'import'
  error.value = ''
  try {
    let sourceId: string | null = null
    if (linked.value) {
      // Header NAMES, not positions: a column moved in the sheet later must
      // still be found by a refresh.
      const byName: Partial<Record<PlanField, string>> = {}
      for (const f of PLAN_FIELDS) {
        const i = mapping.value[f.key]
        if (i !== NONE) byName[f.key] = headers.value[Number(i)]
      }
      sourceId = await saveSource(linked.value.read, linked.value.url, byName)
    }
    const out = await writePlan(rows, sourceId)
    if (sourceId) {
      await supabase.from('site_plan_sources').update({ last_synced_at: new Date().toISOString() }).eq('id', sourceId)
    }
    result.value = describeResult({ ...out, skipped: plan.value.skipped })
    table.value = []
    text.value = ''
    link.value = ''
    linked.value = null
    void loadSources()
    emit('imported')
  } catch {
    error.value = 'Import failed partway. Check the plan before trying again.'
  } finally {
    busy.value = ''
  }
}

async function refresh(s: PlanSource) {
  if (busy.value) return
  busy.value = s.id
  error.value = ''
  result.value = ''
  try {
    result.value = describeResult(await syncSource(s))
    void loadSources()
    emit('imported')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Refresh failed. Try again.'
  } finally {
    busy.value = ''
  }
}

// Two taps, no dialog. Unlinking forgets the sheet; the shifts it brought in
// stay on the plan.
async function unlink(s: PlanSource) {
  if (unlinkArmed.value !== s.id) {
    unlinkArmed.value = s.id
    return
  }
  unlinkArmed.value = ''
  const { error: e } = await supabase.from('site_plan_sources').delete().eq('id', s.id)
  if (e) error.value = 'Could not unlink. Try again.'
  else void loadSources()
}

function syncedLabel(s: PlanSource): string {
  if (!s.last_synced_at) return 'Not read yet'
  const d = new Date(s.last_synced_at)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? `Read ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : `Read ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Import site plan">
    <div class="import">
      <template v-if="!table.length">
        <p v-if="result" class="result">{{ result }}</p>

        <ul v-if="sources.length" class="sources">
          <li v-for="s in sources" :key="s.id" class="source">
            <span class="source-main">
              <span class="source-name">{{ s.title || 'Google Sheet' }}</span>
              <span class="muted source-sub">{{ syncedLabel(s) }}</span>
            </span>
            <button class="btn btn-sm btn-primary" :disabled="!!busy" @click="refresh(s)">
              {{ busy === s.id ? 'Reading…' : 'Refresh' }}
            </button>
            <button
              class="btn btn-sm unlink"
              :class="{ armed: unlinkArmed === s.id }"
              :disabled="!!busy"
              :aria-label="`Unlink ${s.title || 'sheet'}`"
              @click="unlink(s)"
            >
              {{ unlinkArmed === s.id ? 'Unlink?' : '✕' }}
            </button>
          </li>
        </ul>

        <div class="link-row">
          <input
            v-model="link"
            type="text"
            inputmode="url"
            placeholder="Google Sheets link"
            aria-label="Google Sheets link"
            autocomplete="off"
            @keydown.enter="readLink"
          />
          <button class="btn btn-primary" :disabled="!link.trim() || !!busy" @click="readLink">
            {{ busy === 'link' ? 'Reading…' : 'Read' }}
          </button>
        </div>

        <span class="or muted">or paste rows</span>
        <textarea
          v-model="text"
          class="paste"
          rows="5"
          placeholder="Rows copied from a spreadsheet, header row included"
          aria-label="Pasted rows"
        />
        <div class="row">
          <button class="btn grow" :disabled="!text.trim() || !!busy" @click="readPasted">Read rows</button>
          <label class="btn file-btn">
            Choose .csv
            <input type="file" accept=".csv,.tsv,.txt,text/csv" hidden @change="onFile" />
          </label>
        </div>
      </template>

      <template v-else>
        <p v-if="linked" class="from">{{ linked.read.title || 'Google Sheet' }}</p>
        <div class="map-grid">
          <template v-for="f in PLAN_FIELDS" :key="f.key">
            <span class="map-label">{{ f.label }}<span v-if="f.required" class="req"> *</span></span>
            <AppSelect v-model="mapping[f.key]" :options="columnOptions" small />
          </template>
        </div>

        <p class="tally">
          {{ plan.rows.length }} {{ plan.rows.length === 1 ? 'shift' : 'shifts' }} ready
          <template v-if="plan.skipped"> · {{ plan.skipped }} skipped (no site or date)</template>
        </p>
        <ul v-if="preview.length" class="preview">
          <li v-for="(r, i) in preview" :key="i">
            <strong>{{ r.site }}</strong>
            <span class="muted">{{ previewLine(r) }}</span>
          </li>
        </ul>

        <div class="row">
          <button class="btn btn-primary grow" :disabled="!!busy || !ready || !plan.rows.length" @click="runImport">
            {{ busy === 'import' ? 'Importing…' : linked ? `Link and import ${plan.rows.length}` : `Import ${plan.rows.length}` }}
          </button>
          <button class="btn" :disabled="!!busy" @click="backToStart">Back</button>
        </div>
      </template>

      <p v-if="error" class="form-error">{{ error }}</p>
    </div>
  </BottomSheet>
</template>

<style scoped>
.import {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.sources {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.source {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.source-main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}

.source-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-sub {
  font-size: 0.78rem;
}

.unlink {
  flex-shrink: 0;
}

.unlink.armed {
  background: var(--danger);
  color: #fff;
}

.link-row {
  display: flex;
  gap: 0.5rem;
}

.link-row input {
  flex: 1 1 auto;
  min-width: 0;
}

.or {
  font-size: 0.8rem;
  font-weight: 600;
}

.from {
  margin: 0;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.paste {
  width: 100%;
  font-family: ui-monospace, monospace;
  white-space: pre;
  overflow-x: auto;
}

.row {
  display: flex;
  gap: 0.6rem;
}

.grow {
  flex: 1;
}

.file-btn {
  cursor: pointer;
}

.map-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.45rem 0.7rem;
}

.map-label {
  font-size: 0.88rem;
  font-weight: 600;
}

.req {
  color: var(--danger);
}

.tally {
  margin: 0;
  font-weight: 700;
}

.preview {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.preview li {
  display: flex;
  flex-direction: column;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-width: 0;
}

.preview .muted {
  font-size: 0.82rem;
}

.result {
  margin: 0;
  font-weight: 600;
  color: var(--success);
}

.form-error {
  margin: 0;
  color: var(--danger);
  font-weight: 600;
}
</style>
