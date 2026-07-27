import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { MotionPlugin } from '@vueuse/motion'
import App from './App.vue'
import router from './router'
import { initNativeShell } from './lib/native'
// @font-face declarations only — costs nothing until a font is actually
// picked, since a browser downloads a face only when text renders in it.
import './fonts.css'
import './style.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(MotionPlugin)
app.mount('#app')

initNativeShell(router)

// Loaded once the browser is idle, not with the bundle. The knock queue is
// built on Dexie, which is a large library that nothing on screen needs in
// order to draw: a static import here meant every cold open paid to download
// and parse the whole of IndexedDB's wrapper before the first pixel.
//
// Waiting for idle rather than firing straight after mount matters on the
// connection this app actually runs on. Requested immediately, this competes
// for a narrow pipe with the two vendor chunks and the first Supabase calls,
// all of which someone is waiting on to see anything at all. Nothing here is
// time-critical: initKnockQueue replays whatever is parked in the queue and
// then re-checks on every 'online' event and once a minute afterwards, and a
// queued knock is one already logged and waiting on signal, not one being
// taken right now. Arriving a second late costs it nothing.
//
// requestIdleCallback is missing on older Safari, where the timeout is the
// whole mechanism rather than a backstop.
const startKnockQueue = () => void import('./lib/knockQueue').then((m) => m.initKnockQueue())
if ('requestIdleCallback' in window) {
  requestIdleCallback(startKnockQueue, { timeout: 3000 })
} else {
  setTimeout(startKnockQueue, 1200)
}

// Dev-only handles for debugging/testing from the browser console.
if (import.meta.env.DEV) {
  ;(window as any).__pinia = pinia
  ;(window as any).__router = router
}
