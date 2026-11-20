import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { SheetError, fetchSheetCsv } from './netlify/shared/sheetFetch'

/**
 * /api/sheet under `npm run dev`.
 *
 * On the live site that path is a Netlify function (netlify/functions/sheet.ts)
 * and plain Vite has no functions, so the Google Sheets link import would 404
 * in dev and be untestable. This serves the same route from the same shared
 * code. DEV ONLY: `configureServer` never runs in a build, and it skips the
 * manager check the real function makes because the dev server only listens
 * on localhost.
 */
function devSheetApi(): Plugin {
  return {
    name: 'dev-sheet-api',
    configureServer(server) {
      server.middlewares.use('/api/sheet', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') return send(405, { error: 'POST only.' })
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          let url = ''
          try {
            url = String(JSON.parse(raw).url ?? '')
          } catch {
            return send(400, { error: 'Bad request.' })
          }
          fetchSheetCsv(url)
            .then((out) => send(200, out))
            .catch((e) =>
              e instanceof SheetError ? send(e.status, { error: e.message }) : send(500, { error: 'Could not read that sheet.' }),
            )
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [
    devSheetApi(),
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
