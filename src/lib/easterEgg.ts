import { ref, type Ref } from 'vue'

// Easter egg: tapping YOUR OWN NAME on /profile 25 times in a row (see
// ProfileView) launches the Clipboard Canvass mini game (CanvassGame,
// mounted lazily in AppShell). This ref is the only wiring between them.
// It used to live on the chat drawer handle, which never worked in practice:
// the first tap opens the drawer, and opening the drawer pulls in the ~400 kB
// chat widget — the main thread stalls long enough that the streak times out
// before your thumb ever gets near 25. A plain name with no side effects has
// nothing to swallow the taps.
export const canvassGameOpen = ref(false)

/** Taps this far apart (ms) still count as part of the same streak. */
export const TAP_STREAK_WINDOW = 900

/**
 * Rapid-tap streak counter. `streak` is exposed so the caller can give a
 * "something is happening" tell as it climbs — with no feedback at all, 25 is
 * a wall you can't tell you're climbing.
 */
export function useTapStreak(goal: number, onComplete: () => void): {
  streak: Ref<number>
  tap: () => void
} {
  const streak = ref(0)
  let lastTapAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function tap() {
    const now = Date.now()
    streak.value = now - lastTapAt < TAP_STREAK_WINDOW ? streak.value + 1 : 1
    lastTapAt = now
    clearTimeout(timer)
    if (streak.value >= goal) {
      streak.value = 0
      onComplete()
      return
    }
    timer = setTimeout(() => {
      streak.value = 0
    }, TAP_STREAK_WINDOW)
  }

  return { streak, tap }
}
