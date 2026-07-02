<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore, roleHome } from '@/stores/auth'
import { ROLE_LABELS } from '@/types'

defineProps<{ title: string }>()

const auth = useAuthStore()
const router = useRouter()

const homePath = computed(() => (auth.profile ? roleHome(auth.profile.role) : '/'))

async function handleLogout() {
  await auth.logOut()
  router.push('/')
}
</script>

<template>
  <div class="shell">
    <header class="shell-header">
      <div class="shell-header-inner">
        <div class="brand">
          <span class="brand-mark">⚡</span>
          <span class="brand-name">Forcefield</span>
        </div>
        <div class="user-area" v-if="auth.profile">
          <span class="badge">{{ ROLE_LABELS[auth.profile.role] }}</span>
          <span class="username">{{ auth.profile.username }}</span>
          <button class="btn btn-ghost btn-sm" @click="handleLogout">Log out</button>
        </div>
      </div>
    </header>

    <!-- AI Chat stays admin-only; the user-to-user Chat link is for everyone. -->
    <nav v-if="auth.profile" class="admin-nav">
      <template v-if="auth.profile.role === 'admin'">
        <router-link to="/admin">Dashboard</router-link>
        <router-link to="/admin/chat">AI Chat</router-link>
        <router-link to="/admin/settings">Settings</router-link>
      </template>
      <router-link v-else :to="homePath">Home</router-link>
      <router-link to="/chat">Chat</router-link>
    </nav>

    <main class="shell-main">
      <div class="page page-wide">
        <h1 class="page-title">{{ title }}</h1>
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
}

.shell-header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.shell-header-inner {
  max-width: 860px;
  margin: 0 auto;
  padding: 0.7rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 800;
  font-size: 1.05rem;
}

.user-area {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.username {
  font-weight: 600;
  font-size: 0.92rem;
}

.btn-sm {
  min-height: 36px;
  padding: 0.35rem 0.8rem;
  font-size: 0.85rem;
}

.admin-nav {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 0.25rem;
  padding: 0 1.25rem;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
}

.admin-nav a {
  padding: 0.6rem 0.9rem;
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
}

.admin-nav a.router-link-exact-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.shell-main {
  flex: 1;
}

.page-title {
  margin-bottom: 1rem;
}
</style>
