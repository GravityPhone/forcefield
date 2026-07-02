import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // vue-advanced-chat renders as native custom elements — don't let
          // Vue try to resolve them as components.
          isCustomElement: (tag) => tag === 'vue-advanced-chat' || tag === 'emoji-picker',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // PORT lets tooling (preview harness, CI) assign a free port; 5173 stays
    // the default for plain `npm run dev`.
    port: Number(process.env.PORT) || 5173,
  },
})
