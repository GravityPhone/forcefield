<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { avatarUrl } from '@/lib/avatars'
import type { ChatProfile } from '@/types'

const props = defineProps<{
  modelValue: ChatProfile[]
  /** User ids to hide from results (e.g. existing chat members). */
  exclude?: string[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: ChatProfile[]] }>()

const chat = useChatStore()
const query = ref('')
const results = ref<ChatProfile[]>([])
const searching = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

// "Show everyone" — browse without typing a search. Scoped to your own team
// (the org has several); admins have no team and browse the whole org.
const browsing = ref(false)

function toggleBrowse() {
  browsing.value = !browsing.value
  if (browsing.value && !chat.orgMembers.length) void chat.loadOrgMembers()
}

const myTeamId = computed(() => useAuthStore().profile?.team_id ?? null)

const browseLabel = computed(() => (myTeamId.value ? 'everyone on your team' : 'everyone'))

const browseList = computed(() => {
  const hidden = new Set([
    chat.myId ?? '',
    ...(props.exclude ?? []),
    ...props.modelValue.map((p) => p.id),
  ])
  return chat.orgMembers.filter(
    (p) => !hidden.has(p.id) && (!myTeamId.value || p.team_id === myTeamId.value),
  )
})

function onInput(value: string) {
  query.value = value
  clearTimeout(timer)
  if (!value.trim()) {
    results.value = []
    return
  }
  searching.value = true
  timer = setTimeout(async () => {
    const found = await chat.searchUsers(value)
    const hidden = new Set([...(props.exclude ?? []), ...props.modelValue.map((p) => p.id)])
    results.value = found.filter((p) => !hidden.has(p.id))
    searching.value = false
  }, 250)
}

function pick(profile: ChatProfile) {
  emit('update:modelValue', [...props.modelValue, profile])
  query.value = ''
  results.value = []
}

function remove(id: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((p) => p.id !== id),
  )
}
</script>

<template>
  <div class="picker">
    <div v-if="modelValue.length" class="chips">
      <button v-for="p in modelValue" :key="p.id" class="chip" @click="remove(p.id)">
        {{ p.display_name || p.username }} ✕
      </button>
    </div>
    <input
      :value="query"
      type="search"
      class="picker-input"
      placeholder="Search people by username…"
      aria-label="Search people"
      autocomplete="off"
      @input="onInput(($event.target as HTMLInputElement).value)"
    />
    <div v-if="query.trim()" class="results">
      <button v-for="p in results" :key="p.id" class="result" @click="pick(p)">
        <img v-if="avatarUrl(p.avatar)" class="result-avatar" :src="avatarUrl(p.avatar)" alt="" />
        <span class="result-name">{{ p.display_name || p.username }}</span>
        <span class="muted">@{{ p.username }}</span>
      </button>
      <p v-if="!results.length && !searching" class="muted empty">No one found.</p>
    </div>

    <template v-else>
      <button class="browse-toggle" :aria-expanded="browsing" @click="toggleBrowse">
        {{ browsing ? '▾' : '▸' }} {{ browsing ? 'Hide' : 'Show' }} {{ browseLabel }}
      </button>
      <div v-if="browsing" class="results">
        <button v-for="p in browseList" :key="p.id" class="result" @click="pick(p)">
          <img v-if="avatarUrl(p.avatar)" class="result-avatar" :src="avatarUrl(p.avatar)" alt="" />
          <span class="result-name">{{ p.display_name || p.username }}</span>
          <span class="muted">@{{ p.username }}</span>
        </button>
        <p v-if="!browseList.length" class="muted empty">No one else to add.</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.chip {
  border: 1px solid var(--accent);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 999px;
  padding: 0.3rem 0.7rem;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.picker-input {
  width: 100%;
  min-height: 44px;
  padding: 0.6rem 0.8rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.picker-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-height: 180px;
  overflow-y: auto;
}

.browse-toggle {
  align-self: flex-start;
  min-height: 40px;
  padding: 0.4rem 0.6rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
}

.browse-toggle:hover {
  background: var(--surface-2);
}

.result-avatar {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  align-self: center;
}

.result {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
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

.result-name {
  font-weight: 600;
}

.empty {
  padding: 0.4rem 0.6rem;
  font-size: 0.88rem;
}
</style>
