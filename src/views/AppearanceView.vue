<script setup lang="ts">
import { ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { useThemeStore } from '@/stores/theme'
import type { ThemeId } from '@/types'

const theme = useThemeStore()
const saving = ref<ThemeId | null>(null)

async function pick(id: ThemeId) {
  if (saving.value) return
  saving.value = id
  await theme.setScheme(id)
  saving.value = null
}
</script>

<template>
  <AppShell title="Appearance">
    <p class="muted intro">
      Purely cosmetic — pick a color scheme for your own account. The knock-outcome buttons, the
      Hunt-mode outcome grid, and map pins always keep their own colors so they stay readable no
      matter what you choose.
    </p>
    <div class="grid">
      <button
        v-for="t in theme.all"
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
  </AppShell>
</template>

<style scoped>
.intro {
  margin-bottom: 1rem;
  max-width: 640px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
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
  height: 80px;
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
</style>
