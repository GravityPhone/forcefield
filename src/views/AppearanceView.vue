<script setup lang="ts">
import { ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { useThemeStore } from '@/stores/theme'
import { useAuthStore } from '@/stores/auth'
import { ANIMAL_AVATARS, avatarUrl } from '@/lib/avatars'
import type { ThemeId } from '@/types'

const theme = useThemeStore()
const auth = useAuthStore()
const saving = ref<ThemeId | null>(null)

async function pick(id: ThemeId) {
  if (saving.value) return
  saving.value = id
  await theme.setScheme(id)
  saving.value = null
}

// --- Animal avatar (Fluent Emoji, shipped locally in public/avatars/) ---

const savingAvatar = ref(false)

async function pickAvatar(slug: string | null) {
  if (savingAvatar.value || !auth.profile) return
  savingAvatar.value = true
  await supabase.auth.getSession() // refresh-token race guard, same as theme saves
  const { error } = await supabase
    .from('profiles')
    .update({ avatar: slug, updated_at: new Date().toISOString() })
    .eq('id', auth.profile.id)
  if (!error) auth.profile.avatar = slug
  savingAvatar.value = false
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

    <h2 class="avatar-heading">Your avatar</h2>
    <p class="muted intro">
      Pick an animal — it shows next to your messages in chat and on member lists, so
      squadmates can spot you at a glance.
    </p>
    <div class="avatar-grid" :class="{ busy: savingAvatar }">
      <button
        v-for="slug in ANIMAL_AVATARS"
        :key="slug"
        class="avatar-cell"
        :class="{ active: auth.profile?.avatar === slug }"
        :disabled="savingAvatar"
        :aria-label="slug.replace(/_/g, ' ')"
        :title="slug.replace(/_/g, ' ')"
        @click="pickAvatar(slug)"
      >
        <img :src="avatarUrl(slug)" :alt="slug.replace(/_/g, ' ')" loading="lazy" />
      </button>
    </div>
    <button
      v-if="auth.profile?.avatar"
      class="btn btn-ghost btn-sm avatar-clear"
      :disabled="savingAvatar"
      @click="pickAvatar(null)"
    >
      Remove avatar
    </button>
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

/* --- Avatar picker --- */

.avatar-heading {
  margin: 1.6rem 0 0.4rem;
  font-size: 1.15rem;
}

.avatar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
  gap: 0.5rem;
}

.avatar-grid.busy {
  opacity: 0.7;
}

.avatar-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.4rem;
  border: 2px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.avatar-cell:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  transform: translateY(-1px);
}

.avatar-cell.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}

.avatar-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.avatar-clear {
  margin-top: 0.6rem;
}
</style>
