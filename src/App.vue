<script setup lang="ts">
import { computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { KEPT_PAGES, NEVER_KEPT } from '@/lib/pageState'

const auth = useAuthStore()
const theme = useThemeStore()

// Keying the cache on WHO is signed in is how it gets emptied: changing a
// KeepAlive's key unmounts it, and every page it was holding goes with it.
// There is no other way to clear one — it exposes no API — and a cache of
// rendered pages surviving a log out would hand the next person a screenful of
// the last one's crew, knocks and messages.
const cacheOwner = computed(() => auth.profile?.id ?? 'guest')

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
  <!-- Every page keeps its instance, most-recently-used first (src/lib/
       pageState.ts explains why this is the whole mechanism). ONE keep-alive
       that is always mounted, deliberately: wrapping only some routes in it
       would unmount the cache itself the moment you visited an unwrapped one,
       taking every page it held with it. Which routes opt out is `exclude`. -->
  <router-view v-if="auth.ready || !auth.isLoggedIn" v-slot="{ Component }">
    <keep-alive :key="cacheOwner" :max="KEPT_PAGES" :exclude="NEVER_KEPT">
      <component :is="Component" />
    </keep-alive>
  </router-view>
  <div v-else class="app-loading">
    <span class="spinner" aria-hidden="true"></span>
    <p class="muted">Loading…</p>
  </div>

  <!-- Desktop only: labels the column down the middle of the window. Lives
       here rather than in AppShell so the landing and login screens carry it
       too, and teleports to <body> so it sits beside #app's box rather than
       inside its overflow clip. Hidden below 820px, where the app is
       full-bleed and the question doesn't come up (style.css, the frame
       block).

       A LABEL, not an explanation (2026-07-26, user call — "it just has to
       say phone app demo"): the column is self-evidently a phone once you
       see it, and the standing no-sub-copy rule applies to the chrome around
       the app as much as to the screens inside it. -->
  <Teleport to="body">
    <aside class="frame-note">
      <span class="frame-note-tag">Phone app demo</span>
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
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text) 45%, var(--bg));
  }
}
</style>
