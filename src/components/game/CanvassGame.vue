<script setup lang="ts">
// Clipboard Canvass — the easter-egg flappy clone. You are a clipboard
// gliding down a suburban street; tap to stay airborne and thread the gaps
// between fences, brick walls and hedges (watch for NO SOLICITING signs).
// Nothing moves except you and the scrolling world, Flappy Bird-style, and
// the difficulty ramps the same way: a touch faster and a touch tighter
// with every door knocked. Unlocked by tapping the chat handle 25 times.
import { onMounted, onUnmounted, ref } from 'vue'
import { hapticTap } from '@/lib/native'

const emit = defineEmits<{ close: [] }>()

const BEST_KEY = 'forcefield.canvass_game_best'

const canvasEl = ref<HTMLCanvasElement | null>(null)
const phase = ref<'ready' | 'playing' | 'dead'>('ready')
const score = ref(0)
const best = ref(Number(localStorage.getItem(BEST_KEY)) || 0)
const deathLine = ref('')

// Death flavor: the app's own outcome vocabulary, weaponized.
const DEATH_LINES = [
  'Door slammed!',
  'Marked: Hostile.',
  'Not home… but the fence was.',
  'No soliciting means you.',
  'The HOA has questions.',
  'Skip. Definitely a skip.',
]

// --- World state (plain lets — none of this needs reactivity) ---

let ctx: CanvasRenderingContext2D | null = null
let W = 0
let H = 0
let raf = 0
let last = 0
let worldX = 0 // total scroll distance, drives parallax + ground pattern

// Clipboard (the "bird") — y is its center; x is fixed at 28% of width.
const CLIP_W = 34
const CLIP_H = 42
const GRAVITY = 1600 // px/s²
const FLAP = -430 // px/s
let y = 0
let vy = 0

// Obstacles: a top + bottom structure with a gap, one visual variant each.
// 0 = picket fence, 1 = brick wall, 2 = hedge.
interface Obstacle {
  x: number
  gapY: number
  gapH: number
  variant: number
  sign: boolean
  passed: boolean
}
const OB_W = 74
const OB_SPACING = 255
const GROUND_H = 58
let obstacles: Obstacle[] = []
let diedAt = 0

// Flappy-style ramp: each door knocked nudges speed up and the gap tighter,
// both capped so it stays humanly possible.
const speedNow = () => Math.min(245, 155 + score.value * 2.2)
const gapNow = () => Math.max(132, 178 - score.value * 1.1)

function clipX() {
  return W * 0.28
}

function groundY() {
  return H - GROUND_H
}

function reset() {
  score.value = 0
  vy = 0
  y = H * 0.42
  obstacles = []
  worldX = 0
}

function spawnObstacles() {
  let lastX = obstacles.length ? obstacles[obstacles.length - 1].x : W + 60
  while (lastX < W + OB_SPACING) {
    const gapH = gapNow()
    const minY = 70
    const maxY = groundY() - gapH - 70
    const gapY = minY + Math.random() * Math.max(0, maxY - minY)
    const variant = Math.floor(Math.random() * 3)
    obstacles.push({
      x: lastX + OB_SPACING,
      gapY,
      gapH,
      variant,
      // Signs only read right on fences/walls, not shrubbery.
      sign: variant !== 2 && Math.random() < 0.45,
      passed: false,
    })
    lastX += OB_SPACING
  }
}

function flap() {
  vy = FLAP
}

function die() {
  phase.value = 'dead'
  diedAt = performance.now()
  deathLine.value = DEATH_LINES[Math.floor(Math.random() * DEATH_LINES.length)]
  if (score.value > best.value) {
    best.value = score.value
    localStorage.setItem(BEST_KEY, String(best.value))
  }
  hapticTap('medium')
}

function onTap() {
  if (phase.value === 'ready') {
    reset()
    phase.value = 'playing'
    flap()
    hapticTap('light')
  } else if (phase.value === 'playing') {
    flap()
  } else if (performance.now() - diedAt > 500) {
    // Small cooldown so a panic tap at death doesn't instantly restart.
    reset()
    phase.value = 'playing'
    flap()
    hapticTap('light')
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === ' ' || e.key === 'ArrowUp') {
    e.preventDefault()
    onTap()
  }
}

// --- Simulation ---

