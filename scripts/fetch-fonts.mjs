#!/usr/bin/env node
/**
 * Downloads the Appearance page's font faces into src/assets/fonts/.
 *
 * WHY THESE EXIST AT ALL. The font picker used to be system stacks only, on
 * a "a font choice must not cost a single byte" rule. That rule cannot be
 * satisfied on the device this app is actually used on: Android ships one
 * sans family (Roboto, or the skin's own), so `rounded`, `grotesque`,
 * `geometric`, `condensed`, `legible`, `trebuchet` and `poster` all resolved
 * to the SAME face. Eight "choices", one font. Measured on Windows the same
 * stacks are 13 distinct faces, which is why it looked fine to whoever built
 * it and wrong to everyone in the field.
 *
 * WHAT IT STILL COSTS: nothing, unless a font is picked. A browser fetches an
 * @font-face only when text actually renders in it, so `system` (the default)
 * downloads zero bytes and the cold-start budget is untouched. A picked face
 * is one file, once, then cached a year by the /assets/* immutable rule in
 * netlify.toml (they land there because Vite content-hashes anything imported
 * from src/assets — that's the reason these are NOT in public/, which is
 * served must-revalidate).
 *
 * WHAT IS DELIBERATELY NOT HERE: `serif` and `mono` have no file. The CSS
 * generic families `serif` and `monospace` are guaranteed to exist on every
 * device and are guaranteed to differ from the sans default, so those two
 * choices already work everywhere for free. Only the faces that collapse
 * into the system sans need shipping.
 *
 * Variable (`wght` range) wherever the family offers it, so one file covers
 * the 400/600/700/800 the app uses instead of synthesising bold. Anton is
 * single-weight by design; see FONT_SYNTHESIS_NONE in fonts.css.
 *
 * All OFL 1.1. See src/assets/fonts/README.md.
 *
 *   node scripts/fetch-fonts.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'fonts')

// A modern UA is required: Google Fonts serves ttf to anything it doesn't
// recognise, and woff2 (about a third the size) to Chrome.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** file name -> the Google Fonts family spec to pull it from.
 *  Keep in sync with FONT_FACES in src/lib/themes.ts. */
const FONTS = [
  { id: 'nunito', spec: 'Nunito:wght@400..800' },
  { id: 'inter', spec: 'Inter:wght@400..800' },
  { id: 'jost', spec: 'Jost:wght@400..800' },
  { id: 'archivo-narrow', spec: 'Archivo+Narrow:wght@400..700' },
  { id: 'atkinson', spec: 'Atkinson+Hyperlegible+Next:wght@400..700' },
  { id: 'bitter', spec: 'Bitter:wght@400..800' },
  { id: 'caveat', spec: 'Caveat:wght@400..700' },
  { id: 'anton', spec: 'Anton' },
]

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

/** Google returns one @font-face block per unicode subset, each preceded by a
 *  `/* latin *\/`-style comment. We want latin only: latin-ext, cyrillic and
 *  vietnamese are dead weight for a Union County petition app. */
function latinWoff2Urls(css) {
  const out = []
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g
  let m
  while ((m = re.exec(css))) {
    if (m[1] !== 'latin') continue
    const src = /src:\s*url\((https:[^)]+\.woff2)\)/.exec(m[2])
    if (src) out.push(src[1])
  }
  // Anton and other single-subset families sometimes come back with no
  // subset comments at all — fall back to every woff2 in the file.
  if (!out.length) {
    const re2 = /url\((https:[^)]+\.woff2)\)/g
    let m2
    while ((m2 = re2.exec(css))) out.push(m2[1])
  }
  return [...new Set(out)]
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  let total = 0

  for (const { id, spec } of FONTS) {
    const css = await fetchText(
      `https://fonts.googleapis.com/css2?family=${spec}&display=swap`,
    )
    const urls = latinWoff2Urls(css)
    if (!urls.length) throw new Error(`no latin woff2 found for ${spec}`)
    // More than one latin face means the family is static, not variable, and
    // taking the first would silently ship its regular weight alone — the app
    // would then synthesise 600/700/800 and the face would look smeared at
    // every heading. Pick a variable family instead of loosening this.
    if (urls.length > 1) {
      throw new Error(
        `${spec} is static (${urls.length} latin faces). Use a variable family.`,
      )
    }

    const res = await fetch(urls[0], { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`${res.status} downloading ${urls[0]}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(join(OUT_DIR, `${id}.woff2`), buf)
    total += buf.length
    console.log(`  ${id.padEnd(18)} ${(buf.length / 1024).toFixed(1).padStart(6)} KB`)
  }

  console.log(`\n${FONTS.length} faces, ${(total / 1024).toFixed(1)} KB on disk.`)
  console.log('None of it is downloaded by a client until a font is picked.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
