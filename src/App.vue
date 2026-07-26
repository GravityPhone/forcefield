<script setup lang="ts">
import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

const auth = useAuthStore()
const theme = useThemeStore()

theme.paintFromCache()
watch(
  () => auth.profile?.theme,
  // No profile yet (startup, logged out) keeps the cached paint instead of
  // flashing back to the default scheme.
  (settings) => {
    if (settings) theme.loadForProfile(settings)
  },
  { immediate: true },
)
</script>

<template>
  <router-view v-if="auth.ready || !auth.isLoggedIn" v-slot="{ Component }">
    <keep-alive include="CanvasserHomeView">
      <component :is="Component" />
    </keep-alive>
  </router-view>
  <div v-else class="app-loading">
    <span class="spinner" aria-hidden="true"></span>
    <p class="muted">Loading…</p>
  </div>

  <!-- Desktop only: says what the column down the middle of the window is.
       Lives here rather than in AppShell so the landing and login screens
       carry it too, and teleports to <body> so it sits beside #app's box
       rather than inside its overflow clip. Hidden below 820px, where the app
       is full-bleed and the question doesn't come up (style.css, the frame
       block). -->
  <Teleport to="body">
    <aside class="frame-note" aria-label="About this view">
      <span class="frame-note-tag">Phone app</span>
      <p>Forcefield is built for a phone at the door. On a desktop it runs at phone size — same screens, nothing added.</p>
    </aside>
  </Teleport>
</template>

<style scoped>
.app-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  min-height: 60dvh;
}

.app-loading p {
  margin: 0;
}

/* --- The gutter note beside the phone frame --- */

.frame-note {
  display: none;
}

@media (min-width: 820px) {
  .frame-note {
    /* Left gutter, off the frame's own tokens (style.css): the right edge
       stops a gap short of the phone's left edge, and it takes whatever the
       gutter has left. Fixed, so it stays put while the app scrolls beside
       it. */
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 1.6rem);
    right: calc(var(--frame-right) + var(--frame-w) + 1.5rem);
    max-width: min(15rem, calc(var(--frame-left) - 3rem));
    z-index: 20;
    display: block;
    color: color-mix(in srgb, var(--text) 62%, var(--bg));
    text-align: right;
  }

  .frame-note-tag {
    display: block;
    margin-bottom: 0.35rem;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text) 45%, var(--bg));
  }

  .frame-note p {
    margin: 0;
    font-size: 0.84rem;
    line-height: 1.5;
  }
}
</style>
