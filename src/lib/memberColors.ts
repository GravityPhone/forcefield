// Member accent colors. Users pick one on /profile (About me) — the 12-swatch
// team palette or any custom hex from the mixer (profiles.color allows any
// #rrggbb); anyone who hasn't picked still gets a stable hue via a hash of
// their id, so squadmates can tell each other apart from day one. Shown on
// Squad-page cards/markers, roster rows, and chat names. Deliberately
// separate from knock-outcome colors and themes.

export const MEMBER_COLORS = [
  '#e11d48', // rose
  '#ea580c', // orange
  '#d97706', // amber
  '#65a30d', // lime
  '#059669', // emerald
  '#0d9488', // teal
  '#0891b2', // cyan
  '#2563eb', // blue
  '#7c3aed', // violet
  '#c026d3', // fuchsia
  '#db2777', // pink
  '#78716c', // stone
] as const

/** The member's picked color, or a stable palette fallback hashed from id. */
export function memberColor(member: { id: string; color?: string | null }): string {
  if (member.color) return member.color
  let h = 0
  for (let i = 0; i < member.id.length; i++) h = (h * 31 + member.id.charCodeAt(i)) >>> 0
  return MEMBER_COLORS[h % MEMBER_COLORS.length]
}

// --- Hex ↔ HSL, for the /profile custom color mixer ---

/** '#rrggbb' → [hue 0-360, saturation 0-100, lightness 0-100]; null if malformed. */
export function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = Math.round(h * 60)
  if (h < 0) h += 360
  return [h, Math.round(s * 100), Math.round(l * 100)]
}

/** hue 0-360, saturation 0-100, lightness 0-100 → '#rrggbb'. */
export function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = ln - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to2 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

/** Legible ink (black/white) over a given hex — for check marks and chips. */
export function inkOn(hex: string): string {
  const hsl = hexToHsl(hex)
  return hsl && hsl[2] > 62 ? '#1a1a1a' : '#ffffff'
}