function step(dt: number) {
  if (phase.value === 'playing') {
    worldX += speedNow() * dt
    vy += GRAVITY * dt
    y += vy * dt

    // Ceiling is soft (bounce off), the ground is not.
    if (y < CLIP_H / 2) {
      y = CLIP_H / 2
      vy = 0
    }
    if (y + CLIP_H / 2 >= groundY()) {
      y = groundY() - CLIP_H / 2
      die()
      return
    }

    spawnObstacles()
    const cx = clipX()
    const speed = speedNow()
    for (const ob of obstacles) {
      ob.x -= speed * dt
      if (!ob.passed && ob.x + OB_W < cx - CLIP_W / 2) {
        ob.passed = true
        score.value += 1
      }
    }
    obstacles = obstacles.filter((o) => o.x > -OB_W - 10)

    // AABB with a little forgiveness at the edges.
    const inset = 4
    const left = cx - CLIP_W / 2 + inset
    const right = cx + CLIP_W / 2 - inset
    const top = y - CLIP_H / 2 + inset
    const bottom = y + CLIP_H / 2 - inset
    for (const ob of obstacles) {
      if (right > ob.x && left < ob.x + OB_W) {
        if (top < ob.gapY || bottom > ob.gapY + ob.gapH) {
          die()
          return
        }
      }
    }
  } else if (phase.value === 'ready') {
    // Idle bob on the start screen, street drifting past slowly.
    worldX += 40 * dt
    y = H * 0.42 + Math.sin(performance.now() / 300) * 8
  }
}

// --- Drawing (all procedural, no assets) ---

function roundedRect(c: CanvasRenderingContext2D, x: number, ry: number, w: number, h: number, r: number) {
  c.beginPath()
  c.moveTo(x + r, ry)
  c.arcTo(x + w, ry, x + w, ry + h, r)
  c.arcTo(x + w, ry + h, x, ry + h, r)
  c.arcTo(x, ry + h, x, ry, r)
  c.arcTo(x, ry, x + w, ry, r)
  c.closePath()
}

function drawSky(c: CanvasRenderingContext2D) {
  const g = c.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#7ecbee')
  g.addColorStop(1, '#dcf2fb')
  c.fillStyle = g
  c.fillRect(0, 0, W, H)

  // Clouds, slow parallax.
  c.fillStyle = 'rgba(255,255,255,0.85)'
  const span = W + 260
  for (let i = 0; i < 3; i++) {
    const cx = span - (((worldX * 0.15 + i * (span / 3)) % span) + 130) + 130
    const cy = H * (0.12 + i * 0.09)
    c.beginPath()
    c.ellipse(cx, cy, 46, 16, 0, 0, Math.PI * 2)
    c.ellipse(cx - 28, cy + 6, 30, 12, 0, 0, Math.PI * 2)
    c.ellipse(cx + 30, cy + 7, 32, 13, 0, 0, Math.PI * 2)
    c.fill()
  }

  // Distant houses along the street, mid parallax.
  const HOUSE_SPAN = 150
  const scroll = worldX * 0.4
  const palette = ['#c8b7d9', '#b7cfd9', '#d9ccb7', '#c3d9b7']
  const first = Math.floor(scroll / HOUSE_SPAN)
  for (let i = first; i <= first + Math.ceil(W / HOUSE_SPAN) + 1; i++) {
    const hx = i * HOUSE_SPAN - scroll
    const hh = 54 + ((i * 29) % 36)
    const hw = 92
    const hy = groundY() - hh
    c.fillStyle = palette[((i % 4) + 4) % 4]
    c.fillRect(hx, hy, hw, hh)
    // Roof
    c.fillStyle = '#7a6a5e'
    c.beginPath()
    c.moveTo(hx - 8, hy)
    c.lineTo(hx + hw / 2, hy - 26)
    c.lineTo(hx + hw + 8, hy)
    c.closePath()
    c.fill()
    // Door — it is a canvassing game, after all.
    c.fillStyle = '#5e4634'
    c.fillRect(hx + hw / 2 - 9, groundY() - 26, 18, 26)
  }
}

function drawGround(c: CanvasRenderingContext2D) {
  const gy = groundY()
  // Grass strip, then sidewalk.
  c.fillStyle = '#5c9c50'
  c.fillRect(0, gy, W, 8)
  c.fillStyle = '#cdc8bb'
  c.fillRect(0, gy + 8, W, GROUND_H - 8)
  // Sidewalk seams scroll with the world.
  c.strokeStyle = '#b3ada0'
  c.lineWidth = 2
  const SEG = 64
  const off = worldX % SEG
  for (let x = -off; x < W; x += SEG) {
    c.beginPath()
    c.moveTo(x, gy + 8)
    c.lineTo(x, gy + GROUND_H)
    c.stroke()
  }
}

