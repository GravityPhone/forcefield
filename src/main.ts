import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { initKnockQueue } from './lib/knockQueue'
import './style.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.mount('#app')

initKnockQueue()

// Dev-only handles for debugging/testing from the browser console.
if (import.meta.env.DEV) {
  ;(window as any).__pinia = pinia
  ;(window as any).__router = router
}
