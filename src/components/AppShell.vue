<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore, roleHome } from '@/stores/auth'
import { ROLE_LABELS } from '@/types'
import EdgeScrollbar from '@/components/EdgeScrollbar.vue'

defineProps<{ title?: string }>()

const auth = useAuthStore()
const router = useRouter()

const homePath = computed(() => (auth.profile ? roleHome(auth.profile.role) : '/'))

async function handleLogout() {
  await auth.logOut()
  router.push('/')
}

// --- Nav tabs scroll hints: the tab row scrolls sideways on narrow screens
// (see .admin-nav below) but gave no sign there was more off to the side —
// these arrows appear only on whichever edge still has more to scroll to. ---

const navEl = ref<HTMLElement | null>(null)
const canScrollNavLeft = ref(false)
const canScrollNavRight = ref(false)
let navResizeObserver: ResizeObserver | null = null

function updateNavScrollHints() {
  const el = navEl.value
  if (!el) return
  const maxScroll = el.scrollWidth - el.clientWidth
  canScrollNavLeft.value = el.scrollLeft > 2
  canScrollNavRight.value = el.scrollLeft < maxScroll - 2
}

onMounted(() => {
  void nextTick(updateNavScrollHints)
  if (navEl.value) {
    navResizeObserver = new ResizeObserver(updateNavScrollHints)
    navResizeObserver.observe(navEl.value)
  }
  window.addEventListener('resize', updateNavScrollHints)
})

onUnmounted(() => {
  navResizeObserver?.disconnect()
  window.removeEventListener('resize', updateNavScrollHints)
})
</script>

<template>
  <div class="shell">
    <EdgeScrollbar />
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
    <div v-if="auth.profile" class="admin-nav-wrap">
      <nav ref="navEl" class="admin-nav" @scroll="updateNavScrollHints">
        <template v-if="auth.profile.role === 'admin'">
          <router-link to="/admin">Dashboard</router-link>
          <!-- Admins often go out canvassing themselves, not just manage the org. -->
          <router-link to="/canvass">Canvass</router-link>
          <router-link to="/admin/chat">AI Chat</router-link>
          <router-link to="/admin/settings">Settings</router-link>
        </template>
        <router-link v-else :to="homePath">Home</router-link>
        <router-link to="/chat">Chat</router-link>
        <router-link to="/bulletin">Bulletin</router-link>
        <router-link to="/leaderboard">Leaderboard</router-link>
        <router-link to="/appearance">Appearance</router-link>
      </nav>
      <span v-if="canScrollNavLeft" class="nav-scroll-hint nav-scroll-hint-left" aria-hidden="true">‹</span>
      <span v-if="canScrollNavRight" class="nav-scroll-hint nav-scroll-hint-right" aria-hidden="true">›</span>
    </div>

    <main class="shell-main">
      <div class="page page-wide">
        <h1 v-if="title" class="page-title">{{ title }}</h1>
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
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-nav-wrap {
  position: relative;
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
  /* Six links don't fit a narrow phone — let the row scroll sideways
   * instead of wrapping or squeezing. */
  overflow-x: auto;
  scrollbar-width: none;
}

/* Fades hint that the row scrolls even before the chevron catches the eye,
 * and stops the last visible link's text looking abruptly cut off. */
.admin-nav-wrap::before,
.admin-nav-wrap::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 1px;
  width: 1.75rem;
  pointer-events: none;
  z-index: 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.admin-nav-wrap::before {
  left: 0;
  background: linear-gradient(90deg, var(--surface), transparent);
}

.admin-nav-wrap::after {
  right: 0;
  background: linear-gradient(270deg, var(--surface), transparent);
}

.admin-nav-wrap:has(.nav-scroll-hint-left)::before,
.admin-nav-wrap:has(.nav-scroll-hint-right)::after {
  opacity: 1;
}

.nav-scroll-hint {
  position: absolute;
  top: 0;
  bottom: 1px;
  display: flex;
  align-items: center;
  width: 1.5rem;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-muted);
  pointer-events: none;
  z-index: 2;
}

.nav-scroll-hint-left {
  left: 0;
  justify-content: flex-start;
}

.nav-scroll-hint-right {
  right: 0;
  justify-content: flex-end;
}

.admin-nav::-webkit-scrollbar {
  display: none;
}

.admin-nav a {
  padding: 0.6rem 0.9rem;
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  flex-shrink: 0;
  transition: color 0.12s ease;
}

.admin-nav a:hover {
  color: var(--text);
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
