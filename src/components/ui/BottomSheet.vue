<script setup lang="ts">
// The app's one modal idiom: a phone-first sheet that slides up from the
// bottom edge (matching the original hand-rolled /admin/users editor).
// Reka UI supplies the behavior — focus trap, Esc/backdrop dismissal, aria
// wiring, scroll lock — and every visual comes from the theme variables.
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

defineProps<{
  /** Header title. Omit it (and use aria-label) for a custom header slot. */
  title?: string
  ariaLabel?: string
}>()

const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="bs-backdrop" />
      <DialogContent class="bs-sheet" :aria-label="ariaLabel">
        <div class="bs-grip" aria-hidden="true"></div>
        <header class="bs-head">
          <slot name="header">
            <DialogTitle v-if="title" class="bs-title">{{ title }}</DialogTitle>
          </slot>
          <DialogClose class="bs-close" aria-label="Close">✕</DialogClose>
        </header>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.bs-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(15, 18, 30, 0.45);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.bs-backdrop[data-state='open'] {
  animation: bs-fade-in 0.18s ease;
}

.bs-backdrop[data-state='closed'] {
  animation: bs-fade-out 0.18s ease forwards;
}

.bs-sheet {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 51;
  width: min(520px, 100%);
  max-height: 88dvh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom: none;
  /* Scales with the scheme: generous curve on round themes, near-square on
   * High Contrast / 90s Desktop instead of a clashing fixed 18px. */
  border-radius: min(calc(var(--radius) * 1.5), 18px) min(calc(var(--radius) * 1.5), 18px) 0 0;
  padding: 0.5rem 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.25);
  outline: none;
}

.bs-sheet[data-state='open'] {
  animation: bs-slide-up 0.28s cubic-bezier(0.32, 0.72, 0.2, 1);
}

.bs-sheet[data-state='closed'] {
  animation: bs-slide-down 0.2s ease-in forwards;
}

.bs-grip {
  width: 40px;
  height: 4px;
  border-radius: 999px;
  background: var(--border);
  margin: 0.25rem auto 0;
  flex-shrink: 0;
}

.bs-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.bs-title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 800;
  flex: 1;
  min-width: 0;
}

/* When the header slot is custom it provides its own flex:1 body — the close
 * button always hugs the right edge either way. */
.bs-head > :first-child {
  flex: 1;
  min-width: 0;
}

.bs-close {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.9rem;
  cursor: pointer;
  flex-shrink: 0;
}

.bs-close:hover {
  color: var(--text);
}

@keyframes bs-fade-in {
  from {
    opacity: 0;
  }
}

@keyframes bs-fade-out {
  to {
    opacity: 0;
  }
}

@keyframes bs-slide-up {
  from {
    transform: translateX(-50%) translateY(100%);
  }
}

@keyframes bs-slide-down {
  to {
    transform: translateX(-50%) translateY(100%);
  }
}
</style>
