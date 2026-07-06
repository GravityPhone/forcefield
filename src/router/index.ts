import { createRouter, createWebHistory } from 'vue-router'
import type { AppRole } from '@/types'
import { useAuthStore, roleHome } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

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

    // User-to-user chat is no longer a page — it's the pull-out drawer on
    // every screen (ChatDrawer in AppShell). /chat survives as a deep link
    // (old bookmarks, /chat?chat=<id> squad links): a guard opens the drawer,
    // then either stays put (in-app) or falls through to the role home.
    {
      path: '/chat',
      name: 'chat',
      component: () => import('@/views/CanvasserHomeView.vue'), // never rendered — guard always redirects
      meta: { roles: [] },
      beforeEnter: (to, from) => {
        useChatStore().openDrawer(typeof to.query.chat === 'string' ? to.query.chat : undefined)
        // In-app navigation: cancel and keep the current page under the drawer.
        if (from.matched.length) return false
        return roleHome(useAuthStore().profile?.role ?? 'canvasser')
      },
    },

    // Your squad's home base — members, turf map, live knock progress. Also
    // where canvassers/leads form or join today's crew (squads reset at
    // midnight).
    { path: '/squad', name: 'squad', component: () => import('@/views/SquadView.vue'), meta: { roles: [] } },

    // Roster management across ALL of today's squads — the campaign-manager
    // assignment interface. Everyone else lands on their own squad instead
    // (old /squads bookmarks included).
    {
      path: '/squads',
      name: 'squads',
      component: () => import('@/views/SquadsView.vue'),
      // roles stays [] so the global guard lets everyone through to this
      // redirect (it runs before per-route beforeEnter and would bounce
      // non-managers to their role home instead of /squad).
      meta: { roles: [] },
      beforeEnter: () => {
        const role = useAuthStore().profile?.role
        if (role === 'canvasser' || role === 'team_lead') return '/squad'
        return true
      },
    },

    // Campaign bulletin (everyone reads; admins post) and leaderboards
    { path: '/bulletin', name: 'bulletin', component: () => import('@/views/BulletinView.vue'), meta: { roles: [] } },
    { path: '/leaderboard', name: 'leaderboard', component: () => import('@/views/LeaderboardView.vue'), meta: { roles: [] } },

    // Per-account cosmetic color scheme — every role can set their own.
    { path: '/appearance', name: 'appearance', component: () => import('@/views/AppearanceView.vue'), meta: { roles: [] } },

    // Squad leader home (managers/admins can view too)
    { path: '/team', name: 'team', component: () => import('@/views/TeamLeadHomeView.vue'), meta: { roles: ['team_lead', 'campaign_manager', 'admin'] } },

    // Turf cutting/assignment — a campaign-manager job. Squad leaders get
    // the same page as a scoped sub-cutter (sub-turfs inside turf assigned to
    // them). A plain canvasser can reach it too, but only cuts when their
    // squad has no leader/manager to do it — the page shows everyone else a
    // read-only notice, and RLS enforces the same rule server-side.
    { path: '/turf', name: 'turf', component: () => import('@/views/TurfView.vue'), meta: { roles: [] } },

    // Management area. Campaign managers run the day-to-day (dashboard, AI
    // chat, settings); true admins keep user management to themselves.
    { path: '/admin', name: 'admin', component: () => import('@/views/AdminHomeView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/chat', name: 'admin-chat', component: () => import('@/views/AdminChatView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/settings', name: 'admin-settings', component: () => import('@/views/AdminSettingsView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/campaigns', name: 'admin-campaigns', component: () => import('@/views/AdminCampaignsView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/users', name: 'admin-users', component: () => import('@/views/AdminUsersView.vue'), meta: { roles: ['admin'] } },

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
