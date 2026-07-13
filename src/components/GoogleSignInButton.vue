<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Optional alternative to username/password — shared by Log In and Sign Up.
// On success the OAuth redirect leaves the page; errors surface via emit.
const emit = defineEmits<{ error: [message: string] }>()

const auth = useAuthStore()
const busy = ref(false)

async function go() {
  busy.value = true
  const result = await auth.signInWithGoogle()
  if (result.error) {
    busy.value = false
    emit('error', result.error)
  }
}
</script>

<template>
  <div class="or-divider" role="separator"><span>or</span></div>
  <button class="btn btn-block google-btn" type="button" :disabled="busy" @click="go">
    <svg class="g-logo" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
    {{ busy ? 'Opening Google…' : 'Continue with Google' }}
  </button>
</template>

<style scoped>
.or-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0;
  color: var(--text-muted, inherit);
  font-size: 0.85rem;
}

.or-divider::before,
.or-divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border, currentColor);
  opacity: 0.5;
}

/* Google's branding wants a neutral button regardless of app theme. */
.google-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  background: #fff;
  color: #1f1f1f;
  border: 1px solid #dadce0;
}

.google-btn:hover:not(:disabled) {
  background: #f7f8f8;
}

.g-logo {
  flex: none;
}
</style>
