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

    // Team activity feed — today's signatures/knocks live, plus milestone
    // moments (personal, squad, whole-team). Every role can watch.
    { path: '/activity', name: 'activity', component: () => import('@/views/ActivityFeedView.vue'), meta: { roles: [] } },

    // Per-account cosmetic color scheme — every role can set their own.
    { path: '/appearance', name: 'appearance', component: () => import('@/views/AppearanceView.vue'), meta: { roles: [] } },

    // "About me" — self-written bio bits plus the optional teammates-can-call
    // phone number. Identity content, deliberately separate from the purely
    // cosmetic /appearance page.
    { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { roles: [] } },

    // Team roster — everyone browses their OWN team (org roster ≠ team
    // roster); admins have no team, so they pick one to browse instead.
    // Tapping a member opens their page: intro, and recent knocks.
    { path: '/roster', name: 'roster', component: () => import('@/views/RosterView.vue'), meta: { roles: [] } },
    { path: '/member/:id', name: 'member', component: () => import('@/views/MemberView.vue'), meta: { roles: [] } },

    // Your own knock history — "where did I already look?" The roster shows
    // everyone else; this is the self view, searchable and grouped by day.
    { path: '/history', name: 'history', component: () => import('@/views/MyKnocksView.vue'), meta: { roles: [] } },

    // Old squad-leader home — leads canvass like everyone else now, and turf
    // splitting lives on the Squad page. Kept only for stale bookmarks.
    { path: '/team', redirect: '/canvass' },

    // Turf cutting/assignment — a campaign-manager job. Squad leaders get
    // the same page as a scoped sub-cutter (sub-turfs inside turf assigned to
    // them). A plain canvasser can reach it too, but only cuts when their
    // squad has no leader/manager to do it — the page shows everyone else a
    // read-only notice, and RLS enforces the same rule server-side.
    { path: '/turf', name: 'turf', component: () => import('@/views/TurfView.vue'), meta: { roles: [] } },

    // Management area. Campaign managers run the day-to-day (dashboard, AI
    // chat, settings) and manage non-admin roles/placement on /admin/roles;
    // true admins additionally manage admins and org-wide oversight.
    { path: '/admin', name: 'admin', component: () => import('@/views/AdminHomeView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/analytics', name: 'admin-analytics', component: () => import('@/views/AdminAnalyticsView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/chat', name: 'admin-chat', component: () => import('@/views/AdminChatView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/settings', name: 'admin-settings', component: () => import('@/views/AdminSettingsView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/campaigns', name: 'admin-campaigns', component: () => import('@/views/AdminCampaignsView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    // Role management — was "/admin/users" until the roster took over the
    // browse-people job (2026-07-12); this page is purely role/team/squad
    // placement now. Old path kept as a redirect for stale bookmarks.
    { path: '/admin/roles', name: 'admin-roles', component: () => import('@/views/AdminRolesView.vue'), meta: { roles: ['campaign_manager', 'admin'] } },
    { path: '/admin/users', redirect: '/admin/roles' },

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
