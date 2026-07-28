<script setup lang="ts">
/**
 * The chat's emoji picker.
 *
 * It replaces the one vue-advanced-chat ships (emoji-picker-element), which
 * never worked here: that component fetches its dataset from jsdelivr the
 * first time it opens, and netlify.toml's `connect-src` doesn't list the CDN,
 * so on the live site it only ever rendered "Could not load emoji." in a
 * 300px popup. This one carries its own data (src/lib/emojiData.ts, generated
 * by scripts/fetch-emoji.mjs), so it costs no requests and works with no
 * signal at all — which is the state a canvasser is in often enough to matter.
 *
 * The data module is imported DYNAMICALLY, on first open. It's ~110 kB and
 * belongs to a sheet plenty of sessions never touch.
 */
import { computed, nextTick, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { hapticTap } from '@/lib/native'
import type { EmojiEntry, EmojiGroup } from '@/lib/emojiData'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ title?: string }>()
const emit = defineEmits<{ pick: [emoji: string] }>()

const RECENT_KEY = 'forcefield.chat_emoji_recent'
const RECENT_MAX = 24

const groups = ref<EmojiGroup[]>([])
const loading = ref(false)
const loadFailed = ref(false)
const query = ref('')

// The same handful of emoji do most of the work in any chat, and they're
// scattered across nine categories otherwise.
const recent = ref<string[]>(readRecent())

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

function rememberRecent(char: string) {
  recent.value = [char, ...recent.value.filter((c) => c !== char)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
  } catch {
    /* private mode — recents are a convenience, never worth an error */
  }
}

async function ensureData() {
  if (groups.value.length || loading.value) return
  loading.value = true
  loadFailed.value = false
  try {
    const mod = await import('@/lib/emojiData')
    groups.value = mod.EMOJI_GROUPS
  } catch {
    loadFailed.value = true
  }
  loading.value = false
}

watch(open, (isOpen) => {
  if (!isOpen) return
  query.value = ''
  void ensureData()
  // Reopening should start at the top, not wherever the last hunt ended.
  void nextTick(() => sheetEl.value?.closest('.bs-sheet')?.scrollTo({ top: 0 }))
})

const nameOf = new Map<string, string>()
watch(groups, (gs) => {
  for (const g of gs) for (const e of g.emoji) nameOf.set(e[0], e[1])
})

/** Recents are stored as bare characters, so pair them back up with names. */
const recentEntries = computed<EmojiEntry[]>(() =>
  recent.value.map((c) => [c, nameOf.get(c) ?? '', ''] as const),
)

const trimmed = computed(() => query.value.trim().toLowerCase())

/**
 * Search runs over the name plus the leftover tags the generator kept. Names
 * that START with the query rank first, so "sm" leads with "smile" rather
 * than with everything tagged smile.
 */
const results = computed<EmojiEntry[]>(() => {
  const q = trimmed.value
  if (!q) return []
  const leading: EmojiEntry[] = []
  const rest: EmojiEntry[] = []
  for (const group of groups.value) {
    for (const entry of group.emoji) {
      if (entry[1].startsWith(q)) leading.push(entry)
      else if (entry[1].includes(q) || entry[2].includes(q)) rest.push(entry)
    }
  }
  return leading.concat(rest)
})

function choose(char: string) {
  hapticTap('light')
  rememberRecent(char)
  emit('pick', char)
  open.value = false
}

/**
 * Laying out all 1,849 cells at once measured at ~2.5s on a DESKTOP (mostly
 * per-glyph font matching), so every group is `content-visibility: auto` and
 * the browser skips the ones off screen. The cost of that is it needs a size
 * for what it skipped, and a flat guess makes the scrollbar lie — a uniform
 * 320px put the sheet's scrollHeight at 3,194px against a real 11,852px, so
 * the list would appear to grow under your thumb the whole way down.
 *
 * Eight columns is the phone case (a 430px sheet fits exactly eight 44px
 * cells); the `auto` keyword replaces this with the real measurement once a
 * group has been on screen, so a wider window self-corrects.
 */
function sizeHint(count: number): string {
  return `auto ${Math.ceil(count / 8) * 50 + 26}px`
}

// --- Jumping to a category ---------------------------------------------
// Nine groups and 1,800-odd emoji is a long scroll; the chips are how you
// cross it. Manual scrollTop rather than scrollIntoView so the landing
// clears the sticky search bar instead of hiding under it.

const sheetEl = ref<HTMLElement | null>(null)
const sectionEls = ref<Record<string, HTMLElement | null>>({})

function setSection(label: string, el: unknown) {
  sectionEls.value[label] = (el as HTMLElement) ?? null
}

