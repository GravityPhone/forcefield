// Renders the Forcefield mark (hex shield + dipole lobes + bolt — keep in
// sync with src/components/AppLogo.vue and public/favicon.svg) into every
// raster icon the platforms need: apple-touch-icon, the iOS appiconset, and
// the Android legacy + adaptive launcher mipmaps.
//
// Run: node scripts/generate-icons.mjs
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const BG = '#1a1d29'
const ACCENT = '#5b8cff'

// The mark in a 96x96 box. `scale` shrinks it toward the center (for the
// Android adaptive-icon safe zone), `opaque` fills the background.
function markSvg({ opaque = true, scale = 1 } = {}) {
  const t = (48 * (1 - scale)).toFixed(2)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  ${opaque ? `<rect width="96" height="96" fill="${BG}"/>` : ''}
  <g transform="translate(${t},${t}) scale(${scale})">
    <g fill="none" stroke="${ACCENT}" stroke-linejoin="round" stroke-linecap="round">
      <path d="M48,14 L77.4,31 L77.4,65 L48,82 L18.6,65 L18.6,31 Z" stroke-width="5"/>
      <ellipse cx="31.5" cy="48" rx="8.5" ry="6.5" stroke-width="4"/>
      <ellipse cx="64.5" cy="48" rx="8.5" ry="6.5" stroke-width="4"/>
    </g>
    <path d="M53,29 L40,50 L47,50 L43,67 L57,46 L50,46 Z" fill="${ACCENT}"/>
  </g>
</svg>`
}

function render(svg, size) {
  return sharp(Buffer.from(svg), { density: 300 }).resize(size, size)
}

async function writePng(svg, size, file) {
  await mkdir(path.dirname(file), { recursive: true })
  await render(svg, size).png().toFile(file)
  console.log(`${file} (${size}x${size})`)
}

async function writeRoundPng(svg, size, file) {
  const circle = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  )
  const square = await render(svg, size).png().toBuffer()
  await sharp(square)
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toFile(file)
  console.log(`${file} (${size}x${size}, round)`)
}

const opaque = markSvg()
// Adaptive foregrounds must keep content inside the center 66/108dp safe
// zone (~61% of the canvas); the bare mark spans ~71%, so shrink it.
const foreground = markSvg({ opaque: false, scale: 0.8 })

// Web + iOS
await writePng(opaque, 180, 'public/apple-touch-icon.png')
await writePng(opaque, 1024, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')

// Android legacy launcher icons (pre-8.0 devices) + adaptive foregrounds
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [dpi, mult] of Object.entries(densities)) {
  const dir = `android/app/src/main/res/mipmap-${dpi}`
  await writePng(opaque, 48 * mult, `${dir}/ic_launcher.png`)
  await writeRoundPng(opaque, 48 * mult, `${dir}/ic_launcher_round.png`)
  await writePng(foreground, 108 * mult, `${dir}/ic_launcher_foreground.png`)
}
