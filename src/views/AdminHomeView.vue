<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'

// The server operator's screen: managing the campaigns and the teams under
// them. ADMIN ONLY as of 2026-07-25 (user call) — a campaign manager runs one
// campaign and doesn't create them, so this route is gated to `admin` and CMs
// home to /admin/analytics instead.
//
// Roles came off this page the same day: /admin/roles is still open to
// campaign managers, so a card here would send half its audience somewhere
// they can already reach from the nav. Day-to-day controls have lived on the
// screens they affect since the 2026-07-21 rework: posting on /bulletin,
// Board options on /leaderboard, Feed options on /activity, turf on /turf.
</script>

<template>
  <AppShell title="Admin Dashboard">
    <div class="grid" data-help="admin-cards">
      <div class="card">
        <h3>Campaigns &amp; Teams</h3>
        <router-link class="btn btn-primary btn-sm" to="/admin/campaigns">Manage</router-link>
      </div>

      <div class="card">
        <h3>Voter Data Import</h3>
        <span class="badge">Coming soon</span>
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
