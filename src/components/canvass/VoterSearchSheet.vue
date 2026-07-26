<script setup lang="ts">
// Find somebody in the county roll (2026-07-26).
//
// Signed is the one outcome that needs a name, and until now the only names
// on offer were the loaded door's roster — so a spouse, an adult kid, a new
// tenant or the neighbour who wandered over was simply unloggable, and a real
// signature went unrecorded. This searches the WHOLE roll.
//
// There is deliberately NO create-a-person flow. Nobody gets typed into the
// voter file from a porch; if they aren't registered, the signature wouldn't
// count anyway.
//
// Picking somebody registered at another door doesn't move the visit — see
// the talk store's logOutcome for where the signature lands and why the door
// you're standing at still gets its own row.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { hapticTap } from '@/lib/native'
import { useTalkStore, type PersonHit } from '@/stores/talk'

const open = defineModel<boolean>('open', { required: true })

const talk = useTalkStore()

const query = ref('')
const hits = ref<PersonHit[]>([])
const searching = ref(false)
const searched = ref(false)

const MIN_CHARS = 2
const LIMIT = 40
const DEBOUNCE_MS = 250

let timer: ReturnType<typeof setTimeout> | undefined
/** Drops results from a query the canvasser has already typed past. */
let seq = 0

async function run(q: string) {
  const mine = ++seq
  searching.value = true
  const { data } = await supabase
    .from('persons')
    .select('*, addresses(street, unit, city)')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(LIMIT)
  if (mine !== seq) return
  searching.value = false
  searched.value = true
  hits.value = (data ?? []) as unknown as PersonHit[]
}

watch(query, (q) => {
  clearTimeout(timer)
  const trimmed = q.trim()
  if (trimmed.length < MIN_CHARS) {
    seq++
    hits.value = []
    searching.value = false
    searched.value = false
    return
  }
  timer = setTimeout(() => void run(trimmed), DEBOUNCE_MS)
})

// A fresh sheet each time — the door has usually moved since it last closed.
watch(open, (v) => {
  if (!v) return
  query.value = ''
  hits.value = []
  searched.value = false
  searching.value = false
  seq++
})

function addressLabel(hit: PersonHit): string {
  const a = hit.addresses
  if (!a) return 'No address on file'
  return [a.street, a.unit, a.city].filter(Boolean).join(' · ')
}

/** Whether this hit is registered at the door already loaded — worth saying,
 *  because then nothing unusual happens and the roster probably just missed
 *  them. */
function atThisDoor(hit: PersonHit): boolean {
  return !!hit.household_id && hit.household_id === talk.selectedAddress?.id
}

const doorLabel = computed(() => talk.selectedAddress?.street ?? '')

function pick(hit: PersonHit) {
  hapticTap('light')
  talk.selectRollPerson(hit)
  open.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Find someone in the roll">
    <div class="roll">
      <input
        v-model="query"
        class="roll-search"
        type="search"
        placeholder="Search the county by name…"
        aria-label="Search the county voter roll by name"
      />

      <p v-if="searching" class="muted state">Searching…</p>
      <p v-else-if="query.trim().length && query.trim().length < MIN_CHARS" class="muted state">
        Keep typing…
      </p>
      <p v-else-if="searched && !hits.length" class="muted state">
        Nobody by that name on the county roll.
      </p>

      <ul v-if="hits.length" class="hit-list">
        <li v-for="h in hits" :key="h.id">
          <button class="hit" type="button" @click="pick(h)">
            <span class="hit-name">{{ h.name }}</span>
            <span class="hit-where muted">{{ addressLabel(h) }}</span>
            <span class="hit-tags">
              <span v-if="atThisDoor(h)" class="tag here">{{ doorLabel || 'This door' }}</span>
              <span v-else-if="h.household_id" class="tag away">Signs for their address</span>
              <span v-if="!h.registered_voter" class="tag unreg">Not registered</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </BottomSheet>
</template>

<style scoped>
.roll {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.roll-search {
  width: 100%;
}

.state {
  margin: 0;
  font-size: 0.9rem;
}

.hit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 52dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.hit {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.15rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  /* A button's UA styles centre and clamp its contents — these are spans. */
  white-space: normal;
}

.hit:active {
  filter: brightness(0.96);
}

.hit-name {
  font-weight: 700;
}

.hit-where {
  font-size: 0.8rem;
}

.hit-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.15rem;
}

.tag {
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  border: 1px solid;
}

.here {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 40%, var(--surface));
  background: color-mix(in srgb, var(--success) 12%, var(--surface));
}

.away {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 40%, var(--surface));
  background: color-mix(in srgb, var(--warning) 12%, var(--surface));
}

.unreg {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, var(--surface));
  background: color-mix(in srgb, var(--danger) 12%, var(--surface));
}
</style>
