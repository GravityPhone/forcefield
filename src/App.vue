<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <router-view v-if="auth.ready || !auth.isLoggedIn" />
  <div v-else class="page" style="text-align: center; padding-top: 4rem">
    <p class="muted">Loading…</p>
  </div>
</template>
