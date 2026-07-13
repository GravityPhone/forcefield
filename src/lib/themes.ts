import type { DisplayPrefs, FontId, ThemeId } from '@/types'
import { getPattern, isPatternId } from '@/lib/patterns'
import type { PatternLayer } from '@/lib/patterns'

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
  /** Hunt's custom results-list scrollbar thumb — deliberately its own set
   * of knobs (not just reusing `accent`/`radius`) so each scheme can give it
   * a distinct look: pill vs. chunky vs. beveled, glowing vs. flat. */
  scrollbarColor: string
  scrollbarWidth: string
  scrollbarRadius: string
  scrollbarShadow: string
}

/** Groups the /appearance picker sorts schemes into. */
export type ThemeGroup = 'day' | 'hiviz' | 'night' | 'retro'

export interface ThemeDefinition {
  id: ThemeId
  label: string
  /** Picked as the base for vue-advanced-chat's built-in light/dark preset,
   * so untouched details (scrollbars, audio-recorder icons, etc.) still
   * read sensibly instead of defaulting to a jarring light chrome. */
  dark: boolean
  group: ThemeGroup
  tokens: ThemeTokens
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'light',
    label: 'Light',
    dark: false,
    group: 'day',
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
      scrollbarColor: '#2f6fed',
      scrollbarWidth: '18px',
      scrollbarRadius: '999px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'dark',
    label: 'Dark',
    dark: true,
    group: 'night',
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
      scrollbarColor: '#5b8cff',
      scrollbarWidth: '18px',
      scrollbarRadius: '999px',
      scrollbarShadow: '0 0 6px rgba(91, 140, 255, 0.55)',
    },
  },
  {
    id: 'highContrast',
    label: 'High Contrast Dark',
    dark: true,
    group: 'hiviz',
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
      scrollbarColor: '#ffff00',
      scrollbarWidth: '24px',
      scrollbarRadius: '0px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'highContrastLight',
    label: 'High Contrast Light',
    dark: false,
    group: 'hiviz',
    tokens: {
      // Pure black-on-white: the single most glare-proof combination there
      // is — a lit white screen stays readable in direct sun far longer
      // than any dark background.
      bg: '#ffffff',
      surface: '#ffffff',
      surface2: '#ededed',
      text: '#000000',
      textMuted: '#1f1f1f',
      border: '#000000',
      accent: '#0033cc',
      accentContrast: '#ffffff',
      danger: '#c40000',
      success: '#006e2e',
      warning: '#8a5a00',
      shadow: 'none',
      radius: '4px',
      scrollbarColor: '#000000',
      scrollbarWidth: '24px',
      scrollbarRadius: '0px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'safetyVest',
    label: 'Safety Vest',
    dark: false,
    group: 'hiviz',
    tokens: {
      // Fluorescent yellow-green + black straps, straight off a road crew.
      bg: '#e8f902',
      surface: '#f4ff54',
      surface2: '#d3e300',
      text: '#000000',
      textMuted: '#2c3000',
      border: '#000000',
      accent: '#101010',
      accentContrast: '#e8f902',
      danger: '#a30000',
      success: '#00521f',
      warning: '#6e4a00',
      shadow: 'none',
      radius: '4px',
      scrollbarColor: '#101010',
      scrollbarWidth: '24px',
      scrollbarRadius: '0px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'eighties',
    // Not "Synthwave" — that word is a 2000s invention; neon was there in '84.
    label: "'80s Neon",
    dark: true,
    group: 'retro',
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
      scrollbarColor: 'linear-gradient(180deg, #ff2e88, #00e6b8)',
      scrollbarWidth: '20px',
      scrollbarRadius: '999px',
      scrollbarShadow: '0 0 10px rgba(255, 46, 136, 0.6), 0 0 16px rgba(0, 230, 184, 0.4)',
    },
  },
  {
    id: 'nineties',
    label: '90s Desktop',
    dark: false,
    group: 'retro',
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
      scrollbarColor: '#c0c0c0',
      scrollbarWidth: '28px',
      scrollbarRadius: '0px',
      scrollbarShadow:
        'inset -2px -2px 0 rgba(0, 0, 0, 0.45), inset 2px 2px 0 rgba(255, 255, 255, 0.85)',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    dark: false,
    group: 'day',
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
      scrollbarColor: '#3f7d3a',
      scrollbarWidth: '18px',
      scrollbarRadius: '999px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    dark: false,
    group: 'day',
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
      scrollbarColor: 'linear-gradient(180deg, #0e88a8, #4cc7e0)',
      scrollbarWidth: '19px',
      scrollbarRadius: '999px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    dark: false,
    group: 'day',
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
      scrollbarColor: 'linear-gradient(180deg, #ff6b3d, #ffb23d)',
      scrollbarWidth: '19px',
      scrollbarRadius: '999px',
      scrollbarShadow: '0 0 8px rgba(255, 107, 61, 0.4)',
    },
  },
  {
    id: 'solarized',
    label: 'Solarized',
    dark: true,
    group: 'night',
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
      scrollbarColor: '#268bd2',
      scrollbarWidth: '16px',
      scrollbarRadius: '4px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    dark: true,
    group: 'night',
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
      scrollbarColor: '#7c8cff',
      scrollbarWidth: '18px',
      scrollbarRadius: '999px',
      scrollbarShadow: '0 0 8px rgba(124, 140, 255, 0.65)',
    },
  },
  {
    id: 'paperback',
    label: 'Paperback',
    dark: false,
    group: 'day',
    tokens: {
      bg: '#f2e9d8',
      surface: '#faf3e5',
      surface2: '#e9dcc3',
      text: '#33261a',
      textMuted: '#75634c',
      border: '#d6c5a4',
      accent: '#8a5a2b',
      accentContrast: '#faf3e5',
      danger: '#b3402e',
      success: '#4a7c3f',
      warning: '#a97b1c',
      shadow: '0 1px 3px rgba(70, 50, 20, 0.1), 0 4px 14px rgba(70, 50, 20, 0.08)',
      radius: '10px',
      scrollbarColor: '#8a5a2b',
      scrollbarWidth: '16px',
      scrollbarRadius: '6px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'nightVision',
    label: 'Night Vision',
    dark: true,
    group: 'night',
    tokens: {
      // Deep red-on-black: easy on dark-adapted eyes for after-sundown walks.
      bg: '#0a0304',
      surface: '#150608',
      surface2: '#200a0d',
      text: '#ff8585',
      textMuted: '#a85a5d',
      border: '#521a1e',
      accent: '#ff5c5c',
      accentContrast: '#170506',
      danger: '#ff2e2e',
      success: '#7fae62',
      warning: '#d9a748',
      shadow: '0 0 10px rgba(255, 80, 80, 0.18)',
      radius: '10px',
      scrollbarColor: '#ff5c5c',
      scrollbarWidth: '16px',
      scrollbarRadius: '999px',
      scrollbarShadow: '0 0 8px rgba(255, 92, 92, 0.5)',
    },
  },
  {
    id: 'seventies',
    label: "'70s Groove",
    dark: false,
    group: 'retro',
    tokens: {
      bg: '#efe3c8',
      surface: '#f9f1de',
      surface2: '#e5d3ab',
      text: '#3a2c16',
      textMuted: '#77613c',
      border: '#d2bb8a',
      accent: '#b3591f',
      accentContrast: '#f9f1de',
      danger: '#a32b20',
      success: '#647d2a',
      warning: '#b98c15',
      shadow: '0 2px 6px rgba(80, 60, 20, 0.18)',
      radius: '18px',
      scrollbarColor: 'linear-gradient(180deg, #b3591f, #d9a441, #647d2a)',
      scrollbarWidth: '20px',
      scrollbarRadius: '999px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'jazzCup',
    label: 'Jazz Cup',
    dark: false,
    group: 'retro',
    tokens: {
      bg: '#f0fafa',
      surface: '#ffffff',
      surface2: '#dcf3f2',
      text: '#182c3a',
      textMuted: '#4e6f80',
      border: '#b5e2e0',
      accent: '#009aa6',
      accentContrast: '#ffffff',
      danger: '#d64545',
      success: '#1f9e78',
      warning: '#c98a1f',
      shadow: '0 1px 3px rgba(0, 90, 100, 0.1), 0 4px 16px rgba(0, 90, 100, 0.08)',
      radius: '14px',
      scrollbarColor: 'linear-gradient(180deg, #00b2bd, #7a4bc8)',
      scrollbarWidth: '20px',
      scrollbarRadius: '999px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'diner',
    label: 'Diner',
    dark: false,
    group: 'retro',
    tokens: {
      bg: '#f4f1ea',
      surface: '#ffffff',
      surface2: '#dff0e8',
      text: '#26262e',
      textMuted: '#5f5f6c',
      border: '#c9dcd3',
      accent: '#d3273e',
      accentContrast: '#ffffff',
      danger: '#8f1b2c',
      success: '#1f8e5a',
      warning: '#d69a1f',
      shadow: '0 2px 4px rgba(40, 40, 60, 0.12)',
      radius: '14px',
      scrollbarColor: 'linear-gradient(180deg, #f2f3f7, #9aa2b1)',
      scrollbarWidth: '22px',
      scrollbarRadius: '999px',
      scrollbarShadow: 'inset 0 0 4px rgba(0, 0, 0, 0.35)',
    },
  },
  {
    id: 'handheld',
    label: 'Handheld LCD',
    dark: false,
    group: 'retro',
    tokens: {
      // The 1989 pea-green brick, four shades of it.
      bg: '#9bbc0f',
      surface: '#b0cc32',
      surface2: '#8aa81c',
      text: '#0f380f',
      textMuted: '#2e5c1e',
      border: '#306230',
      accent: '#0f380f',
      accentContrast: '#9bbc0f',
      danger: '#7a3a10',
      success: '#1e5c2f',
      warning: '#6b5a10',
      shadow: 'none',
      radius: '6px',
      scrollbarColor: '#0f380f',
      scrollbarWidth: '22px',
      scrollbarRadius: '0px',
      scrollbarShadow: 'none',
    },
  },
  {
    id: 'crtGreen',
    label: 'CRT Green',
    dark: true,
    group: 'retro',
    tokens: {
      bg: '#030b05',
      surface: '#07160b',
      surface2: '#0c2313',
      text: '#45f077',
      textMuted: '#2fa254',
      border: '#175c2e',
      accent: '#33ff66',
      accentContrast: '#04180a',
      danger: '#ff5c5c',
      success: '#33ff66',
      warning: '#ffd23f',
      shadow: '0 0 12px rgba(51, 255, 102, 0.22)',
      radius: '6px',
      scrollbarColor: '#33ff66',
      scrollbarWidth: '18px',
      scrollbarRadius: '0px',
      scrollbarShadow: '0 0 8px rgba(51, 255, 102, 0.7)',
    },
  },
  {
    id: 'crtAmber',
    label: 'CRT Amber',
    dark: true,
    group: 'retro',
    tokens: {
      bg: '#0b0602',
      surface: '#160d03',
      surface2: '#221505',
      text: '#ffb000',
      textMuted: '#b8811a',
      border: '#573d0e',
      accent: '#ffb000',
      accentContrast: '#160d03',
      danger: '#ff6055',
      success: '#9adf4f',
      warning: '#ffd23f',
      shadow: '0 0 12px rgba(255, 176, 0, 0.22)',
      radius: '6px',
      scrollbarColor: '#ffb000',
      scrollbarWidth: '18px',
      scrollbarRadius: '0px',
      scrollbarShadow: '0 0 8px rgba(255, 176, 0, 0.6)',
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
  scrollbarColor: '--scrollbar-color',
  scrollbarWidth: '--scrollbar-width',
  scrollbarRadius: '--scrollbar-radius',
  scrollbarShadow: '--scrollbar-shadow',
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

// --- Display preferences (readability + background flair) ---

/** Sunlight boost: rebuilds the scheme's weakest-contrast tokens much closer
 * to full text color. Works on ANY scheme — glare-proofing without forcing
 * anyone off the palette they like. */
export function sunlightTokens(t: ThemeTokens): ThemeTokens {
  return {
    ...t,
    textMuted: `color-mix(in srgb, ${t.textMuted} 25%, ${t.text})`,
    border: `color-mix(in srgb, ${t.border} 45%, ${t.text})`,
    shadow: 'none',
  }
}

/** System-font stacks only — a font choice must not add a single byte of
 * webfont download. Unsupported entries fall back to the system face. */
export const FONT_STACKS: Record<FontId, string> = {
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', system-ui, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', 'Roboto Mono', Menlo, Consolas, monospace",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
}

export const TEXT_SCALES: { value: number; label: string }[] = [
  { value: 0.92, label: 'Compact' },
  { value: 1, label: 'Standard' },
  { value: 1.1, label: 'Large' },
  { value: 1.22, label: 'X-Large' },
  { value: 1.35, label: 'Jumbo' },
]

export const DEFAULT_PREFS: DisplayPrefs = {
  textScale: 1,
  bold: false,
  sunlight: false,
  font: 'system',
  corners: 'theme',
  compact: false,
  reduceMotion: false,
  pattern: 'none',
  patternBold: false,
}

/** Validates the profiles.theme jsonb (or the paint cache) into a scheme id
 * plus a fully-populated prefs object. Tolerates legacy `{scheme}`-only
 * rows, nulls, and junk values. */
export function normalizeThemeSettings(raw: unknown): { scheme: ThemeId; prefs: DisplayPrefs } {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const scheme = getTheme(typeof obj.scheme === 'string' ? obj.scheme : undefined).id
  return {
    scheme,
    prefs: {
      textScale: TEXT_SCALES.some((s) => s.value === obj.textScale)
        ? (obj.textScale as number)
        : DEFAULT_PREFS.textScale,
      bold: obj.bold === true,
      sunlight: obj.sunlight === true,
      font:
        typeof obj.font === 'string' && obj.font in FONT_STACKS
          ? (obj.font as FontId)
          : DEFAULT_PREFS.font,
      corners: obj.corners === 'sharp' || obj.corners === 'round' ? obj.corners : 'theme',
      compact: obj.compact === true,
      reduceMotion: obj.reduceMotion === true,
      pattern: isPatternId(obj.pattern) ? obj.pattern : DEFAULT_PREFS.pattern,
      patternBold: obj.patternBold === true,
    },
  }
}

const PATTERN_VAR_KEYS = ['a', 'b'] as const

function applyPatternLayer(
  style: CSSStyleDeclaration,
  key: (typeof PATTERN_VAR_KEYS)[number],
  layer: PatternLayer | undefined,
  ink: string,
) {
  style.setProperty(`--pattern-mask-${key}`, layer ? layer.mask : 'none')
  style.setProperty(`--pattern-size-${key}`, layer ? layer.size : 'auto')
  style.setProperty(`--pattern-ink-${key}`, layer ? ink : 'transparent')
}

/** Applies everything a scheme's tokens don't cover: root font scale, font
 * stack, bold/compact/reduce-motion classes, corner override, and the
 * background-pattern mask layers (style.css owns the matching selectors).
 * Call AFTER applyThemeTokens — the corner override wins over the scheme's
 * radius token by running last. */
export function applyDisplayPrefs(prefs: DisplayPrefs, tokens: ThemeTokens) {
  const root = document.documentElement
  const style = root.style

  style.setProperty('--font-scale', String(prefs.textScale))
  style.setProperty('--font-body', FONT_STACKS[prefs.font])
  if (prefs.corners !== 'theme') {
    style.setProperty('--radius', prefs.corners === 'sharp' ? '4px' : '18px')
  }
  root.classList.toggle('pref-bold', prefs.bold)
  root.classList.toggle('pref-compact', prefs.compact)
  root.classList.toggle('pref-reduce-motion', prefs.reduceMotion)

  const pattern = getPattern(prefs.pattern)
  if (!pattern.a && !pattern.b) {
    root.removeAttribute('data-pattern')
    for (const key of PATTERN_VAR_KEYS) applyPatternLayer(style, key, undefined, 'transparent')
    return
  }
  root.setAttribute('data-pattern', pattern.id)
  // Ink strength: low enough that text sitting directly on the page bg
  // stays comfortably readable even on the Bold setting.
  const aPct = prefs.patternBold ? 16 : 8
  const bPct = prefs.patternBold ? 12 : 6
  applyPatternLayer(style, 'a', pattern.a, `color-mix(in srgb, ${tokens.accent} ${aPct}%, transparent)`)
  applyPatternLayer(style, 'b', pattern.b, `color-mix(in srgb, ${tokens.text} ${bPct}%, transparent)`)
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
