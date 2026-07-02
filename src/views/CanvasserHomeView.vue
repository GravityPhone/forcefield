<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <AppShell title="My Turf">
    <div class="card">
      <h3>Welcome, {{ auth.profile?.display_name || auth.profile?.username }} 👋</h3>
      <p class="muted">
        This is your canvassing home screen. Coming next: the map of your assigned turf with
        color-coded pins, talk mode for logging knocks, street &amp; person lookup, and your
        leaderboard standing.
      </p>
    </div>
  </AppShell>
</template>
