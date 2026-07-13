<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore, roleHome } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const error = ref('')

async function submit() {
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = 'Enter your username and password.'
    return
  }
  const result = await auth.logIn(username.value, password.value)
  if (result.error) {
    error.value = result.error
    return
  }
  // Only honor an in-app path (single leading slash, no scheme, no protocol-
  // relative "//host") so ?redirect= can't bounce to an external site.
  const raw = route.query.redirect
  const redirect = typeof raw === 'string' && /^\/(?!\/)/.test(raw) ? raw : null
  router.push(redirect ?? roleHome(auth.profile!.role))
}
</script>

<template>
  <div class="auth-page">
    <div class="card auth-card">
      <h2>Log In</h2>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <form @submit.prevent="submit">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" v-model="username" autocomplete="username" autocapitalize="none" autofocus />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" v-model="password" type="password" autocomplete="current-password" />
        </div>
        <button class="btn btn-primary btn-block" type="submit" :disabled="auth.loading">
          {{ auth.loading ? 'Logging in…' : 'Log In' }}
        </button>
      </form>
      <p class="muted swap-link">
        No account yet? <router-link to="/signup">Sign up</router-link>
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 1.5rem;
}

.auth-card {
  width: 100%;
  max-width: 380px;
}

.swap-link {
  margin: 1rem 0 0;
  text-align: center;
  font-size: 0.92rem;
}
</style>
