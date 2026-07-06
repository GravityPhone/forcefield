// Member accent colors for the Squad page (cards + map markers). Users pick
// one on /appearance (profiles.color); anyone who hasn't picked still gets a
// stable hue via a hash of their id, so squadmates can tell each other apart
// from day one. Deliberately separate from knock-outcome colors and themes.

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
