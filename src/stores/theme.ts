import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './auth'
import {
  applyDisplayPrefs,
  applyThemeTokens,
  getTheme,
  normalizeThemeSettings,
  sunlightTokens,
  DEFAULT_PREFS,
  THEMES,
} from '@/lib/themes'
import type { ThemeDefinition } from '@/lib/themes'
import type { DisplayPrefs, ThemeId, ThemeSettings } from '@/types'

/** Local-only paint cache so the right scheme + prefs show before the
 * profile round-trip resolves (avoids a flash of the default light theme).
 * The account's own `profiles.theme` column is still the source of truth —
 * this is purely cosmetic and never the only place the settings live. */
const PAINT_CACHE_KEY = 'forcefield.theme_paint_cache'

/** Saves chain instead of overlapping, so two quick taps can't race their
 * profile writes into the wrong final state. Only the LAST queued save in a
 * burst actually writes (it snapshots settingsJson when it runs, which by
 * then holds every tap), so ten quick taps cost one network round-trip. */
let persistChain: Promise<void> = Promise.resolve()
let pendingSaves = 0

interface ThemeState {
  current: ThemeId
  prefs: DisplayPrefs
}

export const useThemeStore = defineStore('theme', {
  state: (): ThemeState => ({
    current: 'light',
    prefs: { ...DEFAULT_PREFS },
  }),

  getters: {
    all: (): ThemeDefinition[] => THEMES,
    currentTheme(state): ThemeDefinition {
      return getTheme(state.current)
    },
    /** The exact jsonb shape written to profiles.theme (and the cache). */
    settingsJson(state): ThemeSettings {
      return { scheme: state.current, ...state.prefs }
    },
  },

  actions: {
    /** Repaints scheme tokens + display prefs onto :root and refreshes the
     * paint cache. Every state change funnels through here. */
    repaint() {
      const theme = getTheme(this.current)
      const tokens = this.prefs.sunlight ? sunlightTokens(theme.tokens) : theme.tokens
      applyThemeTokens(tokens)
      applyDisplayPrefs(this.prefs, tokens)
      localStorage.setItem(PAINT_CACHE_KEY, JSON.stringify(this.settingsJson))
    },

    /** Paints cached settings immediately, before the profile has loaded —
     * call once at app startup. */
    paintFromCache() {
      const cached = localStorage.getItem(PAINT_CACHE_KEY)
      let raw: unknown
      try {
        raw = cached ? JSON.parse(cached) : null
      } catch {
        raw = { scheme: cached } // pre-prefs cache held a bare scheme id
      }
      this.load(raw)
    },

    load(raw: unknown) {
      const { scheme, prefs } = normalizeThemeSettings(raw)
      this.current = scheme
      this.prefs = prefs
      this.repaint()
    },

    /** Called whenever the logged-in profile changes (login, initial load)
     * to sync the painted settings to that account's saved choices. While
     * saves are still queued, the local store is ahead of whatever the
     * profile object says (e.g. a stale refetch racing the write) — ignore
     * those, the pending save carries the newer state. */
    loadForProfile(settings: ThemeSettings | null | undefined) {
      if (pendingSaves > 0) return
      this.load(settings)
    },

    async setScheme(id: ThemeId) {
      this.current = id
      this.repaint()
      await this.queuePersist()
    },

    async setPrefs(patch: Partial<DisplayPrefs>) {
      Object.assign(this.prefs, patch)
      this.repaint()
      await this.queuePersist()
    },

    queuePersist(): Promise<void> {
      pendingSaves++
      persistChain = persistChain
        .then(async () => {
          try {
            // A newer save is already queued behind this one — let it do the
            // (single) write instead.
            if (pendingSaves === 1) await this.persist()
          } finally {
            pendingSaves--
          }
        })
        .catch(() => {})
      return persistChain
    },

    async persist() {
      const auth = useAuthStore()
      if (!auth.profile) return
      const settings = this.settingsJson
      await supabase.auth.getSession() // refresh-token race guard, same as chat sends
      const { error } = await supabase
        .from('profiles')
        .update({ theme: settings, updated_at: new Date().toISOString() })
        .eq('id', auth.profile.id)
      if (!error) auth.profile.theme = settings
    },
  },
})
