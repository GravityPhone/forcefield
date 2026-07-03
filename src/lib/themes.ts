import type { ThemeId } from '@/types'

/** Every cosmetic design token a scheme controls. Deliberately excludes
 * anything outcome-related (see lib/outcomes.ts) — those colors are fixed
 * regardless of scheme so knock buttons, the Hunt indicator grid, and map
 * pins always mean the same thing. */
export interface ThemeTokens {
  bg: string
  surface: string
  surface2: string
  text: string
  textMuted: string
  border: string
  accent: string
  accentContrast: string
  danger: string
  success: string
  warning: string
  shadow: string
  radius: string
}

export interface ThemeDefinition {
  id: ThemeId
  label: string
  /** Picked as the base for vue-advanced-chat's built-in light/dark preset,
   * so untouched details (scrollbars, audio-recorder icons, etc.) still
   * read sensibly instead of defaulting to a jarring light chrome. */
  dark: boolean
  tokens: ThemeTokens
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'light',
    label: 'Light',
    dark: false,
    tokens: {
      bg: '#f5f6fa',
      surface: '#ffffff',
      surface2: '#eef0f6',
      text: '#1a1d29',
      textMuted: '#6b7080',
      border: '#dde0ea',
      accent: '#2f6fed',
      accentContrast: '#ffffff',
      danger: '#d64545',
      success: '#2e9e5b',
      warning: '#e0a02e',
      shadow: '0 1px 3px rgba(20, 24, 40, 0.08), 0 4px 16px rgba(20, 24, 40, 0.06)',
      radius: '12px',
    },
  },
  {
    id: 'dark',
    label: 'Dark',
    dark: true,
    tokens: {
      bg: '#14161f',
      surface: '#1c1f2b',
      surface2: '#262a3a',
      text: '#eef0f8',
      textMuted: '#9aa0b4',
      border: '#333850',
      accent: '#5b8cff',
      accentContrast: '#0b0e18',
      danger: '#ff6b6b',
      success: '#4ade80',
      warning: '#fbbf24',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3)',
      radius: '12px',
    },
  },
  {
    id: 'highContrast',
    label: 'High Contrast',
    dark: true,
    tokens: {
      bg: '#000000',
      surface: '#000000',
      surface2: '#111111',
      text: '#ffffff',
      textMuted: '#e6e6e6',
      border: '#ffff00',
      accent: '#ffff00',
      accentContrast: '#000000',
      danger: '#ff4d4d',
      success: '#33ff33',
      warning: '#ffb000',
      shadow: 'none',
      radius: '4px',
    },
  },
  {
    id: 'eighties',
    label: '80s Synthwave',
    dark: true,
    tokens: {
      bg: '#1a0b2e',
      surface: '#241242',
      surface2: '#2f1a54',
      text: '#f5e6ff',
      textMuted: '#c9a6e8',
      border: '#6b2fb3',
      accent: '#ff2e88',
      accentContrast: '#1a0b2e',
      danger: '#ff4d6d',
      success: '#00e6b8',
      warning: '#ffd23f',
      shadow: '0 0 12px rgba(255, 46, 136, 0.45), 0 0 28px rgba(0, 230, 184, 0.2)',
      radius: '12px',
    },
  },
  {
    id: 'nineties',
    label: '90s Desktop',
    dark: false,
    tokens: {
      bg: '#c0c0c0',
      surface: '#ffffff',
      surface2: '#d4d4d4',
      text: '#000000',
      textMuted: '#4a4a4a',
      border: '#808080',
      accent: '#008080',
      accentContrast: '#ffffff',
      danger: '#800000',
      success: '#006400',
      warning: '#cc9900',
      shadow: '2px 2px 0 rgba(0, 0, 0, 0.35)',
      radius: '2px',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    dark: false,
    tokens: {
      bg: '#f1f4ec',
      surface: '#ffffff',
      surface2: '#e4ead9',
      text: '#24321f',
      textMuted: '#5f7355',
      border: '#c8d3bb',
      accent: '#3f7d3a',
      accentContrast: '#ffffff',
      danger: '#b3441f',
      success: '#2e9e5b',
      warning: '#c58a1f',
      shadow: '0 1px 3px rgba(30, 40, 20, 0.1), 0 4px 16px rgba(30, 40, 20, 0.08)',
      radius: '12px',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    dark: false,
    tokens: {
      bg: '#eaf6f8',
      surface: '#ffffff',
      surface2: '#d8eef2',
      text: '#0b2733',
      textMuted: '#4c7480',
      border: '#bfe1e8',
      accent: '#0e88a8',
      accentContrast: '#ffffff',
      danger: '#c94c4c',
      success: '#1f9e78',
      warning: '#d69a1f',
      shadow: '0 1px 3px rgba(10, 40, 50, 0.1), 0 4px 16px rgba(10, 40, 50, 0.08)',
      radius: '12px',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    dark: false,
    tokens: {
      bg: '#fff3ea',
      surface: '#fffaf5',
      surface2: '#ffe4cf',
      text: '#3a1f16',
      textMuted: '#8a5a45',
      border: '#ffcfa8',
      accent: '#ff6b3d',
      accentContrast: '#fffaf5',
      danger: '#d1495b',
      success: '#2e9e6c',
      warning: '#e0932e',
      shadow: '0 1px 3px rgba(60, 30, 10, 0.1), 0 4px 16px rgba(60, 30, 10, 0.08)',
      radius: '12px',
    },
  },
  {
    id: 'solarized',
    label: 'Solarized',
    dark: true,
    tokens: {
      bg: '#002b36',
      surface: '#073642',
      surface2: '#0b3d4a',
      text: '#eee8d5',
      textMuted: '#93a1a1',
      border: '#0d4854',
      accent: '#268bd2',
      accentContrast: '#002b36',
      danger: '#dc322f',
      success: '#859900',
      warning: '#b58900',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.35), 0 4px 16px rgba(0, 0, 0, 0.25)',
      radius: '8px',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    dark: true,
    tokens: {
      bg: '#05060a',
      surface: '#0d0f1a',
      surface2: '#141726',
      text: '#dfe3f5',
      textMuted: '#8890ab',
      border: '#232840',
      accent: '#7c8cff',
      accentContrast: '#05060a',
      danger: '#ff5c7a',
      success: '#34d399',
      warning: '#f5c451',
      shadow: '0 1px 3px rgba(0, 0, 0, 0.5), 0 6px 20px rgba(0, 0, 0, 0.35)',
      radius: '12px',
    },
  },
]

const THEME_MAP: Record<ThemeId, ThemeDefinition> = Object.fromEntries(
  THEMES.map((t) => [t.id, t]),
) as Record<ThemeId, ThemeDefinition>

export function getTheme(id: string | null | undefined): ThemeDefinition {
  return (id && THEME_MAP[id as ThemeId]) || THEME_MAP.light
}

const CSS_VAR_NAMES: Record<keyof ThemeTokens, string> = {
  bg: '--bg',
  surface: '--surface',
  surface2: '--surface-2',
  text: '--text',
  textMuted: '--text-muted',
  border: '--border',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  danger: '--danger',
  success: '--success',
  warning: '--warning',
  shadow: '--shadow',
  radius: '--radius',
}

/** Paints the chosen scheme's tokens onto :root. Everything in style.css and
 * every component already reads these CSS variables, so this one call
 * reskins the whole app except the deliberately-fixed outcome colors. */
export function applyThemeTokens(tokens: ThemeTokens) {
  const root = document.documentElement.style
  for (const key of Object.keys(CSS_VAR_NAMES) as (keyof ThemeTokens)[]) {
    root.setProperty(CSS_VAR_NAMES[key], tokens[key])
  }
}

/** Translates our tokens into vue-advanced-chat's `styles` prop shape so the
 * user-to-user chat UI matches the chosen scheme too. The library fills in
 * anything we don't set from its own light/dark preset (see `dark` below),
 * so this only needs the fields that would otherwise clash. */
export function vacStyles(theme: ThemeDefinition) {
  const t = theme.tokens
  const meBg = `color-mix(in srgb, ${t.accent} 22%, ${t.surface})`
  return {
    general: {
      color: t.text,
      colorButtonClear: t.accent,
      colorButton: t.accentContrast,
      backgroundColorButton: t.accent,
      backgroundInput: t.surface,
      colorPlaceholder: t.textMuted,
      colorCaret: t.accent,
      borderStyle: `1px solid ${t.border}`,
      backgroundScrollIcon: t.surface,
    },
    container: {
      border: `1px solid ${t.border}`,
      boxShadow: 'none',
    },
    header: {
      background: t.surface,
      colorRoomName: t.text,
      colorRoomInfo: t.textMuted,
    },
    footer: {
      background: t.surface2,
      borderStyleInput: `1px solid ${t.border}`,
      borderInputSelected: t.accent,
      backgroundReply: t.surface2,
      backgroundTagActive: t.surface2,
      backgroundTag: t.surface2,
    },
    content: {
      background: t.bg,
    },
    sidemenu: {
      background: t.surface,
      backgroundHover: t.surface2,
      backgroundActive: t.surface2,
      colorActive: t.accent,
      borderColorSearch: t.border,
    },
    dropdown: {
      background: t.surface,
      backgroundHover: t.surface2,
    },
    message: {
      background: t.surface2,
      backgroundMe: meBg,
      color: t.text,
      colorStarted: t.textMuted,
      colorUsername: t.textMuted,
      colorTimestamp: t.textMuted,
      backgroundDate: t.surface2,
      colorDate: t.textMuted,
      backgroundSystem: t.surface2,
      colorSystem: t.textMuted,
    },
    room: {
      colorUsername: t.text,
      colorMessage: t.textMuted,
      colorTimestamp: t.textMuted,
    },
  }
}