function drawPicket(c: CanvasRenderingContext2D, x: number, yTop: number, h: number, pointsDown: boolean) {
  c.fillStyle = '#f2eee2'
  c.fillRect(x, yTop, OB_W, h)
  const SLAT = 14
  const TIP = 9
  c.fillStyle = '#dcd6c4'
  for (let i = 0; i < OB_W / SLAT; i++) {
    const sx = x + i * SLAT
    if (i % 2 === 1) c.fillRect(sx, yTop, SLAT - 2, h)
    // Pointed tips facing the gap.
    c.beginPath()
    if (pointsDown) {
      c.moveTo(sx, yTop + h)
      c.lineTo(sx + (SLAT - 2) / 2, yTop + h + TIP)
      c.lineTo(sx + SLAT - 2, yTop + h)
    } else {
      c.moveTo(sx, yTop)
      c.lineTo(sx + (SLAT - 2) / 2, yTop - TIP)
      c.lineTo(sx + SLAT - 2, yTop)
    }
    c.closePath()
    c.fillStyle = i % 2 === 1 ? '#dcd6c4' : '#f2eee2'
    c.fill()
  }
  // Rails
  c.fillStyle = '#c9c2ac'
  const railY = pointsDown ? yTop + h - 18 : yTop + 12
  c.fillRect(x, railY, OB_W, 5)
  if (h > 70) c.fillRect(x, pointsDown ? yTop + h - 52 : yTop + 46, OB_W, 5)
}

function drawBrick(c: CanvasRenderingContext2D, x: number, yTop: number, h: number, capDown: boolean) {
  c.fillStyle = '#b0563f'
  c.fillRect(x, yTop, OB_W, h)
  c.strokeStyle = '#8f4232'
  c.lineWidth = 1.5
  for (let by = yTop + 13; by < yTop + h; by += 13) {
    c.beginPath()
    c.moveTo(x, by)
    c.lineTo(x + OB_W, by)
    c.stroke()
  }
  for (let row = 0; row * 13 < h; row++) {
    const stagger = row % 2 === 0 ? 0 : 13
    for (let bx = x + stagger; bx < x + OB_W; bx += 26) {
      c.beginPath()
      c.moveTo(bx, yTop + row * 13)
      c.lineTo(bx, Math.min(yTop + row * 13 + 13, yTop + h))
      c.stroke()
    }
  }
  // Capstone facing the gap.
  c.fillStyle = '#cfc7b8'
  const capY = capDown ? yTop + h - 10 : yTop
  c.fillRect(x - 3, capY, OB_W + 6, 10)
}

function drawHedge(c: CanvasRenderingContext2D, x: number, yTop: number, h: number, bumpsDown: boolean) {
  c.fillStyle = '#3f7d3a'
  c.fillRect(x, yTop, OB_W, h)
  // Leafy blobs along the gap-facing edge.
  c.fillStyle = '#4c9345'
  const edge = bumpsDown ? yTop + h : yTop
  for (let i = 0; i < 5; i++) {
    const bx = x + 8 + i * 15
    c.beginPath()
    c.arc(bx, edge, 11, 0, Math.PI * 2)
    c.fill()
  }
  // Texture dots (deterministic, tied to column position so they don't shimmer).
  c.fillStyle = '#356b31'
  for (let i = 0; i < 14; i++) {
    const dx = x + ((i * 37) % (OB_W - 12)) + 6
    const dy = yTop + 12 + ((i * 53) % Math.max(1, h - 24))
    c.beginPath()
    c.arc(dx, dy, 4, 0, Math.PI * 2)
    c.fill()
  }
}

function drawSign(c: CanvasRenderingContext2D, x: number, yTop: number) {
  const sw = 60
  const sh = 28
  const sx = x + (OB_W - sw) / 2
  const sy = yTop + 14
  c.fillStyle = '#ffffff'
  c.strokeStyle = '#c0392b'
  c.lineWidth = 2.5
  roundedRect(c, sx, sy, sw, sh, 4)
  c.fill()
  c.stroke()
  c.fillStyle = '#c0392b'
  c.textAlign = 'center'
  c.font = '800 10px system-ui, sans-serif'
  c.fillText('NO', sx + sw / 2, sy + 12)
  c.font = '800 7.5px system-ui, sans-serif'
  c.fillText('SOLICITING', sx + sw / 2, sy + 22)
}

function drawObstacle(c: CanvasRenderingContext2D, ob: Obstacle) {
  const topH = ob.gapY
  const botY = ob.gapY + ob.gapH
  const botH = groundY() - botY
  if (ob.variant === 0) {
    drawPicket(c, ob.x, 0, topH, true)
    drawPicket(c, ob.x, botY, botH, false)
  } else if (ob.variant === 1) {
    drawBrick(c, ob.x, 0, topH, true)
    drawBrick(c, ob.x, botY, botH, false)
  } else {
    drawHedge(c, ob.x, 0, topH, true)
    drawHedge(c, ob.x, botY, botH, false)
  }
  if (ob.sign && botH > 50) drawSign(c, ob.x, botY)
}

