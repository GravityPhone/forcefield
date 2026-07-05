<script setup lang="ts">
import { ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'

/** GIF search sheet (Tenor v1 public demo key — swap in a Giphy/Tenor v2 key
 * later if rate limits ever bite). Emits the full-size GIF URL on pick. */
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ pick: [url: string] }>()

const TENOR_KEY = 'LIVDSRZULELA'

interface GifResult {
  id: string
  preview: string
  full: string
}

const query = ref('')
const results = ref<GifResult[]>([])
const loading = ref(false)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let requestSeq = 0

async function fetchGifs(q: string) {
  const seq = ++requestSeq
  loading.value = true
  failed.value = false
  const url = q.trim()
    ? `https://g.tenor.com/v1/search?q=${encodeURIComponent(q.trim())}&key=${TENOR_KEY}&limit=24`
    : `https://g.tenor.com/v1/trending?key=${TENOR_KEY}&limit=24`
  try {
    const res = await fetch(url)
    const data = (await res.json()) as {
      results?: { id: string; media: Record<string, { url: string }>[] }[]
    }
    if (seq !== requestSeq) return // a newer search superseded this one
    results.value = (data.results ?? [])
      .map((r) => ({
        id: r.id,
        preview: r.media?.[0]?.tinygif?.url ?? '',
        full: r.media?.[0]?.gif?.url ?? '',
      }))
      .filter((r) => r.preview && r.full)
  } catch {
    if (seq === requestSeq) failed.value = true
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function onInput(value: string) {
  query.value = value
  clearTimeout(timer)
  timer = setTimeout(() => void fetchGifs(value), 300)
}

watch(open, (isOpen) => {
  if (isOpen) {
    query.value = ''
    void fetchGifs('')
  }
})

function pick(gif: GifResult) {
  emit('pick', gif.full)
  open.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Send a GIF" aria-label="Send a GIF">
    <input
      :value="query"
      type="search"
      class="gif-search"
      placeholder="Search GIFs…"
      aria-label="Search GIFs"
      autocomplete="off"
      @input="onInput(($event.target as HTMLInputElement).value)"
    />
    <p v-if="failed" class="muted state">GIF search isn't reachable right now — try again.</p>
    <p v-else-if="loading && !results.length" class="muted state">Loading…</p>
    <p v-else-if="!results.length" class="muted state">Nothing found.</p>
    <div v-else class="gif-grid">
      <button v-for="g in results" :key="g.id" class="gif-cell" @click="pick(g)">
        <img :src="g.preview" alt="" loading="lazy" />
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.gif-search {
  width: 100%;
  min-height: 44px;
  padding: 0.6rem 0.8rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.gif-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.state {
  margin: 0.6rem 0 0;
  font-size: 0.9rem;
}

.gif-grid {
  margin-top: 0.6rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.35rem;
  max-height: 46dvh;
  overflow-y: auto;
}

.gif-cell {
  padding: 0;
  border: none;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2);
  cursor: pointer;
  aspect-ratio: 1;
}

.gif-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
