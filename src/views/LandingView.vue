<script setup lang="ts">
import AppLogo from '@/components/AppLogo.vue'
</script>

<template>
  <div class="landing">
    <div class="landing-inner">
      <div class="hero">
        <div class="hero-mark"><AppLogo size="1em" /></div>
        <h1>Forcefield</h1>
        <p class="muted tagline">
          Knock doors. Log outcomes fast. See where to go next.
        </p>
      </div>
      <div class="actions">
        <router-link class="btn btn-primary btn-block" to="/login">Log In</router-link>
        <router-link class="btn btn-ghost btn-block" to="/signup">Sign Up</router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.landing {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 1.5rem;
}

.landing-inner {
  width: 100%;
  max-width: 360px;
  text-align: center;
}

.hero-mark {
  font-size: 4.5rem;
  margin-bottom: 0.5rem;
  color: var(--accent);
  line-height: 1;
}

.hero h1 {
  font-size: 2.2rem;
  letter-spacing: -0.02em;
}

.tagline {
  margin: 0.25rem 0 2.5rem;
  font-size: 1.05rem;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
