<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { houseNumber, streetNameOf, titleCase } from '@/lib/streetWalk'
import { useTalkStore } from '@/stores/talk'

// "My doors" — the whole list of what's been handed to your crew today,
// grouped by street (2026-07-25, user call). It exists to answer a question
// the walk buttons can't: "what street am I even on?" You open it, see that
// yes, it's Walnut, and tap in from there. A starting point, not a walk.
//
// Deliberately the SAME turf set the walk filter uses (talk.myTurfIds — the
// crew's ground, see lib/myTurf.ts), so the list and the Next button can
// never disagree about what counts as yours.

const open = defineModel<boolean>('open', { required: true })

const talk = useTalkStore()

interface DoorRow {
  id: string
  street: string
  unit: string | null
  city: string
}

const rows = ref<DoorRow[]>([])
const loading = ref(false)
const loadError = ref(false)
const query = ref('')
/** Which street's houses are expanded. Null = the street list. */
const openStreet = ref<string | null>(null)

let loadedForTurfKey = ''

/** Fetch once per turf set. A crew's assignment is hundreds of doors, not
 * thousands, but it still pages — the 1000-row cap is not optional. */
async function load() {
  const ids = [...talk.myTurfIds]
  const key = ids.slice().sort().join(',')
  if (!ids.length) {
    rows.value = []
    loadedForTurfKey = ''
    return
  }
  if (key === loadedForTurfKey && rows.value.length) return
  loading.value = true
  loadError.value = false
  try {
    const data = await fetchAllRows<DoorRow>((from, to) =>
      supabase
        .from('addresses')
        .select('id, street, unit, city')
        .in('turf_id', ids)
        .order('id')
        .range(from, to),
    )
    rows.value = data
    loadedForTurfKey = key
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

watch(open, (v) => {
  if (!v) return
  openStreet.value = null
  query.value = ''
  void talk.ensureMyTurf().then(load)
})

interface StreetGroup {
  key: string
  name: string
  city: string
  doors: DoorRow[]
}

/** Doors bucketed by street, each street's houses in walk order. */
const groups = computed<StreetGroup[]>(() => {
  const by = new Map<string, StreetGroup>()
  for (const r of rows.value) {
    const name = streetNameOf(r.street)
    if (!name) continue
    const key = `${name}|${r.city}`
    const g = by.get(key)
    if (g) g.doors.push(r)
    else by.set(key, { key, name, city: r.city, doors: [r] })
  }
  const out = [...by.values()]
  for (const g of out) g.doors.sort((a, b) => houseNumber(a.street) - houseNumber(b.street))
  return out.sort((a, b) => a.name.localeCompare(b.name))
})

/** One box searches both halves: type letters to narrow streets, type digits
 * to jump to a house number. That's the "put in a door number" the list was
 * asked for, without a second field to explain. */
const trimmed = computed(() => query.value.trim().toUpperCase())
const isNumberQuery = computed(() => /^\d+$/.test(trimmed.value))

const shownGroups = computed(() => {
  if (!trimmed.value || isNumberQuery.value) return groups.value
  return groups.value.filter((g) => g.name.includes(trimmed.value))
})

/** Digits typed: every matching house across all your streets. */
const numberHits = computed<DoorRow[]>(() => {
  if (!isNumberQuery.value) return []
  const n = Number(trimmed.value)
  return rows.value
    .filter((r) => houseNumber(r.street) === n)
    .sort((a, b) => streetNameOf(a.street).localeCompare(streetNameOf(b.street)))
    .slice(0, 40)
})

const current = computed(() => groups.value.find((g) => g.key === openStreet.value) ?? null)

const doorCount = computed(() => rows.value.length)

function pick(id: string) {
  open.value = false
  void talk.loadAddress(id)
}
</script>

<template>
  <BottomSheet v-model:open="open" title="My doors">
    <div class="my-doors">
      <input
        v-model="query"
        class="doors-search"
        type="search"
        inputmode="search"
        placeholder="Street name, or a house number"
        aria-label="Search your doors"
      />

      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="loadError" class="muted">Couldn't load your doors.</p>
      <p v-else-if="!doorCount" class="muted">No turf assigned to you today.</p>

      <!-- A number was typed: houses first, wherever they are. -->
      <template v-else-if="isNumberQuery">
        <p v-if="!numberHits.length" class="muted">No house numbered {{ trimmed }} on your turf.</p>
        <button v-for="d in numberHits" :key="d.id" class="door-row" @click="pick(d.id)">
          <span class="door-name">{{ titleCase(d.street) }}{{ d.unit ? ' ' + d.unit : '' }}</span>
          <span class="muted door-city">{{ titleCase(d.city) }}</span>
        </button>
      </template>

      <!-- One street, opened: its houses low to high. -->
      <template v-else-if="current">
        <button class="back-row" @click="openStreet = null">‹ All streets</button>
        <button v-for="d in current.doors" :key="d.id" class="door-row" @click="pick(d.id)">
          <span class="door-name">{{ titleCase(d.street) }}{{ d.unit ? ' ' + d.unit : '' }}</span>
        </button>
      </template>

      <!-- Default: the streets you have, with how many doors on each. -->
      <template v-else>
        <p v-if="!shownGroups.length" class="muted">No street matches that.</p>
        <button v-for="g in shownGroups" :key="g.key" class="door-row" @click="openStreet = g.key">
          <span class="door-name">{{ titleCase(g.name) }}</span>
          <span class="muted door-city">{{ titleCase(g.city) }} · {{ g.doors.length }}</span>
        </button>
      </template>
    </div>
  </BottomSheet>
</template>

<style scoped>
.my-doors {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.doors-search {
  width: 100%;
  min-height: 44px;
  /* 16px floor: below it iOS Safari zooms the page on focus. */
  font-size: max(16px, calc(0.95rem * var(--ui-scale)));
}

.door-row,
.back-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.back-row {
  justify-content: flex-start;
  font-weight: 700;
}

.door-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.door-city {
  flex: 0 0 auto;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
}
</style>
