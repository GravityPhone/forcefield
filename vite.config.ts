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
  build: {
    rollupOptions: {
      output: {
        // Split the big never-changing libraries out of the app chunk.
        //
        // This does NOT make the first visit smaller — the same bytes still
        // arrive. It makes every visit AFTER a deploy smaller, which on this
        // project is the case that matters: deploys land constantly (87 of
        // 100 builds in one measured week), and while everything sat in one
        // index chunk, changing a single line of copy invalidated Vue,
        // vue-router, Pinia, the whole Supabase client and Dexie along with
        // it. Now a normal deploy re-downloads only the app's own chunk and
        // the vendor files come from cache, which the immutable headers in
        // netlify.toml let the browser use without even asking.
        //
        // Split by how often a thing changes, NOT into as many pieces as
        // possible: more chunks means more requests, and these four move on
        // completely different clocks from the app code and from each other.
        // Anything not named here (notably vue-advanced-chat, which is only
        // pulled in when the chat drawer opens) keeps Rollup's own chunking.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase'
          if (/[\\/]node_modules[\\/]dexie[\\/]/.test(id)) return 'vendor-dexie'
          if (/[\\/]node_modules[\\/]reka-ui[\\/]/.test(id)) return 'vendor-ui'
          if (
            /[\\/]node_modules[\\/](vue|vue-router|pinia|@vue|@vueuse)[\\/]/.test(id)
          ) {
            return 'vendor-vue'
          }
        },
      },
    },
  },
})
