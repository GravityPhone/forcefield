<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore, roleHome } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')
const error = ref('')

const USERNAME_RE = /^[a-z0-9_-]{3,20}$/

async function submit() {
  error.value = ''
  const name = username.value.trim().toLowerCase()
  if (!USERNAME_RE.test(name)) {
    error.value = 'Username must be 3–20 characters: letters, numbers, _ or -.'
    return
  }
  if (password.value.length < 10) {
    error.value = 'Password must be at least 10 characters.'
    return
  }
  const result = await auth.signUp(name, password.value)
  if (result.error) {
    error.value = result.error
    return
  }
  router.push(roleHome(auth.profile!.role))
}
</script>

<template>
  <div class="auth-page">
    <div class="card auth-card">
      <h2>Sign Up</h2>
      <p class="muted intro">New accounts start as Canvasser. An admin can change your role later.</p>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <form @submit.prevent="submit">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" v-model="username" autocomplete="username" autocapitalize="none" autofocus />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" v-model="password" type="password" autocomplete="new-password" />
        </div>
        <button class="btn btn-primary btn-block" type="submit" :disabled="auth.loading">
          {{ auth.loading ? 'Creating account…' : 'Create Account' }}
        </button>
      </form>
      <p class="muted swap-link">
        Already have an account? <router-link to="/login">Log in</router-link>
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

.intro {
  margin: 0 0 1rem;
  font-size: 0.92rem;
}

.swap-link {
  margin: 1rem 0 0;
  text-align: center;
  font-size: 0.92rem;
}
</style>
