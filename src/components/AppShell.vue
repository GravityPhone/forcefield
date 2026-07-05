<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore, roleHome } from '@/stores/auth'
import { ROLE_LABELS } from '@/types'
import AppLogo from '@/components/AppLogo.vue'
import EdgeScrollbar from '@/components/EdgeScrollbar.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import ChatDrawer from '@/components/chat/ChatDrawer.vue'
import { hapticTap } from '@/lib/native'

defineProps<{ title?: string }>()

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const homePath = computed(() => (auth.profile ? roleHome(auth.profile.role) : '/'))

async function handleLogout() {
  moreOpen.value = false
  await auth.logOut()
  router.push('/')
}

// --- Phone navigation: a native-style bottom tab bar (the constantly-used
// destinations sit in thumb reach) plus a "More" sheet for the rest. The
// desktop/tablet top tab row is unchanged — it only shows ≥768px, the bar
// only below. Same links either way, nothing gains or loses access. ---

interface NavItem {
  to: string
  label: string
  icon: keyof typeof ICONS
}

const barItems = computed<NavItem[]>(() => {
  if (!auth.profile) return []
  // Chat is deliberately NOT a tab — it lives in the pull-out drawer
  // (ChatDrawer), reachable from every screen via the right-edge handle.
  // Admins get oversight tabs only; campaign managers run the day-to-day
  // and hold what used to be the admin nav.
  if (auth.profile.role === 'admin') {
    return [
      { to: '/admin/users', label: 'Users', icon: 'squads' },
      { to: '/admin/campaigns', label: 'Campaigns', icon: 'dashboard' },
      { to: '/bulletin', label: 'Bulletin', icon: 'bulletin' },
      { to: '/leaderboard', label: 'Boards', icon: 'trophy' },
    ]
  }
  if (auth.profile.role === 'campaign_manager') {
    return [
      { to: '/admin', label: 'Dashboard', icon: 'dashboard' },
      { to: '/canvass', label: 'Canvass', icon: 'pin' },
      { to: '/squads', label: 'Squads', icon: 'squads' },
      { to: '/leaderboard', label: 'Boards', icon: 'trophy' },
    ]
  }
  return [
    { to: homePath.value, label: 'Home', icon: 'home' },
    { to: '/squads', label: 'Squads', icon: 'squads' },
    { to: '/bulletin', label: 'Bulletin', icon: 'bulletin' },
    { to: '/leaderboard', label: 'Boards', icon: 'trophy' },
  ]
})

const moreItems = computed<NavItem[]>(() => {
  if (!auth.profile) return []
  const appearance: NavItem = { to: '/appearance', label: 'Appearance', icon: 'palette' }
  if (auth.profile.role === 'admin') {
    return [{ to: '/squads', label: 'Squads', icon: 'squads' }, appearance]
  }
  if (auth.profile.role === 'campaign_manager') {
    return [
      { to: '/admin/chat', label: 'AI Chat', icon: 'sparkle' },
      { to: '/turf', label: 'Turf', icon: 'map' },
      { to: '/bulletin', label: 'Bulletin', icon: 'bulletin' },
      appearance,
      { to: '/admin/settings', label: 'Settings', icon: 'sliders' },
    ]
  }
  if (auth.profile.role === 'team_lead') {
    return [{ to: '/turf', label: 'Turf', icon: 'map' }, appearance]
  }
  return [appearance]
})

const moreOpen = ref(false)
const moreActive = computed(() => moreItems.value.some((i) => route.path === i.to))

function goFromSheet(to: string) {
  moreOpen.value = false
  hapticTap('light')
  void router.push(to)
}

// Simple 24px stroke glyphs, drawn inline so no icon library ships in the
// bundle. currentColor everywhere = they follow the theme automatically.
const ICONS = {
  home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
  dashboard: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  pin: '<path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/>',
  squads: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.5 3.5 0 0 1 0 6.6M17.5 14.5a6.5 6.5 0 0 1 4 5.5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4"/><path d="M12 13v3M8 20h8M10 20v-2h4v2"/>',
  bulletin: '<rect x="4" y="4" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5M12 18v2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3 3 0 0 0 3-3 9 9 0 0 0-8-11z"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  map: '<path d="M9 4l6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>',
  sliders: '<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/>',
  more: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
  logout: '<path d="M14 4h-8a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h11M18 8.5L21.5 12 18 15.5"/>',
} as const

