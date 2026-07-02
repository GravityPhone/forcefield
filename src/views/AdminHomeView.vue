<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'
</script>

<template>
  <AppShell title="Admin Dashboard">
    <div class="grid">
      <div class="card">
        <h3>Users &amp; Roles</h3>
        <p class="muted">Manage accounts, elevate roles, create admins. Coming soon.</p>
      </div>
      <div class="card">
        <h3>Turf Assignment</h3>
        <p class="muted">Assign street ranges to teams and canvassers. Coming soon.</p>
      </div>
      <div class="card">
        <h3>Voter Data Import</h3>
        <p class="muted">Import a county voter-roll CSV, filtered by city. Coming soon.</p>
      </div>
      <div class="card">
        <h3>Leaderboards</h3>
        <p class="muted">Configure ranking metrics for the org. Coming soon.</p>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}
</style>
