// Chart color system for the Analytics page. Chart CHROME (axes, grid, text)
// rides the app's theme tokens so every scheme works; SERIES colors come from
// a fixed, CVD-validated categorical palette (8 slots, separate steps for
// light and dark surfaces — validated with the dataviz palette checker, worst
// adjacent ΔE 24.2 light / 10.3 dark). Outcome-encoded charts use OUTCOME_HEX
// instead (fixed app-wide, same as pins/buttons) — never both in one chart.

import { computed } from 'vue'
import { useThemeStore } from '@/stores/theme'

/** Categorical slots, fixed order (the order IS the colorblind-safety
 * mechanism — assign in sequence, never cycle past 8). */
export const CATEGORICAL_LIGHT = [
  '#2a78d6', // blue
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
  '#e87ba4', // magenta
  '#eb6834', // orange
] as const

export const CATEGORICAL_DARK = [
  '#3987e5',
  '#199e70',
  '#c98500',
  '#008300',
  '#9085e9',
  '#e66767',
  '#d55181',
  '#d95926',
] as const

/** Single-hue blue ramp for sequential (magnitude) encoding, light→dark. */
const SEQ_RAMP = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b',
] as const

function hexLerp(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return (
    '#' +
    pa
      .map((v, i) =>
        Math.round(v + (pb[i] - v) * t)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

/** Magnitude → color. t in [0,1]. On dark surfaces the anchor flips so that
 * "near zero" recedes toward the surface (dark low, light high). */
export function sequentialColor(t: number, dark: boolean): string {
  const tt = Math.min(1, Math.max(0, dark ? 1 - t : t))
  const pos = tt * (SEQ_RAMP.length - 1)
  const i = Math.min(SEQ_RAMP.length - 2, Math.floor(pos))
  return hexLerp(SEQ_RAMP[i], SEQ_RAMP[i + 1], pos - i)
}

/** Ordered discrete steps (funnel stages, tiers): one hue, monotone
 * lightness, light end clamped so it still clears the surface. */
export function ordinalRamp(steps: number, dark: boolean): string[] {
  // light mode: step 250 → 650; dark mode: step 600 → 200 (lighter = more)
  const lo = dark ? 10 : 3
  const hi = dark ? 2 : 11
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 1 : i / (steps - 1)
    const pos = lo + (hi - lo) * t
    const j = Math.min(SEQ_RAMP.length - 2, Math.max(0, Math.floor(pos)))
    return hexLerp(SEQ_RAMP[j], SEQ_RAMP[j + 1], Math.min(1, Math.max(0, pos - j)))
  })
}

/** Diverging pair for signed coefficients etc.: cool positive, warm negative,
 * neutral midpoint comes from the theme border token. */
export function divergingPair(dark: boolean): { pos: string; neg: string } {
  return dark ? { pos: '#3987e5', neg: '#e66767' } : { pos: '#2a78d6', neg: '#e34948' }
}

/** Reactive palette for the current scheme. */
export function useChartPalette() {
  const theme = useThemeStore()
  const dark = computed(() => theme.currentTheme.dark)
  return {
    dark,
    categorical: computed<readonly string[]>(() => (dark.value ? CATEGORICAL_DARK : CATEGORICAL_LIGHT)),
    diverging: computed(() => divergingPair(dark.value)),
  }
}

/** Clean rounded axis ticks covering [0, max] (or [min,max] when min < 0). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) max = min + 1
  const span = max - min
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

export const fmtCount = (v: number): string =>
  Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString()

export const fmtPct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`
