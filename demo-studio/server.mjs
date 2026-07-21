// Forcefield Demo Studio — local one-off tool for producing the demo video.
// Zero npm dependencies; needs `ffmpeg`/`ffprobe` on PATH.
// Run: node demo-studio/server.mjs   →   http://localhost:4599

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const MEDIA = path.join(ROOT, 'media')
const PROJECT = path.join(ROOT, 'project.json')
const SEED = path.join(ROOT, 'project.seed.json')
const PORT = 4599

fs.mkdirSync(MEDIA, { recursive: true })
if (!fs.existsSync(PROJECT)) fs.copyFileSync(SEED, PROJECT)

const readProject = () => JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
const writeProject = (p) => { fs.writeFileSync(PROJECT, JSON.stringify(p, null, 2)); return p }

// ---------- process helpers ----------

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

// cwd = MEDIA so filter strings can use relative paths (a Windows drive-letter
// colon inside drawtext's fontfile breaks the filtergraph parser).
async function ff(args) {
  const r = await run('ffmpeg', args, MEDIA)
  if (r.code !== 0) throw new Error('ffmpeg failed:\n' + r.err.slice(-1500))
}

async function probeDuration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  const n = parseFloat(r.out.trim())
  return Number.isFinite(n) ? n : 0
}

// ---------- render pipeline ----------

