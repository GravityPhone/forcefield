import { defineStore } from 'pinia'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { usernameToEmail } from '@/lib/config'
import type { AppRole, Profile } from '@/types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  ready: boolean
}

/** Where each role lands after login. Campaign managers get the full
 * dashboard (the old admin home); admins land on role management — their
 * job is roles/teams/campaign oversight, not day-to-day team controls. */
export function roleHome(role: AppRole): string {
  switch (role) {
    case 'admin':
      return '/admin/roles'
    case 'campaign_manager':
      return '/admin'
    default:
      // Squad leaders and canvassers share the same home: the canvass screen.
      return '/canvass'
  }
}

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'Wrong username or password.'
  if (m.includes('already registered')) return 'That username is taken.'
  if (m.includes('rate limit'))
    return 'Supabase is still requiring email confirmation, which blocks username-only signups. Turn off "Confirm email" in Supabase Auth settings.'
  if (m.includes('email not confirmed'))
    return 'This account is waiting on confirmation. Ask your admin to enable auto-confirm in Supabase (Auth → Sign In / Up → turn off "Confirm email").'
  return message
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    session: null,
    profile: null,
    loading: false,
    ready: false,
  }),

  getters: {
    isLoggedIn: (s) => !!s.session,
    role: (s): AppRole | null => s.profile?.role ?? null,
    username: (s) => s.profile?.username ?? null,
  },

  actions: {
    /** Called once at startup: restore session and subscribe to auth changes. */
    async init() {
      const { data } = await supabase.auth.getSession()
      this.session = data.session
      if (this.session) await this.fetchProfile()
      this.ready = true

      supabase.auth.onAuthStateChange((_event, session) => {
        this.session = session
        if (!session) this.profile = null
      })
    },

    async fetchProfile() {
      if (!this.session) return
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', this.session.user.id)
        .single()
      if (error) {
        // Schema not applied yet or profile missing — treat as logged out rather than trapping the user.
        console.error('Failed to load profile:', error.message)
        this.profile = null
        return
      }
      this.profile = data as Profile
    },

    async signUp(username: string, password: string): Promise<{ error?: string }> {
      this.loading = true
      try {
        const { data, error } = await supabase.auth.signUp({
          email: usernameToEmail(username),
          password,
          options: { data: { username: username.trim().toLowerCase() } },
        })
        if (error) return { error: friendlyAuthError(error.message) }
        // With email confirmation disabled (demo mode) a session comes back immediately.
        if (!data.session) {
          return {
            error:
              'Account created, but Supabase is still requiring email confirmation. Turn off "Confirm email" in Supabase Auth settings, then log in.',
          }
        }
        this.session = data.session
        await this.fetchProfile()
        if (!this.profile) {
          return { error: 'Signed up, but no profile was created — has the database schema been applied?' }
        }
        return {}
      } finally {
        this.loading = false
      }
    },

    async logIn(username: string, password: string): Promise<{ error?: string }> {
      this.loading = true
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: usernameToEmail(username),
          password,
        })
        if (error) return { error: friendlyAuthError(error.message) }
        this.session = data.session
        await this.fetchProfile()
        if (!this.profile) {
          await supabase.auth.signOut()
          this.session = null
          return { error: 'Logged in, but no profile found — has the database schema been applied?' }
        }
        return {}
      } finally {
        this.loading = false
      }
    },

    async logOut() {
      await supabase.auth.signOut()
      this.session = null
      this.profile = null
    },
  },
})
