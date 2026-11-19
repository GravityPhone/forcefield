<script setup lang="ts">
// Bring an existing site plan in from a spreadsheet (2026-11-19).
//
// Two steps on one sheet. First the table: paste the rows straight out of
// Google Sheets (they arrive tab-separated) or choose a .csv. Then the
// columns: every field shows the header it was guessed to be, and any guess
// can be corrected before anything is saved. That second step is the whole
// reason this works on a sheet nobody here has seen.
//
// Crew names are matched against people already in the app by display name
// or username. A name with no match is reported, never invented: nobody gets
// an account from a spreadsheet cell.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { shiftDayLabel, clockLabel } from '@/lib/registration'
import { localToday } from '@/lib/day'
import {
  PLAN_FIELDS,
  guessColumns,
  parseTable,
  readPlan,
  type PlanField,
} from '@/lib/sheetImport'

const emit = defineEmits<{ imported: [] }>()
const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()

const text = ref('')
const table = ref<string[][]>([])
// AppSelect models are strings and Reka refuses an empty-string value, so a
// column is its index as text and "none" is the unmapped state.
const NONE = 'none'
const mapping = ref<Record<PlanField, string>>(blankMapping())
const busy = ref(false)
const error = ref('')
const result = ref('')

function blankMapping(): Record<PlanField, string> {
  return { site: NONE, address: NONE, date: NONE, start: NONE, end: NONE, goal: NONE, crew: NONE, notes: NONE }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  text.value = ''
  table.value = []
  mapping.value = blankMapping()
  error.value = ''
  result.value = ''
})

const headers = computed(() => table.value[0] ?? [])

const columnOptions = computed<SelectOption[]>(() => [
  { value: NONE, label: 'Not in this sheet' },
  ...headers.value.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
])

function readTable() {
  error.value = ''
  result.value = ''
  const rows = parseTable(text.value)
  if (rows.length < 2) {
    error.value = 'Need a header row and at least one row under it.'
    return
  }
  table.value = rows
  const guess = guessColumns(rows[0])
  const next = blankMapping()
  for (const f of PLAN_FIELDS) next[f.key] = guess[f.key] >= 0 ? String(guess[f.key]) : NONE
  mapping.value = next
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  text.value = await file.text()
  readTable()
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

function backToPaste() {
  table.value = []
  error.value = ''
}

async function runImport() {
  const cid = auth.profile?.campaign_id
  const me = auth.profile?.id
  const rows = plan.value.rows
  if (!cid || !me || !rows.length) return
  busy.value = true
  error.value = ''
  try {
    // Sites: reuse by name within the campaign, create the rest in one write.
    const { data: existing, error: e1 } = await supabase
      .from('sites')
      .select('id, name')
      .eq('campaign_id', cid)
    if (e1) throw e1
    const siteIds = new Map<string, string>()
    for (const s of existing ?? []) siteIds.set((s.name as string).toLowerCase(), s.id as string)

    const fresh = new Map<string, { name: string; address: string | null }>()
    for (const r of rows) {
      const key = r.site.toLowerCase()
      if (siteIds.has(key)) continue
      const seen = fresh.get(key)
      if (!seen) fresh.set(key, { name: r.site, address: r.address })
      else if (!seen.address && r.address) seen.address = r.address
    }
    if (fresh.size) {
      const { data: made, error: e2 } = await supabase
        .from('sites')
        .insert([...fresh.values()].map((s) => ({ ...s, campaign_id: cid, created_by: me })))
        .select('id, name')
      if (e2) throw e2
      for (const s of made ?? []) siteIds.set((s.name as string).toLowerCase(), s.id as string)
    }

    // Shifts, in sheet order. PostgREST returns inserted rows in the order
    // they were sent, which is what lines each one up with its crew below.
    const { data: shifts, error: e3 } = await supabase
      .from('site_shifts')
      .insert(
        rows.map((r) => ({
          site_id: siteIds.get(r.site.toLowerCase()),
          shift_date: r.date,
          start_time: r.start,
          end_time: r.end,
          goal: r.goal,
          notes: r.notes,
          created_by: me,
        })),
      )
      .select('id')
    if (e3) throw e3

    // Crew: names to people. Exact display name or username first, then a
    // first name when exactly one person has it.
    const unmatched = new Set<string>()
    const members: { shift_id: string; user_id: string }[] = []
    if (rows.some((r) => r.crew.length)) {
      const people = await fetchAllRows<{ id: string; username: string; display_name: string | null }>(
        (from, to) => supabase.from('profiles').select('id, username, display_name').order('id').range(from, to),
      )
      const exact = new Map<string, string>()
      const firstNames = new Map<string, string[]>()
      for (const p of people) {
        exact.set(p.username.toLowerCase(), p.id)
        if (p.display_name) {
          exact.set(p.display_name.toLowerCase(), p.id)
          const first = p.display_name.trim().split(/\s+/)[0].toLowerCase()
          firstNames.set(first, [...(firstNames.get(first) ?? []), p.id])
        }
      }
      rows.forEach((r, i) => {
        const shiftId = shifts?.[i]?.id as string | undefined
        if (!shiftId) return
        const added = new Set<string>()
        for (const typed of r.crew) {
          const key = typed.toLowerCase()
          const firsts = firstNames.get(key)
          const id = exact.get(key) ?? (firsts?.length === 1 ? firsts[0] : undefined)
          if (!id) unmatched.add(typed)
          else if (!added.has(id)) {
            added.add(id)
            members.push({ shift_id: shiftId, user_id: id })
          }
        }
      })
      if (members.length) {
        const { error: e4 } = await supabase.from('site_shift_members').insert(members)
        if (e4) throw e4
      }
    }

    const siteCount = new Set(rows.map((r) => r.site.toLowerCase())).size
    const parts = [`Imported ${rows.length} ${rows.length === 1 ? 'shift' : 'shifts'} at ${siteCount} ${siteCount === 1 ? 'site' : 'sites'}.`]
    if (plan.value.skipped) parts.push(`${plan.value.skipped} skipped.`)
    if (unmatched.size) parts.push(`No account for: ${[...unmatched].join(', ')}.`)
    result.value = parts.join(' ')
    table.value = []
    text.value = ''
    emit('imported')
  } catch {
    error.value = 'Import failed. Nothing may have been saved past the point it stopped.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Import site plan">
    <div class="import">
      <template v-if="!table.length">
        <p v-if="result" class="result">{{ result }}</p>
        <textarea
          v-model="text"
          class="paste"
          rows="7"
          placeholder="Paste rows copied from Google Sheets, header row included"
          aria-label="Pasted rows"
        />
        <div class="row">
          <button class="btn btn-primary grow" :disabled="!text.trim()" @click="readTable">Read rows</button>
          <label class="btn file-btn">
            Choose .csv
            <input type="file" accept=".csv,.tsv,.txt,text/csv" hidden @change="onFile" />
          </label>
        </div>
      </template>

      <template v-else>
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
          <button class="btn btn-primary grow" :disabled="busy || !ready || !plan.rows.length" @click="runImport">
            {{ busy ? 'Importing…' : `Import ${plan.rows.length}` }}
          </button>
          <button class="btn" :disabled="busy" @click="backToPaste">Back</button>
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
