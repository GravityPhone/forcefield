<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'

// Org-level setup only (2026-07-21 rework). Day-to-day controls live where
// they're used: posting on /bulletin, Board options on /leaderboard, Feed
// options on /activity, and turf cutting on the Turf tab.
</script>

<template>
  <AppShell title="Admin Dashboard">
    <div class="grid">
      <!-- Campaign managers manage all non-admin roles; true admins
           additionally manage admin accounts (the Roles screen adapts). -->
      <div class="card">
        <h3>Roles</h3>
        <p class="muted">Elevate roles, assign teams, place people in today's squads.</p>
        <router-link class="btn btn-primary btn-sm" to="/admin/roles">Manage</router-link>
      </div>

      <div class="card">
        <h3>Campaigns &amp; Teams</h3>
        <p class="muted">Create campaigns and assign teams to them.</p>
        <router-link class="btn btn-primary btn-sm" to="/admin/campaigns">Manage</router-link>
      </div>

      <div class="card">
        <h3>Voter Data Import</h3>
        <p class="muted">Import a county voter-roll CSV, filtered by city. Coming soon.</p>
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