// --- Nav tabs scroll hints (desktop top row): the tab row scrolls sideways
// on narrow-ish screens but gave no sign there was more off to the side —
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
          <AppLogo class="brand-mark" size="1.25em" />
          <span class="brand-name">Forcefield</span>
        </div>
        <div class="user-area" v-if="auth.profile">
          <span class="badge">{{ ROLE_LABELS[auth.profile.role] }}</span>
          <span class="username">{{ auth.profile.username }}</span>
          <button class="btn btn-ghost btn-sm logout-top" @click="handleLogout">Log out</button>
        </div>
      </div>
    </header>

    <!-- Desktop/tablet top tabs. AI Chat stays admin-only; the user-to-user
         Chat link is for everyone. -->
    <div v-if="auth.profile" class="admin-nav-wrap">
      <nav ref="navEl" class="admin-nav" @scroll="updateNavScrollHints">
        <template v-if="auth.profile.role === 'admin'">
          <router-link to="/admin/users">Users</router-link>
          <router-link to="/admin/campaigns">Campaigns</router-link>
        </template>
        <template v-else-if="auth.profile.role === 'campaign_manager'">
          <router-link to="/admin">Dashboard</router-link>
          <!-- Managers go out canvassing themselves, not just run the org. -->
          <router-link to="/canvass">Canvass</router-link>
          <router-link to="/turf">Turf</router-link>
          <router-link to="/admin/chat">AI Chat</router-link>
          <router-link to="/admin/settings">Settings</router-link>
        </template>
        <router-link v-else :to="homePath">Home</router-link>
        <router-link v-if="auth.profile.role === 'team_lead'" to="/turf">Turf</router-link>
        <router-link to="/squads">Squads</router-link>
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

    <!-- User-to-user chat: a pull-out drawer on every screen, not a route.
         The right-edge handle opens it; the handle drags up/down to wherever
         the thumb likes. -->
    <ChatDrawer />

    <!-- Phone bottom tab bar -->
    <nav v-if="auth.profile" class="tab-bar" aria-label="Primary">
      <router-link
        v-for="item in barItems"
        :key="item.to"
        :to="item.to"
        class="tab-item"
        @click="hapticTap('light')"
      >
        <span class="tab-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS[item.icon]"></svg>
        </span>
        <span class="tab-label">{{ item.label }}</span>
      </router-link>
      <button
        class="tab-item"
        :class="{ 'router-link-active': moreActive }"
        :aria-expanded="moreOpen"
        @click="moreOpen = true"
      >
        <span class="tab-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS.more"></svg>
        </span>
        <span class="tab-label">More</span>
      </button>
    </nav>

    <BottomSheet v-model:open="moreOpen" title="More" aria-label="More navigation">
      <nav class="more-list" aria-label="Secondary">
        <button
          v-for="item in moreItems"
          :key="item.to"
          class="more-row"
          :class="{ active: route.path === item.to }"
          @click="goFromSheet(item.to)"
        >
          <span class="more-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS[item.icon]"></svg>
          </span>
          <span>{{ item.label }}</span>
        </button>
        <button class="more-row more-logout" @click="handleLogout">
          <span class="more-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="ICONS.logout"></svg>
          </span>
          <span>Log out</span>
        </button>
      </nav>
    </BottomSheet>
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
  /* Under the native shells (viewport-fit=cover) the page extends behind the
   * status bar / notch — keep the header's surface there but push its content
   * clear of it. No-op in a regular browser tab (inset is 0). */
  padding-top: env(safe-area-inset-top, 0px);
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

.brand-mark {
  color: var(--accent);
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

/* --- Bottom tab bar (phones) --- */

.tab-bar {
  display: none;
}

@media (max-width: 767px) {
  /* Top row hands over to the bottom bar on phones. */
  .admin-nav-wrap {
    display: none;
  }

  .logout-top {
    display: none; /* lives in the More sheet on phones */
  }

  .shell-main {
    /* Keep the last content clear of the fixed bar. */
    padding-bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
  }

  .tab-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 40;
    display: flex;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 0.3rem 0.25rem calc(0.3rem + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.08);
  }
}

.tab-item {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  padding: 0.25rem 0;
  min-height: 52px;
  justify-content: center;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--text-muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3.2rem;
  height: 1.9rem;
  border-radius: 999px;
  transition: background 0.15s ease;
}

.tab-icon svg {
  width: 22px;
  height: 22px;
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.tab-item.router-link-active {
  color: var(--accent);
}

.tab-item.router-link-active .tab-icon {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.tab-item:active .tab-icon {
  background: var(--surface-2);
}

/* --- More sheet rows --- */

.more-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.more-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-height: 54px;
  padding: 0.6rem 0.9rem;
  border: none;
  background: var(--surface);
  font: inherit;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.more-row:hover {
  background: var(--surface-2);
}

.more-row + .more-row {
  border-top: 1px solid var(--border);
}

.more-row.active {
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  color: var(--accent);
}

.more-icon {
  display: flex;
  flex-shrink: 0;
  color: var(--text-muted);
}

.more-row.active .more-icon {
  color: var(--accent);
}

.more-icon svg {
  width: 22px;
  height: 22px;
}

.more-logout {
  color: var(--danger);
}

.more-logout .more-icon {
  color: var(--danger);
}
</style>
