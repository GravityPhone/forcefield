// Assemble the demo: trim each shot from its scene recording, burn the
// caption, normalize to 1080×1920/30fps H.264, concat → media/final.mp4.
//
// Usage: node demo-studio/auto/assemble.mjs

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const MEDIA = join(HERE, '..', 'media')
const SHOTS = join(MEDIA, 'shots')
const CLIPS = join(MEDIA, 'clips')
mkdirSync(CLIPS, { recursive: true })

// Final cut: shot order + trims. `max`/`anchor:'end'` keeps only the tail of
// an over-long recording (off-camera waits get baked into some shot spans);
// `parts` slices multiple clips out of one shot (cutting dead air).
const CUTS = [
  { id: 'title' },
  { id: 'login', max: 11 , anchor: 'end' },
  { id: 'talk-search' }, { id: 'talk-roster' }, { id: 'talk-signed' }, { id: 'talk-next' },
  { id: 'scout-flip' },
  { id: 'scout-orient', max: 8, anchor: 'end' },
  { id: 'scout-pins', max: 15, anchor: 'end' },
  { id: 'scout-pin-tap' },
  { id: 'squad-cards' }, { id: 'squad-live' },
  { id: 'squad-assign', max: 18, anchor: 'end' },
  { id: 'chat' },
  { id: 'feed' },
  { id: 'leaders' },
  { id: 'ai', parts: [{ from: 0, len: 6.5 }, { fromEnd: 9 }] },
  { id: 'style-theme' },
  { id: 'style-emoji', max: 11, anchor: 'end' },
  { id: 'close' },
]

const FONT = join(MEDIA, 'font.ttf')
for (const c of ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf']) {
  if (!existsSync(FONT) && existsSync(c)) copyFileSync(c, FONT)
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed:\n${err.slice(-1200)}`))))
  })
}

const manifest = JSON.parse(readFileSync(join(SHOTS, 'manifest.json'), 'utf8'))

// Flatten shots
const shotIndex = {}
for (const [sceneId, scene] of Object.entries(manifest.scenes)) {
  for (const s of scene.shots) shotIndex[s.shotId] = { ...s, file: scene.file }
}

async function makeClip(name, srcFile, tIn, tOut, caption) {
  const out = join(CLIPS, `${name}.mp4`)
  const dur = Math.max(0.5, tOut - tIn)
  const vf = ['scale=1080:1920:force_original_aspect_ratio=decrease',
    'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0b1622', 'fps=30', 'format=yuv420p']
  if (caption) {
    writeFileSync(join(CLIPS, `${name}.txt`), caption, 'utf8')
    vf.push(`drawtext=fontfile=font.ttf:textfile=clips/${name}.txt:x=(w-text_w)/2:y=h-300:fontsize=52:fontcolor=white:borderw=2:bordercolor=black@0.35:box=1:boxcolor=0x0b1622@0.72:boxborderw=22`)
  }
  await run('ffmpeg', ['-y', '-ss', tIn.toFixed(2), '-t', dur.toFixed(2), '-i', join(SHOTS, srcFile),
    '-vf', vf.join(','), '-an',
    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium',
    '-movflags', '+faststart', out], MEDIA)
  console.log(`clip ${name}: ${dur.toFixed(1)}s${caption ? ' — "' + caption + '"' : ''}`)
  return out
}

const made = []
for (const cut of CUTS) {
  const s = shotIndex[cut.id]
  if (!s) { console.log(`SKIP ${cut.id} (not recorded)`); continue }
  if (cut.parts) {
    for (let i = 0; i < cut.parts.length; i++) {
      const p = cut.parts[i]
      const tIn = p.fromEnd != null ? Math.max(s.tIn, s.tOut - p.fromEnd) : s.tIn + (p.from ?? 0)
      const tOut = p.len != null ? Math.min(s.tOut, tIn + p.len) : s.tOut
      made.push(await makeClip(`${cut.id}-${i}`, s.file, tIn, tOut, s.caption))
    }
    continue
  }
  let tIn = s.tIn
  let tOut = s.tOut
  if (cut.max && tOut - tIn > cut.max) {
    if (cut.anchor === 'end') tIn = tOut - cut.max
    else tOut = tIn + cut.max
  }
  made.push(await makeClip(cut.id, s.file, tIn, tOut, s.caption))
}

if (!made.length) throw new Error('no clips')

const listFile = join(MEDIA, '_autoconcat.txt')
writeFileSync(listFile, made.map((p) => `file '${p.replaceAll('\\', '/')}'`).join('\n'))
const final = join(MEDIA, 'final.mp4')
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', final], MEDIA)

// probe
await new Promise((resolve) => {
  const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', final])
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.on('close', () => { console.log(`\nfinal.mp4: ${parseFloat(out).toFixed(1)}s, ${made.length} clips`); resolve() })
})
