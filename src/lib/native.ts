// Capacitor native-shell integration. Every export is safe to call on the
// plain web deploy — native-only behavior is gated on isNativeApp, and haptic
// calls degrade to the Vibration API (or a no-op) in browsers.
import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import type { Router } from 'vue-router'

/** True when running inside the iOS/Android Capacitor shell. */
export const isNativeApp = Capacitor.isNativePlatform()

/** 'ios' | 'android' | 'web' */
export const nativePlatform = Capacitor.getPlatform()

/**
 * Base URL for Netlify-function endpoints. Same-origin ('') on the web; the
 * native shells serve the app from a local webview origin, so they must call
 * the live site absolutely (chat.ts allowlists the shell origins for CORS).
 */
export const apiBase = isNativeApp ? 'https://f0rcef1eld.netlify.app' : ''

const IMPACT = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
} as const

/**
 * Physical tap acknowledgment. Use `light` for selection changes, `medium`
 * for primary actions (logging a knock), `heavy` sparingly.
 */
export function hapticTap(style: keyof typeof IMPACT = 'light'): void {
  Haptics.impact({ style: IMPACT[style] }).catch(() => {})
}

/** Success/warning/error pattern — e.g. after a knock outcome is saved. */
export function hapticNotify(type: 'success' | 'warning' | 'error' = 'success'): void {
  const map = {
    success: NotificationType.Success,
    warning: NotificationType.Warning,
    error: NotificationType.Error,
  }
  Haptics.notification({ type: map[type] }).catch(() => {})
}

/**
 * One-time shell setup, called from main.ts. Currently: Android hardware/
 * gesture back navigates the SPA instead of instantly closing the app.
 */
export function initNativeShell(router: Router): void {
  if (!isNativeApp) return

  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => {
      // vue-router records the previous route in history.state.back; when
      // there is none we're at a root screen — background the app like a
      // normal Android home gesture rather than killing it.
      if (window.history.state?.back) {
        router.back()
      } else {
        App.minimizeApp()
      }
    })
  })
}
