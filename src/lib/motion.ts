// Shared @vueuse/motion presets. Each helper returns {} when the OS asks for
// reduced motion — an empty variants object makes v-motion a no-op, which the
// library handles fine (the global CSS reduce rule can't reach these because
// they animate via inline styles, so the gate lives here).
const reduced =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

interface MotionVariants {
  initial?: Record<string, number>
  enter?: Record<string, unknown>
}

/** Fade in while settling upward — list rows, cards. Stagger with `delay`. */
export function fadeUp(delay = 0): MotionVariants {
  if (reduced) return {}
  return {
    initial: { opacity: 0, y: 10 },
    enter: { opacity: 1, y: 0, transition: { duration: 220, delay, ease: 'easeOut' } },
  }
}

/** Spring pop — buttons/badges that appear in response to an action. */
export function popIn(delay = 0): MotionVariants {
  if (reduced) return {}
  return {
    initial: { opacity: 0, scale: 0.92, y: 6 },
    enter: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { type: 'spring', stiffness: 400, damping: 24, delay },
    },
  }
}
