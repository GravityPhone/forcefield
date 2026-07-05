import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.forcefield.app',
  appName: 'Forcefield',
  webDir: 'dist',
  // Android's WebView origin defaults to http://localhost — keep https so
  // secure-context APIs (geolocation, clipboard) behave like the web deploy.
  server: {
    androidScheme: 'https',
  },
}

export default config
