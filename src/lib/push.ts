// Push-notification scaffold (squad-chat pings). Registration is wired but
// NOT called at startup yet — it needs per-store config before it can work:
//
//   Android (FCM):
//     1. Create a Firebase project, add Android app com.forcefield.app.
//     2. Drop google-services.json into android/app/.
//     3. Add `apply plugin: 'com.google.gms.google-services'` to
//        android/app/build.gradle and the google-services classpath to
//        android/build.gradle (see Capacitor push-notifications docs).
//   iOS (APNs):
//     1. Enable the Push Notifications capability on the App target in Xcode.
//     2. Create an APNs key in the Apple Developer portal; upload it to the
//        push provider (FCM can relay to APNs so one sender serves both).
//   Backend:
//     - A push_tokens table (user_id, platform, token, updated_at) + a sender
//       (Netlify function or Supabase edge function) triggered on chat inserts.
//
// Once those exist, call initPushNotifications() from main.ts after login and
// POST the token to the backend in the 'registration' listener below.
import { isNativeApp } from './native'

export async function initPushNotifications(
  onToken: (token: string) => void,
): Promise<boolean> {
  // Web push for the PWA would need a service worker + VAPID keys — separate
  // effort; the native apps are the priority for squad pings.
  if (!isNativeApp) return false

  const { PushNotifications } = await import('@capacitor/push-notifications')

  let perm = await PushNotifications.checkPermissions()
  if (perm.receive === 'prompt') {
    perm = await PushNotifications.requestPermissions()
  }
  if (perm.receive !== 'granted') return false

  await PushNotifications.addListener('registration', (token) => {
    onToken(token.value)
  })
  await PushNotifications.addListener('registrationError', (err) => {
    console.warn('[push] registration failed', err)
  })

  await PushNotifications.register()
  return true
}
