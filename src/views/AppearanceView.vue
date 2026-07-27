<script setup lang="ts">
import { computed, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { useThemeStore } from '@/stores/theme'
import { FONT_STACKS, TEXT_SCALES } from '@/lib/themes'
import type { ThemeGroup } from '@/lib/themes'
import { PATTERNS } from '@/lib/patterns'
import type { PatternDef } from '@/lib/patterns'
import type { DisplayPrefs, FontId, ThemeId } from '@/types'

const theme = useThemeStore()
const saving = ref<ThemeId | null>(null)

async function pick(id: ThemeId) {
  if (saving.value) return
  saving.value = id
  await theme.setScheme(id)
  saving.value = null
}

// --- Scheme groups ---

// Labels only — the swatch under each name is the description (2026-07-25,
// user call: "the high visibility doesn't need to be explained").
const THEME_GROUPS: { id: ThemeGroup; label: string }[] = [
  { id: 'day', label: 'Daylight' },
  { id: 'hiviz', label: 'High visibility' },
  { id: 'night', label: 'Dark & night' },
  { id: 'retro', label: 'Retro' },
]

const groupedThemes = computed(() =>
  THEME_GROUPS.map((g) => ({ ...g, themes: theme.all.filter((t) => t.group === g.id) })),
)

// --- Display prefs (text size, contrast, patterns, …) ---

/** Applies instantly (repaint is synchronous); the store serializes the
 * profile writes behind the scenes, so rapid taps all stick. */
function setPrefs(patch: Partial<DisplayPrefs>) {
  void theme.setPrefs(patch)
}

// Order = sans, then serif, then the three novelty faces. Matches FONT_STACKS.
const FONT_CHOICES: { id: FontId; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'grotesque', label: 'Grotesque' },
  { id: 'geometric', label: 'Geometric' },
  { id: 'condensed', label: 'Condensed' },
  { id: 'legible', label: 'Legible' },
  { id: 'serif', label: 'Serif' },
  { id: 'slab', label: 'Slab' },
  { id: 'mono', label: 'Typewriter' },
  { id: 'marker', label: 'Marker' },
  { id: 'poster', label: 'Poster' },
]

/** Each row wears the face it names and sets a house number in it. */
const fontOptions = computed(() =>
  FONT_CHOICES.map((f) => ({
    value: f.id,
    label: f.label,
    hint: '123 Walnut St',
    style: { fontFamily: FONT_STACKS[f.id] },
  })),
)

const fontPick = computed({
  get: () => theme.prefs.font,
  set: (id: string) => setPrefs({ font: id as FontId }),
})

const CORNER_CHOICES: { id: DisplayPrefs['corners']; label: string }[] = [
  { id: 'theme', label: 'Scheme default' },
  { id: 'sharp', label: 'Sharp' },
  { id: 'round', label: 'Extra round' },
]

/** Pattern tiles are drawn for full-screen use — halve them so a preview
 * card shows a meaningful slice of the motif. */
function previewSize(size: string): string {
  return size.replace(/(\d+(?:\.\d+)?)px/g, (_, n: string) => `${Number(n) / 2}px`)
}

/** Same mask the live layer uses, but inked much stronger so the tiny
 * preview reads at a glance. */
function previewCss(p: PatternDef, layer: 'a' | 'b'): string {
  const l = p[layer]
  if (!l) return ''
  const ink =
    layer === 'a'
      ? 'color-mix(in srgb, var(--accent) 55%, transparent)'
      : 'color-mix(in srgb, var(--text) 45%, transparent)'
  const size = previewSize(l.size)
  return (
    `background:${ink};` +
    `-webkit-mask-image:${l.mask};mask-image:${l.mask};` +
    `-webkit-mask-size:${size};mask-size:${size};` +
    `-webkit-mask-repeat:repeat;mask-repeat:repeat;`
  )
}
</script>

