import { defineStore } from 'pinia'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { usernameToEmail } from '@/lib/config'
import { forgetPageState } from '@/lib/pageState'
import type { AppRole, Profile } from '@/types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  ready: boolean
  /** The boot request has been out longer than BOOT_TIMEOUT_MS, or failed
   * outright, and the app is waiting on a Retry tap (or on the slow request
   * finally answering). App.vue shows the message off this. */
  bootStalled: boolean
  /** A Retry is in flight. Only meaningful while bootStalled. */
  bootRetrying: boolean
}

/** How long the first profile read may take before the app says so. A phone
 * on one bar routinely needs a few seconds for a tiny select, so this is
 * deliberately generous, but with the database unreachable the request hangs
 * forever and the page stayed on its bare background with nothing on it
 * (2026-10-30, after the Supabase project came back from a pause). */
const BOOT_TIMEOUT_MS = 10_000

// Module-scope, not state: the one boot in flight, and the resolver a Retry
// tap pokes. Promises and callbacks don't belong in reactive state.
let bootPromise: Promise<void> | null = null
let wakeRetry: (() => void) | null = null

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** PostgREST hands a dead network back as an error with an EMPTY code (the
 * fetch rejection stringified into `message`), and a server still coming up
 * answers with its own PGRST2xx codes (205 "table not in schema cache" is the
 * one measured during the 2026-10-30 restart). Neither says anything about
 * this account, so neither may be read as "no profile, treat as logged out".
 * PGRST116 (zero rows) is the one that genuinely means the profile is gone. */
function serverUnreachable(error: { code?: string | null }): boolean {
  const code = error.code ?? ''
  return code === '' || (code.startsWith('PGRST2') && code !== 'PGRST116')
}

/** Where each role lands after login. Reworked 2026-07-25 (user call): the
 * /admin dashboard is the SERVER OPERATOR's screen now — where an admin
 * manages campaigns and the teams under them — so admins land there and
 * campaign managers can't reach it at all. A campaign manager runs one
 * campaign, so they open on the numbers for it. */
export function roleHome(role: AppRole): string {
  switch (role) {
    case 'admin':
      return '/admin'
    case 'campaign_manager':
      return '/admin/analytics'
    default:
      // Squad leaders and canvassers share the same home: the canvass screen.
      return '/canvass'
  }
}

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'Wrong username or password.'
  // Deliberately not "that username is taken" — a distinct message turns signup
  // into a username-existence oracle. Keep it neutral.
  if (m.includes('already registered'))
    return "Couldn't create that account. Try a different username, or log in if it's yours."
  if (m.includes('provider is not enabled'))
    return 'Google sign-in is not enabled yet. Ask your admin, or use a username and password.'
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
    bootStalled: false,
    bootRetrying: false,
  }),

  getters: {
    isLoggedIn: (s) => !!s.session,
    role: (s): AppRole | null => s.profile?.role ?? null,
    username: (s) => s.profile?.username ?? null,

    /** Signed in but hasn't picked a campaign yet — the router sends these
     * accounts to /join-campaign and lets nothing else through. New sign-ups
     * are the normal case; someone who quit the chooser last time is the
     * other, and they land right back on it. Admins are exempt: they create
     * the campaigns everyone else joins, and belong to none of them. */
    needsCampaign: (s): boolean =>
      !!s.session && !!s.profile && s.profile.role !== 'admin' && !s.profile.campaign_id,
  },

  actions: {
    /** Called once at startup: restore session and subscribe to auth changes.
     * The router awaits this before the first screen, so it does not resolve
     * until the boot has actually succeeded; a stalled or failed attempt flips
     * `bootStalled` and waits for `retryBoot()` instead of resolving with a
     * half-answer the router would read as "logged out". Safe to call more
     * than once: every caller shares the one boot in flight. */
    init(): Promise<void> {
      if (this.ready) return Promise.resolve()
      if (!bootPromise) bootPromise = this.runBoot()
      return bootPromise
    },

    async runBoot() {
      for (;;) {
        const attempt = this.bootOnce().then(
          () => 'ok' as const,
          () => 'failed' as const,
        )
        const first = await Promise.race([attempt, delay(BOOT_TIMEOUT_MS).then(() => 'slow' as const)])
        if (first === 'ok') break

        this.bootStalled = true
        this.bootRetrying = false
        const retry = new Promise<'retry'>((r) => {
          wakeRetry = () => r('retry')
        })
        // A slow request is still out there and may yet answer, so it stays in
        // the race; a failed one is over, and only a Retry can move things on.
        const next = first === 'slow' ? await Promise.race([attempt, retry]) : await retry
        wakeRetry = null
        if (next === 'ok') break
        if (next === 'retry') this.bootRetrying = true
        // 'failed' after 'slow': go straight around for another attempt.
      }
      this.bootStalled = false
      this.bootRetrying = false
      this.ready = true

      supabase.auth.onAuthStateChange((_event, session) => {
        this.session = session
        if (!session) this.profile = null
      })
    },

    /** One pass at the boot. Rejects when the server can't be reached. */
    async bootOnce() {
      const { data } = await supabase.auth.getSession()
      this.session = data.session
      if (this.session) await this.fetchProfile()
    },

    /** The Retry button. Starts another attempt if the boot is waiting on one. */
    retryBoot() {
      wakeRetry?.()
    },

    async fetchProfile() {
      if (!this.session) return
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', this.session.user.id)
        .single()
      if (error) {
        // A dead network or a server still starting up says nothing about this
        // account, and showing the login screen over it would offer a form that
        // cannot log in. Throw, and the boot shows "Can't reach the server."
        if (serverUnreachable(error)) throw new Error(error.message)
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
          return { error: 'Signed up, but no profile was created. Has the database schema been applied?' }
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
          return { error: 'Logged in, but no profile found. Has the database schema been applied?' }
        }
        return {}
      } finally {
        this.loading = false
      }
    },

    /** Optional Google sign-in: kicks off the OAuth redirect. On success the
     * browser leaves the page entirely; we only return here on failure. */
    async signInWithGoogle(): Promise<{ error?: string }> {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
      if (error) return { error: friendlyAuthError(error.message) }
      return {}
    },

    async logOut() {
      await supabase.auth.signOut()
      this.session = null
      this.profile = null
      // Where each page was scrolled to. The cached PAGES themselves go with
      // the profile id — App.vue keys the keep-alive on it — and this is the
      // one piece of that memory living outside it.
      forgetPageState()
      // Drop the offline turf copy on the way out (2026-07-26). It holds real
      // names and addresses for a few hundred doors, and once the cache became
      // automatic — no button, no Clear — signing out was the only moment left
      // that plainly means "this isn't my phone any more". Queued knocks are
      // deliberately NOT touched: an unsent knock is somebody's work.
      //
      // Imported HERE rather than at the top of the file because this store is
      // reached eagerly from the router, and offlineCache pulls in Dexie: a
      // static import put the whole IndexedDB library in the entry chunk, so
      // every visitor downloaded and parsed it before first paint to serve one
      // fire-and-forget call on the way out. The call was already unawaited, so
      // deferring the fetch of its module changes nothing about sign-out.
      void import('@/lib/offlineCache').then((m) => m.clearTurfCache())
      // Every map's stored door rows go the same way, for the same reason:
      // it's the county's addresses, and this is the moment the phone stops
      // being this person's.
      void import('@/lib/addressCache').then((m) => m.clearDoorCaches())
    },
  },
})
