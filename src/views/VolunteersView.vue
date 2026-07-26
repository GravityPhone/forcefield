<script setup lang="ts">
// Who said they'd knock doors (2026-07-26).
//
// The read side of the one follow-up after a signature (VolunteerSheet). It
// exists so the ask isn't write-only — a list nobody can see is a list nobody
// acts on, and acting on it is the entire point of asking.
//
// Manager/admin only: recruiting is their job, and a canvasser's own asks are
// already answered on the porch.
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { fetchAllRows, supabase } from '@/lib/supabase'

interface VolunteerRow {
  person_id: string
  household_id: string | null
  created_at: string
  person: { name: string } | null
  address: { street: string; city: string } | null
  canvasser: {
    id: string
    username: string
    display_name: string | null
    avatar: string | null
    color: string | null
  } | null
}

const SELECT =
  'person_id, household_id, created_at, ' +
  'person:persons(name), address:addresses(street, city), ' +
  'canvasser:profiles(id, username, display_name, avatar, color)'

const rows = ref<VolunteerRow[]>([])
const loading = ref(true)
const loadError = ref(false)
const search = ref('')

const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter(
    (r) =>
      (r.person?.name ?? '').toLowerCase().includes(q) ||
      (r.address?.street ?? '').toLowerCase().includes(q) ||
      (r.address?.city ?? '').toLowerCase().includes(q),
  )
})

function nameOf(r: VolunteerRow): string {
  const c = r.canvasser
  return c ? c.display_name || c.username : 'someone'
}

function whenOf(r: VolunteerRow): string {
  return new Date(r.created_at).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })
}

onMounted(async () => {
  // Whole-set read, so it pages — PostgREST caps every response at 1000.
  const data = await fetchAllRows<VolunteerRow>(
    (from, to) =>
      supabase
        .from('volunteer_interest')
        .select(SELECT)
        .order('created_at', { ascending: false })
        .order('person_id')
        .range(from, to) as unknown as PromiseLike<{
        data: VolunteerRow[] | null
        error: { message: string } | null
      }>,
  ).catch(() => null)
  loading.value = false
  if (!data) {
    loadError.value = true
    return
  }
  rows.value = data
})
</script>

<template>
  <AppShell title="Volunteers">
    <div class="stack">
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="loadError" class="error">Couldn’t load the list — try again.</p>
      <p v-else-if="!rows.length" class="muted">
        Nobody yet. A signer who says they’d knock doors lands here.
      </p>

      <template v-else>
        <div class="card count-card" data-help="volunteers-count">
          <span class="count">{{ rows.length.toLocaleString() }}</span>
          <span class="count-lbl">said they’d knock doors</span>
        </div>

        <input
          v-model="search"
          class="vol-search"
          type="search"
          placeholder="Search name or street…"
          aria-label="Search volunteers"
        />

        <p v-if="!shown.length" class="muted">No match.</p>

        <ul v-else class="vol-list" data-help="volunteers-list">
          <li v-for="r in shown" :key="r.person_id" class="card vol-row">
            <div class="row-main">
              <span class="vol-name">{{ r.person?.name ?? 'Unknown' }}</span>
              <span v-if="r.address" class="vol-where muted">
                {{ r.address.street }} · {{ r.address.city }}
              </span>
            </div>
            <div class="row-meta">
              <router-link
                v-if="r.canvasser"
                class="asker"
                :to="`/member/${r.canvasser.id}`"
                :title="`Asked by ${nameOf(r)}`"
              >
                <img
                  v-if="r.canvasser.avatar"
                  class="asker-avatar"
                  :src="avatarUrl(r.canvasser.avatar)"
                  alt=""
                  :style="{ borderColor: memberColor(r.canvasser) }"
                />
                <span class="asker-name">{{ nameOf(r) }}</span>
              </router-link>
              <span class="when muted">{{ whenOf(r) }}</span>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </AppShell>
</template>

<style scoped>
.count-card {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.7rem 0.9rem;
}

.count {
  font-size: 1.6rem;
  font-weight: 800;
  line-height: 1;
}

.count-lbl {
  font-size: 0.9rem;
  font-weight: 600;
}

.vol-search {
  width: 100%;
}

.vol-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* Wraps rather than pushing the page sideways — the app never scrolls
   horizontally (style.css). */
.vol-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem 0.7rem;
  padding: 0.6rem 0.8rem;
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  flex: 1 1 auto;
  min-width: 0;
}

.vol-name {
  font-weight: 700;
}

.vol-where {
  font-size: 0.82rem;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* Styled like the bold text it replaces, not like a link — a list of blue
   underlines is unreadable (same rule as the activity feed). */
.asker {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: inherit;
  text-decoration: none;
  font-size: 0.82rem;
  font-weight: 700;
}

.asker-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--border);
  background: var(--surface-2);
}

.when {
  font-size: 0.78rem;
}
</style>
