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
  <router-view v-if="auth.ready || !auth.isLoggedIn" />
  <div v-else class="page" style="text-align: center; padding-top: 4rem">
    <p class="muted">Loading…</p>
  </div>
</template>
