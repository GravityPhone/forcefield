<script setup lang="ts">
// The "Pick my emoji" sheet on /profile — the huge avatar picker. Every cell
// shows the emoji AND its name (so teammates know what to call each other:
// "I'm the axolotl— er, blowfish"). Tap = saved + closed.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { ALL_AVATARS, AVATAR_GROUPS, avatarName, avatarUrl } from '@/lib/avatars'
import { hapticTap } from '@/lib/native'

const open = defineModel<boolean>('open', { required: true })
const auth = useAuthStore()

const saving = ref(false)
const query = ref('')

watch(open, (o) => {
  if (o) query.value = ''
})

const totalCount = ALL_AVATARS.length

/** Groups filtered by the search box, matching on the display name. */
const shownGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return AVATAR_GROUPS
  return AVATAR_GROUPS.map((g) => ({
    label: g.label,
    slugs: g.slugs.filter((s) => avatarName(s).toLowerCase().includes(q)),
  })).filter((g) => g.slugs.length)
})

async function pick(slug: string | null) {
  if (saving.value || !auth.profile) return
  saving.value = true
  hapticTap('light')
  await supabase.auth.getSession() // refresh-token race guard, same as theme saves
  const { error } = await supabase
    .from('profiles')
    .update({ avatar: slug, updated_at: new Date().toISOString() })
    .eq('id', auth.profile.id)
  if (!error) {
    auth.profile.avatar = slug
    open.value = false
  }
  saving.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Pick my emoji">
    <p class="muted intro">
      {{ totalCount }} to choose from — it shows next to your name everywhere.
    </p>

    <input
      v-model="query"
      class="search"
      type="search"
      placeholder="Search — dragon, taco, disco…"
      aria-label="Search emoji"
    />

    <div class="groups" :class="{ busy: saving }">
      <section v-for="group in shownGroups" :key="group.label" class="group">
        <h3 class="group-heading">{{ group.label }}</h3>
        <div class="grid">
          <button
            v-for="slug in group.slugs"
            :key="slug"
            class="cell"
            :class="{ active: auth.profile?.avatar === slug }"
            :disabled="saving"
            @click="pick(slug)"
          >
            <img :src="avatarUrl(slug)" :alt="''" loading="lazy" />
            <span class="cell-name">{{ avatarName(slug) }}</span>
          </button>
        </div>
      </section>
      <p v-if="!shownGroups.length" class="muted empty">
        Nothing called “{{ query }}” in here — try another word.
      </p>
    </div>

    <button
      v-if="auth.profile?.avatar"
      class="btn btn-ghost btn-sm clear-btn"
      :disabled="saving"
      @click="pick(null)"
    >
      Remove my emoji
    </button>
  </BottomSheet>
</template>

<style scoped>
.intro {
  margin: -0.4rem 0 0;
  font-size: 0.88rem;
}

.search {
  width: 100%;
  min-height: 48px;
  padding: 0.55rem 0.8rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  font: inherit;
  color: var(--text);
}

.search:focus {
  outline: none;
  border-color: var(--accent);
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.groups.busy {
  opacity: 0.7;
}

.group-heading {
  margin: 0 0 0.45rem;
  font-size: 0.95rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(82px, 1fr));
  gap: 0.45rem;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 0.5rem 0.25rem 0.4rem;
  border: 2px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  font: inherit;
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.cell:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  transform: translateY(-1px);
}

.cell.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}

.cell img {
  width: 44px;
  height: 44px;
  object-fit: contain;
}

.cell-name {
  font-size: 0.66rem;
  font-weight: 600;
  line-height: 1.15;
  text-align: center;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.cell.active .cell-name {
  color: var(--text);
}

.empty {
  margin: 0;
  font-size: 0.9rem;
}

.clear-btn {
  align-self: flex-start;
}
</style>
