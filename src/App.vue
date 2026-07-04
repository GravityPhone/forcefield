<script setup lang="ts">
import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

const auth = useAuthStore()
const theme = useThemeStore()

theme.paintFromCache()
watch(
  () => auth.profile?.theme.scheme,
  (scheme) => theme.loadForProfile(scheme),
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
</style>
