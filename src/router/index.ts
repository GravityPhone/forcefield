import { createRouter, createWebHistory } from 'vue-router'
import type { AppRole } from '@/types'
import { useAuthStore, roleHome } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    /** Roles allowed to visit. Omit = public. Empty array = any logged-in user. */
    roles?: AppRole[]
    guestOnly?: boolean
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'landing', component: () => import('@/views/LandingView.vue'), meta: { guestOnly: true } },
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { guestOnly: true } },
    { path: '/signup', name: 'signup', component: () => import('@/views/SignUpView.vue'), meta: { guestOnly: true } },

    // Canvasser home
    { path: '/canvass', name: 'canvass', component: () => import('@/views/CanvasserHomeView.vue'), meta: { roles: [] } },

    // User-to-user chat (everyone) — distinct from the admin-only AI chat
    { path: '/chat', name: 'chat', component: () => import('@/views/ChatView.vue'), meta: { roles: [] } },

    // Campaign bulletin (everyone reads; admins post) and leaderboards
    { path: '/bulletin', name: 'bulletin', component: () => import('@/views/BulletinView.vue'), meta: { roles: [] } },
    { path: '/leaderboard', name: 'leaderboard', component: () => import('@/views/LeaderboardView.vue'), meta: { roles: [] } },

    // Team lead home (admins can view too)
    { path: '/team', name: 'team', component: () => import('@/views/TeamLeadHomeView.vue'), meta: { roles: ['team_lead', 'admin'] } },

    // Admin area
    { path: '/admin', name: 'admin', component: () => import('@/views/AdminHomeView.vue'), meta: { roles: ['admin'] } },
    { path: '/admin/chat', name: 'admin-chat', component: () => import('@/views/AdminChatView.vue'), meta: { roles: ['admin'] } },
    { path: '/admin/settings', name: 'admin-settings', component: () => import('@/views/AdminSettingsView.vue'), meta: { roles: ['admin'] } },

    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.init()

  const loggedIn = auth.isLoggedIn && !!auth.profile

  if (to.meta.guestOnly && loggedIn) {
    return roleHome(auth.profile!.role)
  }

  if (to.meta.roles) {
    if (!loggedIn) return { path: '/login', query: { redirect: to.fullPath } }
    if (to.meta.roles.length > 0 && !to.meta.roles.includes(auth.profile!.role)) {
      return roleHome(auth.profile!.role)
    }
  }
})

export default router
