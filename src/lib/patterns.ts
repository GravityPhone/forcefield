import type { PatternId } from '@/types'

/** Background flair: repeating patterns painted behind every page (the
 * "jazz cup" feature). Each pattern is one or two MASK layers — the mask
 * carries only the shape; the ink color is mixed at paint time from the
 * active scheme (layer A = accent, layer B = text) at low opacity, so any
 * pattern works on any scheme, day or night, without ever fighting the
 * text for contrast. Masks are inline SVG data URIs or plain CSS
 * gradients: a few hundred bytes, zero network requests. */

export interface PatternLayer {
  /** CSS image value usable as mask-image (data-URI SVG or a gradient). */
  mask: string
  /** CSS mask-size ('auto' for self-sizing gradients). */
  size: string
}

export interface PatternDef {
  id: PatternId
  label: string
  blurb: string
  /** Accent-inked layer. */
  a?: PatternLayer
  /** Text-inked layer. */
  b?: PatternLayer
}

function svgMask(w: number, h: number, body: string): PatternLayer {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${body}</svg>`
  return {
    mask: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    size: `${w}px ${h}px`,
  }
}

/* Motif tiles keep every stroke well inside the tile edges (no cross-edge
 * drawing), so they repeat seamlessly by construction. The continuous ones
 * (waves, zigzag) use periods that divide the tile width exactly. */

export const PATTERNS: PatternDef[] = [
  {
    id: 'none',
    label: 'None',
    blurb: 'Plain background, nothing behind the page.',
  },
  {
    id: 'jazz',
    label: 'Jazz Cup',
    blurb: 'Torn brush streaks with a loose scribble — straight off the 90s solo cup.',
    a: svgMask(
      260,
      220,
      "<g transform='rotate(-7 130 110)'>" +
        "<path d='M30 52 C 88 34 178 40 232 52 L 225 78 C 170 66 92 74 40 84 Z'/>" +
        "<path d='M16 150 C 62 138 122 142 158 150 L 152 172 C 112 162 62 168 22 176 Z'/>" +
        "<path d='M186 128 C 208 122 228 124 244 130 L 240 148 C 224 140 206 142 192 146 Z'/>" +
        '</g>',
    ),
    b: svgMask(
      300,
      260,
      "<g fill='none' stroke='black' stroke-width='7' stroke-linecap='round' transform='rotate(4 150 130)'>" +
        "<path d='M36 60 q 24 -32 48 0 t 48 0 t 48 0 t 48 0'/>" +
        "<path d='M60 208 q 18 -24 36 0 t 36 0 t 36 0'/>" +
        '</g>',
    ),
  },
  {
    id: 'memphis',
    label: 'Memphis',
    blurb: 'Design-school confetti — triangles, squiggles, crosses, dots.',
    a: svgMask(
      280,
      280,
      "<g fill='none' stroke='black' stroke-width='7'>" +
        "<path d='M56 36 l 34 58 h -68 z'/>" +
        "<rect x='196' y='190' width='34' height='34' transform='rotate(18 213 207)'/>" +
        '</g>' +
        "<circle cx='206' cy='64' r='13'/>" +
        "<circle cx='84' cy='214' r='8'/>",
    ),
    b: svgMask(
      320,
      320,
      "<g fill='none' stroke='black' stroke-width='7' stroke-linecap='round'>" +
        "<path d='M36 96 q 16 -22 32 0 t 32 0'/>" +
        "<path d='M226 40 l 26 26 M252 40 l -26 26'/>" +
        "<path d='M60 250 l 16 -18 l 16 18 l 16 -18'/>" +
        '</g>' +
        "<circle cx='262' cy='262' r='7'/>" +
        "<circle cx='160' cy='170' r='6'/>",
    ),
  },
  {
    id: 'waves',
    label: 'Waves',
    blurb: 'Calm rolling lines, edge to edge.',
    a: svgMask(
      240,
      240,
      "<g fill='none' stroke='black' stroke-width='6'>" +
        "<path d='M-24 50 q 24 -18 48 0 t 48 0 t 48 0 t 48 0 t 48 0 t 48 0'/>" +
        "<path d='M-24 130 q 24 -18 48 0 t 48 0 t 48 0 t 48 0 t 48 0 t 48 0'/>" +
        "<path d='M-24 210 q 24 -18 48 0 t 48 0 t 48 0 t 48 0 t 48 0 t 48 0'/>" +
        '</g>',
    ),
  },
  {
    id: 'zigzag',
    label: 'Zigzag',
    blurb: 'Sharp chevron rows, very 80s sweater.',
    b: svgMask(
      264,
      192,
      "<g fill='none' stroke='black' stroke-width='6' stroke-linejoin='round'>" +
        "<path d='M-22 40 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16'/>" +
        "<path d='M-22 104 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16'/>" +
        "<path d='M-22 168 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16 l 22 16 l 22 -16'/>" +
        '</g>',
    ),
  },
  {
    id: 'grid',
    label: 'Graph Paper',
    blurb: 'Fine square grid, quietly technical.',
    b: {
      mask:
        'linear-gradient(to right, black 1.5px, transparent 1.5px), ' +
        'linear-gradient(to bottom, black 1.5px, transparent 1.5px)',
      size: '32px 32px, 32px 32px',
    },
  },
  {
    id: 'scanlines',
    label: 'Scanlines',
    blurb: 'Thin horizontal lines — pairs well with the CRT schemes.',
    b: {
      mask: 'repeating-linear-gradient(to bottom, black 0 1.5px, transparent 1.5px 5px)',
      size: 'auto',
    },
  },
  {
    id: 'stripes',
    label: 'Stripes',
    blurb: 'Broad diagonal bands of your scheme color.',
    a: {
      mask: 'repeating-linear-gradient(45deg, black 0 26px, transparent 26px 78px)',
      size: 'auto',
    },
  },
  {
    id: 'dots',
    label: 'Dots',
    blurb: 'A quiet halftone dot field.',
    a: {
      mask: 'radial-gradient(circle, black 1.7px, transparent 2.2px)',
      size: '26px 26px',
    },
  },
]

const PATTERN_MAP = new Map(PATTERNS.map((p) => [p.id, p]))

export function getPattern(id: string | null | undefined): PatternDef {
  return (id && PATTERN_MAP.get(id as PatternId)) || PATTERNS[0]
}

export function isPatternId(v: unknown): v is PatternId {
  return typeof v === 'string' && PATTERN_MAP.has(v as PatternId)
}
