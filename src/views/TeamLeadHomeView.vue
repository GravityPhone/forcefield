<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'
</script>

<template>
  <AppShell title="Team Overview">
    <div class="card">
      <h3>Turf Assignment</h3>
      <p class="muted">Sweep street ranges on the map into turf for squads or canvassers.</p>
      <router-link class="btn btn-primary btn-sm" to="/turf">Cut turf</router-link>
    </div>
    <div class="card" style="margin-top: 1rem">
      <h3>Squad Leader dashboard</h3>
      <p class="muted">Coming soon: your squad's progress and canvasser-level detail.</p>
    </div>
  </AppShell>
</template>