function jumpTo(label: string) {
  const scroller = sheetEl.value?.closest('.bs-sheet') as HTMLElement | null
  const target = sectionEls.value[label]
  const head = headEl.value
  if (!scroller || !target) return
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  scroller.scrollTo({ top: scroller.scrollTop + delta - (head?.offsetHeight ?? 0) })
}

const headEl = ref<HTMLElement | null>(null)
</script>

<template>
  <BottomSheet v-model:open="open" :title="props.title ?? 'Emoji'">
    <div ref="sheetEl" class="emoji-body">
      <div ref="headEl" class="sticky-head">
        <input
          v-model="query"
          class="search"
          type="search"
          placeholder="Search: heart, thumbs up, party…"
          aria-label="Search emoji"
        />
        <div v-if="!trimmed && groups.length" class="jump-row">
          <button
            v-for="g in groups"
            :key="g.label"
            class="jump-chip"
            type="button"
            @click="jumpTo(g.label)"
          >
            {{ g.emoji[0]?.[0] }}
          </button>
        </div>
      </div>

      <p v-if="loading" class="muted state">Loading emoji…</p>
      <p v-else-if="loadFailed" class="state failed">Couldn't load emoji.</p>

      <!-- Search results: one flat grid, best matches first. -->
      <section
        v-else-if="trimmed"
        class="group"
        :style="{ containIntrinsicSize: sizeHint(results.length) }"
      >
        <div v-if="results.length" class="grid">
          <button
            v-for="e in results"
            :key="e[0]"
            class="cell"
            type="button"
            :title="e[1]"
            :aria-label="e[1]"
            @click="choose(e[0])"
          >
            {{ e[0] }}
          </button>
        </div>
        <p v-else class="muted state">Nothing called “{{ query }}” in here.</p>
      </section>

      <template v-else>
        <section
          v-if="recentEntries.length"
          class="group"
          :style="{ containIntrinsicSize: sizeHint(recentEntries.length) }"
        >
          <h3 class="group-heading">Recent</h3>
          <div class="grid">
            <button
              v-for="e in recentEntries"
              :key="e[0]"
              class="cell"
              type="button"
              :title="e[1]"
              :aria-label="e[1]"
              @click="choose(e[0])"
            >
              {{ e[0] }}
            </button>
          </div>
        </section>

        <section
          v-for="g in groups"
          :key="g.label"
          :ref="(el) => setSection(g.label, el)"
          class="group"
          :style="{ containIntrinsicSize: sizeHint(g.emoji.length) }"
        >
          <h3 class="group-heading">{{ g.label }}</h3>
          <div class="grid">
            <button
              v-for="e in g.emoji"
              :key="e[0]"
              class="cell"
              type="button"
              :title="e[1]"
              :aria-label="e[1]"
              @click="choose(e[0])"
            >
              {{ e[0] }}
            </button>
          </div>
        </section>
      </template>
    </div>
  </BottomSheet>
</template>

<style scoped>
/* The sheet itself is the scroller (BottomSheet is a flex column with
   overflow-y: auto), so this stays in flow and overflows it — which is what
   the sticky bar below pins against. NO `min-height: 0` here: as a flex item
   that lets the browser compress the whole picker down to the sheet's height
   instead of letting it scroll (measured: scrollHeight collapsed to 633px
   with 1,849 cells inside it). */
.emoji-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.sticky-head {
  position: sticky;
  /* Clears the sheet's own top padding so rows don't peek out above. */
  top: -0.5rem;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0 0.4rem;
  margin-top: -0.5rem;
  background: var(--surface);
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

.jump-row {
  display: flex;
  gap: 0.25rem;
}

.jump-chip {
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 1.05rem;
  line-height: 1;
  cursor: pointer;
}

.jump-chip:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

/* See sizeHint(): laying every cell out at once is seconds of work, so the
   browser skips the groups that aren't on screen. The per-group size estimate
   rides in as an inline style. */
.group {
  content-visibility: auto;
  contain-intrinsic-size: auto 800px;
}

.group-heading {
  margin: 0 0 0.4rem;
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 0.15rem;
}

.cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  /* Emoji only — the app's chosen font has no say here, and a font stack
     that lacks colour glyphs would render these as outlines. */
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', sans-serif;
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.cell:hover,
.cell:focus-visible {
  background: var(--surface-2);
  outline: none;
}

.cell:active {
  transform: scale(0.9);
}

.state {
  margin: 0;
  padding: 0.6rem 0.2rem;
  font-size: 0.9rem;
}

.failed {
  color: var(--danger);
}
</style>