const FONT = path.join(MEDIA, 'font.ttf')
for (const candidate of ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf']) {
  if (!fs.existsSync(FONT) && fs.existsSync(candidate)) fs.copyFileSync(candidate, FONT)
}
const sanitizeLabel = (s) => String(s || '').replace(/[\\':,;\[\]]/g, ' ').trim()

// Mux one segment: cleaned voice + selected video, padded to whichever runs longer.
async function muxSegment(project, seg) {
  const v = seg.videoTakes.find((t) => t.id === seg.selectedVideo)
  const a = seg.audioTakes.find((t) => t.id === seg.selectedAudio)
  if (!v || !a) throw new Error(`"${seg.title}" needs a selected video take AND audio take`)

  const dir = path.join(MEDIA, seg.id)
  fs.mkdirSync(dir, { recursive: true })
  const vFile = path.join(MEDIA, v.file)
  const aFile = path.join(MEDIA, a.file)
  const voice = path.join(dir, 'voice.m4a')
  const preview = path.join(dir, 'preview.mp4')

  // Pass 1: trim leading silence, normalize loudness, settle format.
  await ff(['-y', '-i', aFile,
    '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
    '-ac', '2', '-c:a', 'aac', '-b:a', '192k', voice])

  const aDur = await probeDuration(voice)
  let vDur = await probeDuration(vFile)
  if (!vDur) vDur = v.duration || 0 // MediaRecorder webm often lacks duration metadata
  const target = Math.max(aDur + 0.4, vDur)

  const vf = [
    'scale=1920:1080:force_original_aspect_ratio=decrease',
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f1418',
    'fps=30',
    'format=yuv420p',
  ]
  if (target > vDur + 0.05) vf.push(`tpad=stop_mode=clone:stop_duration=${(target - vDur + 0.3).toFixed(2)}`)
  if (project.labels && seg.label && fs.existsSync(FONT)) {
    vf.push(`drawtext=fontfile=font.ttf:text='${sanitizeLabel(seg.label)}':x=72:y=h-th-88:fontsize=54:fontcolor=white:box=1:boxcolor=0x0f1418@0.55:boxborderw=18:enable='between(t,0.6,4.6)'`)
  }

  await ff(['-y', '-i', vFile, '-i', voice,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', vf.join(','), '-af', 'apad', '-t', target.toFixed(2),
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', preview])

  return preview
}

async function assemble(project) {
  const previews = []
  const skipped = []
  for (const seg of project.segments) {
    if (seg.selectedVideo && seg.selectedAudio) {
      previews.push(await muxSegment(project, seg))
    } else {
      skipped.push(seg.title)
    }
  }
  if (!previews.length) throw new Error('No segment has both an audio and a video take selected')

  const listFile = path.join(MEDIA, '_concat.txt')
  fs.writeFileSync(listFile, previews.map((p) => `file '${p.replaceAll('\\', '/')}'`).join('\n'))
  const program = path.join(MEDIA, '_program.mp4')

  // Identical encode settings → stream copy should concat cleanly; re-encode as fallback.
  const copy = await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', program])
  if (copy.code !== 0) {
    const inputs = previews.flatMap((p) => ['-i', p])
    const pads = previews.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('')
    await ff(['-y', ...inputs,
      '-filter_complex', `${pads}concat=n=${previews.length}:v=1:a=1[v][a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', program])
  }

  const final = path.join(MEDIA, 'final.mp4')
  const musicFile = project.music ? path.join(MEDIA, project.music) : null
  if (musicFile && fs.existsSync(musicFile)) {
    const dur = await probeDuration(program)
    const vol = Number(project.musicVolume) || 0.22
    const fadeStart = Math.max(0, dur - 3)
    await ff(['-y', '-i', program, '-stream_loop', '-1', '-i', musicFile,
      '-filter_complex',
      `[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol},atrim=0:${dur.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(2)}:d=3[m];` +
      `[m][0:a]sidechaincompress=threshold=0.05:ratio=10:attack=5:release=350[duck];` +
      `[0:a][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`,
      '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', final])
  } else {
    fs.copyFileSync(program, final)
  }
  return { url: '/media/final.mp4', skipped }
}

// ---------- http plumbing ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
}

function serveFile(req, res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404); res.end('not found'); return
  }
  const size = fs.statSync(filePath).size
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return }
    end = Math.min(end, size - 1)
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(filePath).pipe(res)
  }
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const q = url.searchParams
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveFile(req, res, path.join(PUBLIC, 'index.html'))
    }
    if (url.pathname.startsWith('/media/')) {
      const rel = decodeURIComponent(url.pathname.slice('/media/'.length))
      const full = path.join(MEDIA, rel)
      if (!full.startsWith(MEDIA)) { res.writeHead(403); return res.end() }
      return serveFile(req, res, full)
    }

    if (url.pathname === '/api/project' && req.method === 'GET') {
      return json(res, 200, readProject())
    }
    if (url.pathname === '/api/project' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8'))
      return json(res, 200, writeProject(body))
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const r = await run('ffmpeg', ['-version'])
      return json(res, 200, { ffmpeg: r.code === 0, version: r.code === 0 ? r.out.split('\n')[0] : null })
    }

    if (url.pathname === '/api/take' && req.method === 'POST') {
      const segId = q.get('seg'), kind = q.get('kind')
      const project = readProject()
      const seg = project.segments.find((s) => s.id === segId)
      if (!seg || (kind !== 'audio' && kind !== 'video')) throw new Error('bad seg/kind')
      const body = await readBody(req)
      if (!body.length) throw new Error('empty upload')
      const id = `${kind}-${Date.now()}`
      const dir = path.join(MEDIA, segId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${id}.webm`), body)
      const take = {
        id,
        file: `${segId}/${id}.webm`,
        duration: parseFloat(q.get('duration')) || 0,
        marks: (q.get('marks') || '').split(',').map(Number).filter(Number.isFinite),
        note: '',
        createdAt: new Date().toISOString(),
      }
      const list = kind === 'audio' ? seg.audioTakes : seg.videoTakes
      list.push(take)
      if (kind === 'audio') seg.selectedAudio = id
      else seg.selectedVideo = id
      return json(res, 200, writeProject(project))
    }

    if (url.pathname === '/api/music' && req.method === 'POST') {
      const name = q.get('name') || 'music.mp3'
      const ext = (path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.mp3')
      const body = await readBody(req)
      if (!body.length) throw new Error('empty upload')
      for (const f of fs.readdirSync(MEDIA)) {
        if (f.startsWith('music.')) fs.rmSync(path.join(MEDIA, f))
      }
      const file = `music${ext}`
      fs.writeFileSync(path.join(MEDIA, file), body)
      const project = readProject()
      project.music = file
      return json(res, 200, writeProject(project))
    }

    if (url.pathname === '/api/mux' && req.method === 'POST') {
      const project = readProject()
      const seg = project.segments.find((s) => s.id === q.get('seg'))
      if (!seg) throw new Error('unknown segment')
      await muxSegment(project, seg)
      return json(res, 200, { ok: true, url: `/media/${seg.id}/preview.mp4` })
    }

    if (url.pathname === '/api/assemble' && req.method === 'POST') {
      const result = await assemble(readProject())
      return json(res, 200, result)
    }

    res.writeHead(404); res.end('not found')
  } catch (e) {
    json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, () => {
  console.log(`Forcefield Demo Studio → http://localhost:${PORT}`)
  console.log('Open it in your normal browser (Chrome/Edge) — mic and screen capture need a real tab.')
})
