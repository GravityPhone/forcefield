<script setup lang="ts">
// Themed replacement for native <select>: same job, but the options render
// as a real on-brand menu with 44px touch rows instead of the OS widget.
// Reka UI handles keyboard nav, typeahead, aria, and positioning.
import { onBeforeUnmount } from 'vue'
import type { StyleValue } from 'vue'
import { pinScrollThroughLock } from '@/lib/appChrome'
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'

export interface SelectOption {
  value: string
  label: string
  /** Muted trailing text on the row — a specimen, a count, a unit. Not a
   * description: the label still has to carry the meaning on its own. */
  hint?: string
  /** Inline style for this one row. Exists so the font picker can render
   * each option in the face it names, which a native <select> cannot do on a
   * phone (it hands the whole menu to the OS). Everything in the row
   * inherits it, so `hint` is set in that face too. */
  style?: StyleValue
}

// class / aria-label / etc. land on the trigger button, the element that
// actually sits in the layout.
defineOptions({ inheritAttrs: false })

defineProps<{
  options: SelectOption[]
  /** Compact trigger (matches .btn-sm scale) for dense admin rows. */
  small?: boolean
}>()

const model = defineModel<string>({ required: true })

/**
 * Reka's SelectContent scroll-locks the body, which clamps the page offset to
 * 0 — and this menu is anchored to its TRIGGER, so on a long page the trigger
 * falls off screen and takes the open menu with it, unreachable, on a page
 * that can no longer scroll. Hold the page still across the lock instead; see
 * pinScrollThroughLock for the measurements.
 *
 * This runs on `update:open`, which Vue emits synchronously while the state
 * changes — before the render effect that mounts the content and applies the
 * lock. Capturing the offset any later would capture the clamped 0.
 */
let releasePin: (() => void) | null = null

function onOpenChange(open: boolean) {
  releasePin?.()
  releasePin = open ? pinScrollThroughLock() : null
}

// A route change can unmount this with the menu still up; the pin must not
// outlive it or the page is left fixed at a negative offset.
onBeforeUnmount(() => releasePin?.())
</script>

<template>
  <SelectRoot v-model="model" @update:open="onOpenChange">
    <SelectTrigger class="sel-trigger" :class="{ 'sel-small': small }" v-bind="$attrs">
      <SelectValue class="sel-value" />
      <svg class="sel-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="sel-menu" position="popper" :side-offset="6" align="start">
        <SelectViewport class="sel-viewport">
          <SelectItem
            v-for="o in options"
            :key="o.value"
            class="sel-item"
            :value="o.value"
            :style="o.style"
          >
            <SelectItemText>{{ o.label }}</SelectItemText>
            <span v-if="o.hint" class="sel-hint">{{ o.hint }}</span>
            <SelectItemIndicator class="sel-check">✓</SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<style scoped>
.sel-trigger {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 48px;
  padding: 0.5rem 0.8rem;
  font: inherit;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  text-align: left;
  min-width: 0;
}

.sel-trigger:hover {
  background: var(--surface-2);
}

.sel-trigger[data-state='open'] {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.sel-small {
  min-height: 40px;
  font-size: 0.88rem;
  padding: 0.4rem 0.6rem;
}

.sel-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sel-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
}
</style>

<!-- Unscoped: SelectPortal teleports this content to <body>, outside the
     component's DOM subtree, so Vue never attaches this SFC's scoped
     data-v attribute to it — scoped rules for it would silently never match. -->
<style>
.sel-menu {
  z-index: 60;
  min-width: var(--reka-select-trigger-width);
  max-height: min(var(--reka-select-content-available-height), 320px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow), 0 8px 24px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

.sel-menu[data-state='open'] {
  animation: sel-pop 0.14s ease-out;
}

.sel-viewport {
  padding: 0.25rem;
  max-height: inherit;
  overflow-y: auto;
}

.sel-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.5rem 0.7rem;
  font-size: 0.95rem;
  color: var(--text);
  border-radius: calc(var(--radius) - 4px);
  cursor: pointer;
  outline: none;
  user-select: none;
}

.sel-item[data-highlighted] {
  background: var(--surface-2);
}

.sel-item[data-state='checked'] {
  font-weight: 700;
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}

/* margin-left:auto rather than relying on the parent's space-between: auto
   margins eat the free space first, so the label stays hard left and the hint
   sits next to the checkmark whether or not a row has one. */
.sel-hint {
  margin-left: auto;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sel-check {
  color: var(--accent);
  font-weight: 800;
}

@keyframes sel-pop {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}
</style>