function drawClipboard(c: CanvasRenderingContext2D) {
  const cx = clipX()
  const rot = phase.value === 'playing' ? Math.max(-0.35, Math.min(1.1, vy / 550)) : 0
  c.save()
  c.translate(cx, y)
  c.rotate(rot)
  // Board
  c.fillStyle = '#a5713f'
  c.strokeStyle = '#7c5227'
  c.lineWidth = 2
  roundedRect(c, -CLIP_W / 2, -CLIP_H / 2, CLIP_W, CLIP_H, 5)
  c.fill()
  c.stroke()
  // Paper
  c.fillStyle = '#fdfdf8'
  c.fillRect(-CLIP_W / 2 + 5, -CLIP_H / 2 + 8, CLIP_W - 10, CLIP_H - 13)
  c.strokeStyle = '#c8c8c0'
  c.lineWidth = 1.5
  for (let i = 0; i < 3; i++) {
    const ly = -CLIP_H / 2 + 15 + i * 7
    c.beginPath()
    c.moveTo(-CLIP_W / 2 + 8, ly)
    c.lineTo(CLIP_W / 2 - 8, ly)
    c.stroke()
  }
  // A signature line with a checkmark — petitions get signed around here.
  c.strokeStyle = '#3f8f4f'
  c.lineWidth = 2
  c.beginPath()
  c.moveTo(-5, CLIP_H / 2 - 12)
  c.lineTo(-1, CLIP_H / 2 - 8)
  c.lineTo(7, CLIP_H / 2 - 17)
  c.stroke()
  // Metal clip
  c.fillStyle = '#9aa2ad'
  roundedRect(c, -9, -CLIP_H / 2 - 4, 18, 10, 3)
  c.fill()
  c.restore()
}

function drawHud(c: CanvasRenderingContext2D) {
  if (phase.value === 'ready') return
  c.textAlign = 'center'
  c.font = '800 44px system-ui, sans-serif'
  c.lineWidth = 6
  c.strokeStyle = 'rgba(0,0,0,0.45)'
  c.strokeText(String(score.value), W / 2, H * 0.14)
  c.fillStyle = '#fff'
  c.fillText(String(score.value), W / 2, H * 0.14)
}

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  const dt = Math.min(0.032, (now - last) / 1000 || 0)
  last = now
  if (!ctx || !W) return
  if (phase.value !== 'dead') step(dt)
  const c = ctx
  drawSky(c)
  for (const ob of obstacles) drawObstacle(c, ob)
  drawGround(c)
  drawClipboard(c)
  drawHud(c)
}

// --- Lifecycle / sizing ---

function resize() {
  const el = canvasEl.value
  if (!el) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  W = window.innerWidth
  H = window.innerHeight
  el.width = Math.round(W * dpr)
  el.height = Math.round(H * dpr)
  ctx = el.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (phase.value === 'ready') y = H * 0.42
}

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('keydown', onKey)
  last = performance.now()
  raf = requestAnimationFrame(frame)
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="game-overlay" @pointerdown="onTap">
    <canvas ref="canvasEl" class="game-canvas"></canvas>
    <button class="game-close" aria-label="Close game" @pointerdown.stop="emit('close')">✕</button>

    <div v-if="phase === 'ready'" class="game-card game-ready">
      <h2>Clipboard Canvass</h2>
      <p>Tap to stay airborne.<br />Clear the fences. Knock the doors.</p>
      <p class="pulse">Tap to start</p>
    </div>

    <div v-if="phase === 'dead'" class="game-card game-over">
      <h2>{{ deathLine }}</h2>
      <p class="go-score">{{ score }} door{{ score === 1 ? '' : 's' }} knocked</p>
      <p class="go-best">Best: {{ best }}</p>
      <p class="pulse">Tap to canvass again</p>
    </div>
  </div>
</template>

<style scoped>
.game-overlay {
  position: fixed;
  inset: 0;
  z-index: 60; /* above the tab bar (40) and chat drawer (46/47) */
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  cursor: pointer;
}

.game-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.game-close {
  position: absolute;
  top: calc(0.75rem + env(safe-area-inset-top, 0px));
  right: 0.75rem;
  width: 2.6rem;
  height: 2.6rem;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 1.1rem;
  font-weight: 700;
  cursor: pointer;
}

.game-card {
  position: absolute;
  top: 34%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(320px, 84vw);
  padding: 1.1rem 1.2rem;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.94);
  color: #2b2b33;
  text-align: center;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  pointer-events: none; /* taps fall through to the game */
}

.game-card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.3rem;
}

.game-card p {
  margin: 0.25rem 0;
  font-size: 0.95rem;
}

.go-score {
  font-weight: 800;
  font-size: 1.1rem;
}

.go-best {
  color: #6b6b75;
  font-size: 0.85rem;
}

.pulse {
  margin-top: 0.7rem;
  font-weight: 700;
  color: #ff6d00; /* the chat handle's orange — where you came from */
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
