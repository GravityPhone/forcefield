import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './auth'
import { applyThemeTokens, getTheme, THEMES } from '@/lib/themes'
import type { ThemeDefinition } from '@/lib/themes'
import type { ThemeId } from '@/types'

/** Local-only paint cache so the right scheme shows before the profile
 * round-trip resolves (avoids a flash of the default light theme). The
 * account's own `profiles.theme` column is still the source of truth —
 * this is purely cosmetic and never the only place a scheme lives. */
const PAINT_CACHE_KEY = 'forcefield.theme_paint_cache'

interface ThemeState {
  current: ThemeId
}

export const useThemeStore = defineStore('theme', {
  state: (): ThemeState => ({
    current: 'light',
  }),

  getters: {
    all: (): ThemeDefinition[] => THEMES,
    currentTheme(state): ThemeDefinition {
      return getTheme(state.current)
    },
  },

  actions: {
    /** Paints a cached scheme immediately, before the profile has loaded —
     * call once at app startup. */
    paintFromCache() {
      const cached = localStorage.getItem(PAINT_CACHE_KEY)
      this.apply(getTheme(cached))
    },

    apply(theme: ThemeDefinition) {
      this.current = theme.id
      applyThemeTokens(theme.tokens)
      localStorage.setItem(PAINT_CACHE_KEY, theme.id)
    },

    /** Called whenever the logged-in profile changes (login, logout,
     * initial load) to sync the painted scheme to that account's saved
     * choice. */
    loadForProfile(scheme: ThemeId | null | undefined) {
      this.apply(getTheme(scheme))
    },

    async setScheme(id: ThemeId) {
      this.apply(getTheme(id))
      const auth = useAuthStore()
      if (!auth.profile) return
      await supabase.auth.getSession() // refresh-token race guard, same as chat sends
      const { error } = await supabase
        .from('profiles')
        .update({ theme: { scheme: id }, updated_at: new Date().toISOString() })
        .eq('id', auth.profile.id)
      if (!error) auth.profile.theme = { scheme: id }
    },
  },
})
