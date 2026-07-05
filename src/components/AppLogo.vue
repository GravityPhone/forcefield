<script setup lang="ts">
// The Forcefield mark: hex shield + magnetic dipole lobes + lightning bolt.
// Draws in currentColor so it follows whatever theme accent (or text color)
// the parent sets. Size via the `size` prop or a font-size on the parent
// (defaults to 1em, so it drops in anywhere an emoji glyph used to be).
withDefaults(defineProps<{ size?: string }>(), { size: '1em' })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 96 96"
    role="img"
    aria-label="Forcefield logo"
    class="app-logo"
  >
    <g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round">
      <path d="M48,14 L77.4,31 L77.4,65 L48,82 L18.6,65 L18.6,31 Z" stroke-width="5" />
      <ellipse cx="31.5" cy="48" rx="8.5" ry="6.5" stroke-width="4" />
      <ellipse cx="64.5" cy="48" rx="8.5" ry="6.5" stroke-width="4" />
    </g>
    <path d="M53,29 L40,50 L47,50 L43,67 L57,46 L50,46 Z" fill="currentColor" />
  </svg>
</template>

<style scoped>
.app-logo {
  display: inline-block;
  vertical-align: -0.125em;
  flex-shrink: 0;
}
</style>