<template>
  <AppShell title="Appearance">
    <!-- ============ Color scheme ============ -->
    <section v-for="group in groupedThemes" :key="group.id" class="scheme-group" data-help="appearance-schemes">
      <h3 class="group-heading">{{ group.label }}</h3>
      <div class="grid">
        <button
          v-for="t in group.themes"
          :key="t.id"
          class="swatch-card"
          :class="{ active: theme.current === t.id }"
          :disabled="saving !== null"
          @click="pick(t.id)"
        >
          <span
            class="swatch"
            :style="{
              background: t.tokens.bg,
              borderColor: t.tokens.border,
            }"
          >
            <span class="swatch-surface" :style="{ background: t.tokens.surface }">
              <span class="swatch-accent" :style="{ background: t.tokens.accent }"></span>
              <span class="swatch-text" :style="{ background: t.tokens.text }"></span>
            </span>
          </span>
          <span class="swatch-label">
            {{ t.label }}
            <span v-if="theme.current === t.id" class="badge">Active</span>
            <span v-else-if="saving === t.id" class="muted small">Saving…</span>
          </span>
        </button>
      </div>
    </section>

    <!-- ============ Background ============ -->
    <h2 class="section-heading">Background</h2>
    <div class="pattern-grid" data-help="appearance-patterns">
      <button
        v-for="p in PATTERNS"
        :key="p.id"
        class="pattern-card"
        :class="{ active: theme.prefs.pattern === p.id }"
        @click="setPrefs({ pattern: p.id })"
      >
        <span class="pattern-preview" aria-hidden="true">
          <span v-if="p.a" class="pattern-layer" :style="previewCss(p, 'a')"></span>
          <span v-if="p.b" class="pattern-layer" :style="previewCss(p, 'b')"></span>
          <span v-if="!p.a && !p.b" class="pattern-none">None</span>
        </span>
        <span class="pattern-label">
          {{ p.label }}
          <span v-if="theme.prefs.pattern === p.id" class="badge">On</span>
        </span>
      </button>
    </div>
    <div v-if="theme.prefs.pattern !== 'none'" class="pref-block">
      <span class="pref-title">Pattern strength</span>
      <div class="seg">
        <button
          class="seg-btn"
          :class="{ active: !theme.prefs.patternBold }"
          @click="setPrefs({ patternBold: false })"
        >
          Subtle
        </button>
        <button
          class="seg-btn"
          :class="{ active: theme.prefs.patternBold }"
          @click="setPrefs({ patternBold: true })"
        >
          Bold
        </button>
      </div>
    </div>

    <!-- ============ Text & readability ============ -->
    <h2 class="section-heading">Text &amp; readability</h2>

    <div class="pref-block" data-help="appearance-text">
      <span class="pref-title">Text size</span>
      <div class="seg size-seg">
        <button
          v-for="s in TEXT_SCALES"
          :key="s.value"
          class="seg-btn size-btn"
          :class="{ active: theme.prefs.textScale === s.value }"
          @click="setPrefs({ textScale: s.value })"
        >
          <span class="size-a" :style="{ fontSize: `${s.value * 1.15}rem` }">A</span>
          <span class="seg-sub">{{ s.label }}</span>
        </button>
      </div>
    </div>

    <!-- A dropdown whose every row renders in the face it names, plus a house
         number as the specimen (addresses are what this app mostly sets).
         It was a grid of specimen cards between 2026-07-25 and 2026-07-27,
         because a NATIVE <select> hands its menu to the OS on a phone and so
         can't show a face at all. AppSelect is Reka, i.e. real DOM rows we
         style ourselves, which is what makes a dropdown viable here.
         Opening the menu is also the only moment the bundled faces download,
         which is later than the grid managed: it pulled all eight on page
         load. -->
    <div class="pref-block" data-help="appearance-font">
      <span class="pref-title">Font</span>
      <AppSelect
        v-model="fontPick"
        :options="fontOptions"
        aria-label="Font"
        :style="{ fontFamily: FONT_STACKS[theme.prefs.font] }"
      />
    </div>

    <button
      class="switch-row"
      data-help="appearance-sunlight"
      role="switch"
      :aria-checked="theme.prefs.sunlight"
      @click="setPrefs({ sunlight: !theme.prefs.sunlight })"
    >
      <span class="switch-title">Sunlight boost</span>
      <span class="switch" aria-hidden="true"></span>
    </button>

    <button
      class="switch-row"
      role="switch"
      :aria-checked="theme.prefs.bold"
      @click="setPrefs({ bold: !theme.prefs.bold })"
    >
      <span class="switch-title">Bold text</span>
      <span class="switch" aria-hidden="true"></span>
    </button>

    <!-- ============ Layout ============ -->
    <h2 class="section-heading">Layout</h2>

    <div class="pref-block">
      <span class="pref-title">Corners</span>
      <div class="seg">
        <button
          v-for="c in CORNER_CHOICES"
          :key="c.id"
          class="seg-btn"
          :class="{ active: theme.prefs.corners === c.id }"
          @click="setPrefs({ corners: c.id })"
        >
          {{ c.label }}
        </button>
      </div>
    </div>

    <!-- ============ Emoji & color moved ============ -->
    <router-link class="moved-note" to="/profile">
      <span class="moved-emoji" aria-hidden="true">🙂🎨</span>
      <span class="moved-title">My emoji &amp; color</span>
      <span class="muted moved-chevron" aria-hidden="true">›</span>
    </router-link>
  </AppShell>
</template>

<style scoped>
/* --- Scheme groups --- */

.scheme-group + .scheme-group {
  margin-top: 1.3rem;
}

.group-heading {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.9rem;
}

.swatch-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: var(--text);
  overflow: hidden;
  text-align: left;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.swatch-card:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  transform: translateY(-1px);
}

.swatch-card:disabled {
  cursor: default;
  opacity: 0.85;
}

.swatch-card.active {
  border-color: var(--accent);
}

.swatch {
  display: flex;
  align-items: flex-end;
  padding: 0.6rem;
  height: 72px;
  border-bottom: 1px solid var(--border);
}

.swatch-surface {
  width: 100%;
  border-radius: 6px;
  padding: 0.4rem;
  display: flex;
  gap: 0.3rem;
  align-items: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

.swatch-accent,
.swatch-text {
  width: 14px;
  height: 14px;
  border-radius: 50%;
}

.swatch-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.7rem 0.7rem;
  font-weight: 600;
  font-size: 0.92rem;
}

.small {
  font-size: 0.75rem;
  font-weight: 500;
}

/* --- Section headings --- */

.section-heading {
  margin: 1.8rem 0 0.4rem;
  font-size: 1.15rem;
}

/* --- Background flair --- */

.pattern-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 0.6rem;
}

.pattern-grid.busy {
  opacity: 0.75;
}

.pattern-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: var(--text);
  overflow: hidden;
  text-align: left;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.pattern-card:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  transform: translateY(-1px);
}

.pattern-card.active {
  border-color: var(--accent);
}

.pattern-preview {
  position: relative;
  display: block;
  height: 62px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.pattern-layer {
  position: absolute;
  inset: 0;
}

.pattern-none {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 1.3rem;
  font-weight: 700;
}

.pattern-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem;
  padding: 0 0.55rem 0.55rem;
  font-weight: 600;
  font-size: 0.85rem;
}

/* --- Segmented controls --- */

.pref-block {
  margin-top: 1rem;
}

.pref-title {
  display: block;
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 0.45rem;
}

.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.seg-btn {
  flex: 1 1 auto;
  min-height: 48px;
  padding: 0.45rem 0.8rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font: inherit;
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.seg-btn:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.seg-btn.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
}

/* Text-size buttons: the A grows with the option so you can see the jump
 * before committing. */
.size-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 0.1rem;
  min-height: 62px;
  padding: 0.4rem 0.55rem 0.5rem;
}

.size-a {
  font-weight: 800;
  line-height: 1;
}

.seg-sub {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
}

.seg-btn.active .seg-sub {
  color: var(--text);
}

/* --- Switch rows --- */

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  width: 100%;
  max-width: 640px;
  margin-top: 0.7rem;
  padding: 0.8rem 0.9rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font: inherit;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.switch-row:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.switch-title {
  min-width: 0;
  font-weight: 700;
  font-size: 1rem;
}

.switch {
  position: relative;
  flex-shrink: 0;
  width: 52px;
  height: 30px;
  border-radius: 999px;
  border: 2px solid var(--border);
  background: var(--surface-2);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: transform 0.15s ease, background 0.15s ease;
}

.switch-row[aria-checked='true'] .switch {
  background: var(--accent);
  border-color: var(--accent);
}

.switch-row[aria-checked='true'] .switch::after {
  transform: translateX(22px);
  background: var(--accent-contrast);
}

/* --- Emoji & color moved note --- */

.moved-note {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: 640px;
  margin-top: 1.6rem;
  padding: 0.8rem 0.9rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  transition: border-color 0.12s ease;
}

.moved-note:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.moved-emoji {
  font-size: 1.4rem;
  flex-shrink: 0;
}

.moved-title {
  flex: 1;
  min-width: 0;
  font-weight: 700;
}

.moved-chevron {
  font-size: 1.3rem;
  flex-shrink: 0;
}
</style>
