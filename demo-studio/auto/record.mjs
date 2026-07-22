// Forcefield demo recorder — drives the live app in headless Chromium and
// records true 1080×1920 phone-layout video per scene.
//
// The trick: --window-size=432,768 with --force-device-scale-factor=2.5 gives
// a 432-CSS-px mobile viewport rendered on a 1080×1920 physical surface, and
// recordVideo captures at that physical size (verified — Playwright's DSF
// emulation does NOT do this).
//
// One "scene" = one browser context = one webm; scenes contain "shots" whose
// in/out marks land in media/shots/manifest.json for assemble.mjs to trim +
// caption. Sim passwords are read from gitignored SIM-USERS.md at runtime.
//
// Usage: node demo-studio/auto/record.mjs [sceneId ...]   (no args = all)

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const MEDIA = join(REPO, 'demo-studio', 'media')
const SHOTS = join(MEDIA, 'shots')
const STATE = join(HERE, 'state')
const BASE = 'https://forcefield.ninja'
const SUPABASE_URL = 'https://whrliwbdxjdcksbvwkrc.supabase.co'
const ANON_KEY = 'sb_publishable_JcZe2JFmhQGFK_Mddet4EA_IWZw4727'

mkdirSync(SHOTS, { recursive: true })
mkdirSync(STATE, { recursive: true })

const plan = JSON.parse(readFileSync(join(HERE, 'demo-plan.json'), 'utf8'))
const simPassword = () => {
  const txt = readFileSync(join(REPO, 'SIM-USERS.md'), 'utf8')
  return txt.match(/one password: `([^`]+)`/)[1]
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (base, spread) => base + Math.random() * spread

/** Visible tap ripple at every pointerdown — the phone-metaphor cue that a
 * tap happened, since there's no visible cursor in the recording. */
const RIPPLE_SCRIPT = `
  (() => {
    if (window.__rippleInstalled) return
    window.__rippleInstalled = true
    const style = document.createElement('style')
    style.textContent = '@keyframes ffr{0%{transform:translate(-50%,-50%) scale(.25);opacity:.85}100%{transform:translate(-50%,-50%) scale(1.6);opacity:0}}'
    const add = () => document.head ? document.head.appendChild(style) : setTimeout(add, 5)
    add()
    addEventListener('pointerdown', (e) => {
      const d = document.createElement('div')
      d.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:56px;height:56px;border-radius:50%;background:rgba(255,120,30,.45);border:3px solid rgba(255,120,30,.85);pointer-events:none;z-index:2147483647;animation:ffr .55s ease-out forwards'
      document.body.appendChild(d)
      setTimeout(() => d.remove(), 600)
    }, true)
  })()
`

async function humanMove(page, x, y) {
  await page.mouse.move(x, y, { steps: 18 })
}

async function tapXY(page, x, y, opts = {}) {
  await humanMove(page, x, y)
  await sleep(jitter(120, 120))
  await page.mouse.down()
  await sleep(jitter(70, 50))
  await page.mouse.up()
  if (!opts.noPause) await sleep(jitter(350, 250))
}

async function waitScrollSettle(page) {
  let last = -1
  for (let i = 0; i < 40; i++) {
    const y = await page.evaluate(() => window.scrollY)
    if (y === last) return
    last = y
    await sleep(140)
  }
}

async function tap(page, locator, opts = {}) {
  const el = locator.first()
  await el.waitFor({ state: 'visible', timeout: opts.timeout ?? 15000 })
  await el.scrollIntoViewIfNeeded()
  await waitScrollSettle(page)
  const box = await el.boundingBox()
  if (box) await humanMove(page, box.x + box.width / 2, box.y + box.height / 2)
  await sleep(jitter(140, 120))
  // click() re-checks the element is stable and hit-testable at the point —
  // the raw-coordinate version kept drifting onto the bottom nav mid-scroll.
  await el.click({ delay: 70 })
  if (!opts.noPause) await sleep(jitter(350, 250))
}

async function humanType(page, locator, text) {
  await tap(page, locator, { noPause: true })
  await sleep(300)
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(jitter(60, 90))
  }
}

/** Eased page scroll in a few smooth chunks; settles before returning. */
async function easeScroll(page, totalPx, chunks = 3) {
  const per = Math.round(totalPx / chunks)
  for (let i = 0; i < chunks; i++) {
    await page.evaluate((px) => window.scrollBy({ top: px, behavior: 'smooth' }), per)
    await sleep(jitter(650, 250))
  }
  await waitScrollSettle(page)
}

/** Drag the map (content follows finger). dx/dy = how far the FINGER moves. */
async function dragMap(page, fromX, fromY, dx, dy) {
  await page.mouse.move(fromX, fromY, { steps: 8 })
  await page.mouse.down()
  await sleep(90)
  const steps = 26
  for (let i = 1; i <= steps; i++) {
    // ease-in-out
    const t = i / steps
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    await page.mouse.move(fromX + dx * e, fromY + dy * e)
    await sleep(16)
  }
  await sleep(120)
  await page.mouse.up()
  await sleep(600)
}

/** Wheel-zoom the map at a point; each notch animates. */
async function wheelZoom(page, x, y, notches) {
  await page.mouse.move(x, y, { steps: 10 })
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.mouse.wheel(0, notches > 0 ? -240 : 240)
    await sleep(750)
  }
}

// ---------------------------------------------------------------- login states

async function ensureState(browser, handle) {
  const file = join(STATE, `${handle}.json`)
  if (existsSync(file)) return file
  const ctx = await browser.newContext({ viewport: null })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`)
  await page.fill('#username', handle)
  await page.fill('#password', simPassword())
  await page.click('button[type=submit]')
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 })
  await sleep(1500)
  await ctx.storageState({ path: file })
  await ctx.close()
  console.log(`state saved: ${handle}`)
  return file
}

// ---------------------------------------------------------------- scene runner

const manifestPath = join(SHOTS, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { scenes: {} }
const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

let browser

async function runScene(scene) {
  console.log(`\n=== scene ${scene.id} ===`)
  const stateFile = scene.persona ? await ensureState(browser, scene.persona) : undefined
  const ctx = await browser.newContext({
    viewport: null,
    storageState: stateFile,
    recordVideo: { dir: SHOTS, size: { width: 1080, height: 1920 } },
  })
  await ctx.addInitScript(RIPPLE_SCRIPT)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)) })
  const t0 = Date.now()
  const marks = []
  const api = {
    page,
    ctx,
    plan,
    tap: (loc, o) => tap(page, loc, o),
    tapXY: (x, y, o) => tapXY(page, x, y, o),
    type: (loc, text) => humanType(page, loc, text),
    scroll: (px, chunks) => easeScroll(page, px, chunks),
    dragMap: (x, y, dx, dy) => dragMap(page, x, y, dx, dy),
    wheelZoom: (x, y, n) => wheelZoom(page, x, y, n),
    sleep,
    markIn(shotId, caption) {
      marks.push({ shotId, caption, tIn: (Date.now() - t0) / 1000, tOut: null })
      console.log(`  [in ] ${shotId} @ ${marks[marks.length - 1].tIn.toFixed(1)}s`)
    },
    markOut() {
      const m = marks[marks.length - 1]
      m.tOut = (Date.now() - t0) / 1000
      console.log(`  [out] ${m.shotId} @ ${m.tOut.toFixed(1)}s`)
    },
  }
  let err = null
  try {
    await scene.run(api)
  } catch (e) {
    err = e
    console.error(`scene ${scene.id} FAILED:`, e.message)
  }
  const video = page.video()
  await ctx.close()
  const raw = await video.path()
  const dest = join(SHOTS, `${scene.id}.webm`)
  try { renameSync(raw, dest) } catch { /* already there */ }
  if (!err) {
    manifest.scenes[scene.id] = { file: `${scene.id}.webm`, shots: marks }
    saveManifest()
  }
  if (err) throw err
}

// ---------------------------------------------------------------- map geometry

/** Screen-px offset between two lat/lng points at a given zoom (CSS px). */
function pxDelta(from, to, zoom, lat = 40.26) {
  const world = 256 * 2 ** zoom
  const dxPx = ((to.lng - from.lng) / 360) * world
  const mercY = (l) => Math.log(Math.tan(Math.PI / 4 + (l * Math.PI) / 360))
  const dyPx = -((mercY(to.lat) - mercY(from.lat)) / (2 * Math.PI)) * world
  return { dx: dxPx, dy: dyPx }
}

/** Wait for a "Locating nearby doors…" pass to fully finish. The indicator
 * may appear a beat late (geocode queue), so wait for it to show first (or
 * time out quietly when the street was already fully geocoded). */
async function waitLocateCycle(page) {
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('Locating nearby doors'),
      { timeout: 6000 },
    )
  } catch { /* never appeared — nothing to geocode */ }
  await page.waitForFunction(
    () => !document.body.innerText.includes('Locating nearby doors'),
    { timeout: 240000 },
  )
}

async function mapBox(page) {
  const el = page.locator('.map, .squad-map').first()
  await el.waitFor({ state: 'visible' })
  return el.boundingBox()
}

/** Pan the map (human drags) until `target` lat/lng sits near the map
 * center. Anchors on whatever turf door pin is currently on screen — house
 * numbers that are unique across the turf map 1:1 to known lat/lngs, which
 * pins screen position to geography exactly (no dead reckoning). */
async function panToTurfTarget(page, target, zoom) {
  const counts = {}
  for (const d of plan.turfDoors) counts[d.house] = (counts[d.house] || 0) + 1
  const uniq = new Map(plan.turfDoors.filter((d) => counts[d.house] === 1).map((d) => [String(d.house), d]))
  const world = 256 * 2 ** zoom
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  for (let i = 0; i < 10; i++) {
    const box = await mapBox(page)
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const anchor = await page.evaluate((houses) => {
      for (const el of document.querySelectorAll('div[data-house]')) {
        const h = el.dataset.house
        if (!houses.includes(h)) continue
        const r = el.getBoundingClientRect()
        if (!r.width) continue
        return { house: h, x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      return null
    }, [...uniq.keys()])
    if (!anchor) throw new Error('no unique-house anchor pin on screen')
    const aDoor = uniq.get(anchor.house)
    const tx = anchor.x + ((target.lng - aDoor.lng) / 360) * world
    const ty = anchor.y - ((mercY(target.lat) - mercY(aDoor.lat)) / (2 * Math.PI)) * world
    const vx = center.x - tx
    const vy = center.y - ty
    if (Math.abs(vx) < 45 && Math.abs(vy) < 45) return
    const stepX = Math.max(-240, Math.min(240, vx))
    const stepY = Math.max(-240, Math.min(240, vy))
    await dragMap(page, center.x, center.y, stepX, stepY)
  }
  throw new Error('panToTurfTarget did not converge')
}

// ---------------------------------------------------------------- knock cue

/** Delete today's knocks by a persona that aren't in the seeded set — i.e.
 * whatever previous recording takes logged on camera. Keeps takes repeatable. */
async function cleanupExtraKnocks(handle) {
  const keep = new Set(plan.knockClientIdsByHandle[handle] ?? [])
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({
    email: `${handle}@example.com`,
    password: simPassword(),
  })
  if (error) throw new Error(`${handle} login: ${error.message}`)
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const { data: rows } = await client
    .from('knock_logs')
    .select('client_id')
    .eq('canvasser_id', data.user.id)
    .gte('occurred_at', midnight.toISOString())
  const extras = (rows ?? []).map((r) => r.client_id).filter((id) => !keep.has(id))
  for (const cid of extras) await client.from('knock_logs').delete().eq('client_id', cid)
  if (extras.length) console.log(`  cleaned ${extras.length} on-camera knocks for ${handle}`)
  await client.auth.signOut()
}

async function fireLiveKnock() {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({
    email: 'kayla-thorne@example.com',
    password: simPassword(),
  })
  if (error) throw new Error(`kayla login: ${error.message}`)
  const { error: kErr } = await client.from('knock_logs').upsert({
    client_id: randomUUID(),
    person_id: plan.cueDoor.personId,
    household_id: plan.cueDoor.id,
    canvasser_id: data.user.id,
    occurred_at: new Date().toISOString(),
    outcome: 'signed',
    notes: null,
  }, { onConflict: 'client_id' })
  if (kErr) throw new Error(`cue knock: ${kErr.message}`)
  await client.auth.signOut()
  console.log('  >> live knock fired at', plan.cueDoor.street)
}

// ---------------------------------------------------------------- scenes

const scenes = [
  {
    id: 'title',
    persona: null,
    run: async ({ page, markIn, markOut, sleep }) => {
      await page.goto('file://' + join(HERE, 'cards', 'title.html').replaceAll('\\', '/'))
      await sleep(600)
      markIn('title', null) // card carries its own text; no caption
      await sleep(6000)
      markOut()
    },
  },

  {
    id: 'login',
    persona: null,
    run: async (a) => {
      const { page } = a
      await page.goto(`${BASE}/login`)
      await page.waitForSelector('#username')
      await a.sleep(1200)
      a.markIn('login', 'Real field accounts. Real data.')
      await a.type(page.locator('#username'), 'tobias-lang')
      await a.sleep(250)
      await a.type(page.locator('#password'), simPassword())
      await a.sleep(350)
      await a.tap(page.locator('button[type=submit]'))
      await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 })
      await a.sleep(2600)
      a.markOut()
    },
  },

  {
    id: 'talk',
    persona: 'tobias-lang',
    run: async (a) => {
      const { page } = a
      await cleanupExtraKnocks('tobias-lang')
      await page.goto(`${BASE}/canvass`)
      await page.waitForSelector('.search-input')
      await a.sleep(2000)

      // Shot: search
      a.markIn('talk-search', 'Search any name or address.')
      await a.type(page.locator('.search-input'), '1175 brook')
      try {
        await page.waitForSelector('.results .result', { timeout: 9000 })
      } catch {
        // slow query burst — nudge the debounce with one more keystroke
        await page.keyboard.press('Backspace')
        await sleep(300)
        await page.keyboard.type('k')
        await page.waitForSelector('.results .result', { timeout: 15000 })
      }
      await a.sleep(900)
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = page.locator('.results .result', { hasText: '1175 BROOKSTONE DR' })
        if (!(await row.count())) break // dropdown gone — load in progress
        await a.tap(row)
        try {
          await page.waitForSelector('.person', { timeout: 8000 })
          break
        } catch {
          if (attempt === 2) throw new Error('address never loaded from search result')
        }
      }
      await page.waitForSelector('.person', { timeout: 8000 })
      await a.sleep(700)
      a.markOut()

      // Shot: roster
      a.markIn('talk-roster', 'The whole household, at a glance.')
      await a.sleep(2600)
      await a.scroll(220, 2)
      await a.sleep(1600)
      a.markOut()

      // Shot: log an outcome
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await a.sleep(900)
      a.markIn('talk-signed', 'One tap logs the outcome.')
      await a.tap(page.locator('.person', { hasText: 'Sarah' }))
      await a.sleep(900)
      await a.tap(page.locator('.outcome-btn', { hasText: 'Signed' }))
      await a.sleep(2400)
      a.markOut()

      // Shot: Next + Up-next chips
      a.markIn('talk-next', 'Next walks the street with you.')
      await a.tap(page.locator('.next-btn'))
      await a.sleep(2200)
      await a.scroll(500, 2)
      await page.locator('.up-chip').first().waitFor({ timeout: 8000 })
      await a.sleep(900)
      await a.tap(page.locator('.up-chip').first())
      await a.sleep(2000)
      a.markOut()

      // Shot: flip to Scout — just the tap; the heavy pin load happens
      // off-camera between this mark and the next.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await a.sleep(800)
      a.markIn('scout-flip', 'Flip to Scout — see the whole turf.')
      await a.tap(page.getByRole('tab', { name: 'Scout' }))
      await a.sleep(1400)
      a.markOut()
      // Off-camera: ~10k doors + statuses page in, then auto-orient locates
      // the Talk door (street search fills, map zooms 17, missing doors on
      // the street geocode one by one — locateAddress ignores taps while
      // that runs, so wait out the full cycle).
      await page.waitForSelector('.pins-loading', { state: 'hidden', timeout: 150000 })
      await waitLocateCycle(page)
      await a.sleep(2500) // tiles settle

      // Shot: the oriented map. The auto-orient pan can lose a race against
      // the turf fitBounds animation on a slow machine, so orient on camera:
      // the search is already pre-filled with the Talk door's street — tap
      // its row and the map locates the door, zoomed to the street.
      a.markIn('scout-orient', 'Flip to Scout — see the whole turf.')
      await a.sleep(1000)
      const talkRow = page.locator('.results-list .result-row', { hasText: '1175 BROOKSTONE' })
      if (await talkRow.count()) await a.tap(talkRow.first())
      await waitLocateCycle(page)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await a.sleep(3000) // pan/zoom + tiles
      a.markOut()

      // Shot: colored pins — jump to a heavily-worked street from the month
      // of history, then tour it.
      a.markIn('scout-pins', 'Every door, color-coded.')
      const search = page.locator('.street-search')
      await search.scrollIntoViewIfNeeded()
      await waitScrollSettle(page)
      await page.evaluate(() => { const el = document.querySelector('.street-search'); if (el) el.value = '' })
      await a.type(search, 'dickson dr')
      await page.waitForSelector('.results-list .result-row', { timeout: 10000 })
      await a.sleep(800)
      await a.tap(page.locator('.results-list .result-row').first())
      await waitLocateCycle(page)
      await a.sleep(2000)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await waitScrollSettle(page)
      await a.sleep(1200)
      const box = await mapBox(page)
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await a.dragMap(cx, cy, -240, 70)
      await a.sleep(800)
      await a.wheelZoom(cx, cy, -1)
      await a.sleep(900)
      await a.dragMap(cx, cy, 190, -90)
      await a.sleep(1600)
      a.markOut()

      // Shot: tap a pin → located card + ratio + knock button
      a.markIn('scout-pin-tap', 'Tap any pin for the full story.')
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await a.sleep(900)
      const pin = await page.evaluate(() => {
        const els = [...document.querySelectorAll('div[data-house]')]
        const vw = innerWidth, vh = innerHeight
        let best = null, bestD = 1e9
        for (const el of els) {
          const r = el.getBoundingClientRect()
          if (r.width === 0) continue
          const x = r.x + r.width / 2, y = r.y + r.height / 2
          if (x < 20 || y < 120 || x > vw - 20 || y > vh * 0.55) continue
          const d = (x - vw / 2) ** 2 + (y - vh * 0.3) ** 2
          if (d < bestD) { bestD = d; best = { x, y } }
        }
        return best
      })
      if (pin) await a.tapXY(pin.x, pin.y)
      await a.sleep(3200)
      a.markOut()
    },
  },

  {
    id: 'squad',
    persona: 'opal-pruitt',
    run: async (a) => {
      const { page } = a
      await cleanupExtraKnocks('kayla-thorne') // prior takes' live-cue knocks
      await page.goto(`${BASE}/squad`)
      await page.waitForSelector('.member-card', { timeout: 25000 })
      await a.sleep(3500) // statuses + map fit

      // Shot: crew home base — cards, progress bar
      a.markIn('squad-cards', "Your crew's home base.")
      await a.sleep(2200)
      await a.scroll(420, 2)
      await a.sleep(1800)
      a.markOut()

      // Shot: live knock — zoom to Kayla, fire her knock, watch it pop
      a.markIn('squad-live', 'Live — as the crew works.')
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await a.sleep(700)
      await a.tap(page.locator('.member-card', { hasText: 'Kayla' }))
      await a.sleep(3000) // pan+zoom 17, pins build
      await fireLiveKnock()
      await a.sleep(4200) // plink + avatar lands
      a.markOut()

      // Shot: assign doors — two-tap sweep on Brookstone
      a.markIn('squad-assign', 'Split the turf in two taps.')
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      await a.sleep(800)
      await a.tap(page.locator('.member-card', { hasText: 'Tobias' }).locator('.assign-btn'))
      await a.sleep(1800) // scrolls to map
      // Still framed near Kayla's last door at zoom 17 (above the clusterer's
      // max, so every pin is individual). Drag over to Brookstone.
      const sweepMid = {
        lat: (plan.sweep.a.lat + plan.sweep.b.lat) / 2,
        lng: (plan.sweep.a.lng + plan.sweep.b.lng) / 2,
      }
      await panToTurfTarget(page, sweepMid, 17)
      await a.sleep(1200)
      // Tap the two endpoint doors by their unique house numbers
      for (const house of [plan.sweep.a.house, plan.sweep.b.house]) {
        const pt = await page.evaluate((h) => {
          const el = [...document.querySelectorAll(`div[data-house="${h}"]`)].find((e) => e.getBoundingClientRect().width > 0)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }, String(house))
        if (!pt) throw new Error(`sweep pin ${house} not found on screen`)
        await a.tapXY(pt.x, pt.y)
        await a.sleep(1400)
      }
      await a.sleep(1500)
      await a.tap(page.locator('.assign-bar button', { hasText: 'Save' }))
      await a.sleep(3000)
      a.markOut()
    },
  },

  {
    id: 'chat',
    persona: 'tobias-lang',
    run: async (a) => {
      const { page } = a
      await page.goto(`${BASE}/canvass`)
      await page.waitForSelector('.drawer-handle', { timeout: 20000 })
      await a.sleep(2000)
      a.markIn('chat', 'Chat is one pull away.')
      await a.tap(page.locator('.drawer-handle'))
      await a.sleep(2200) // room list moment
      const everyone = page.locator('.room-row', { hasText: 'Everyone' })
      await a.tap((await everyone.count()) ? everyone.first() : page.locator('.room-row').first())
      await a.sleep(2800)
      // The composer lives in vue-advanced-chat's shadow DOM — tap its
      // textarea by coordinates, type, and send with Enter.
      const taRect = await page.evaluate(() => {
        const el = document.querySelector('vue-advanced-chat')?.shadowRoot?.querySelector('#roomTextarea')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      if (taRect) {
        await a.tapXY(taRect.x, taRect.y, { noPause: true })
        await a.sleep(400)
        for (const ch of 'Triple Crown is flying today 🔥') {
          await page.keyboard.type(ch)
          await sleep(jitter(55, 80))
        }
        await sleep(700)
        await page.keyboard.press('Enter')
        await a.sleep(3000)
      } else {
        await a.sleep(2000)
      }
      a.markOut()
    },
  },

  {
    id: 'feed',
    persona: 'tobias-lang',
    run: async (a) => {
      const { page } = a
      await page.goto(`${BASE}/activity`)
      await page.waitForSelector('.feed-row, .today-strip, main', { timeout: 20000 })
      await a.sleep(2600)
      a.markIn('feed', 'The campaign, live.')
      await a.sleep(2600)
      await a.scroll(650, 3)
      await a.sleep(1800)
      a.markOut()
    },
  },

  {
    id: 'leaders',
    persona: 'tobias-lang',
    run: async (a) => {
      const { page } = a
      await page.goto(`${BASE}/leaderboard`)
      await page.waitForSelector('table, .board, main', { timeout: 20000 })
      await a.sleep(2600)
      a.markIn('leaders', 'Standings, updated in real time.')
      await a.sleep(2200)
      await a.scroll(350, 2)
      await a.sleep(800)
      await a.tap(page.getByRole('button', { name: 'Today' }))
      await a.sleep(3000)
      a.markOut()
    },
  },

  {
    id: 'ai',
    persona: 'miles-nakamura',
    run: async (a) => {
      const { page } = a
      await page.goto(`${BASE}/admin/chat`)
      await page.waitForSelector('[placeholder*="Ask"]', { timeout: 20000 })
      await a.sleep(2200)
      a.markIn('ai', 'Ask the data anything.')
      const input = page.locator('[placeholder*="Ask"]').first()
      await a.type(input, 'Who are our top 5 canvassers by signatures?')
      await a.sleep(400)
      await a.tap(page.getByRole('button', { name: 'Send' }))
      // wait for the reply to render (tool-use loop can take ~8s)
      await a.sleep(11000)
      await a.scroll(400, 2)
      await a.sleep(2500)
      a.markOut()
    },
  },

  {
    id: 'style',
    persona: 'tobias-lang',
    run: async (a) => {
      const { page } = a
      // Reset to the pre-shot look (light + fox) so re-takes start clean.
      {
        const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
        const { data } = await client.auth.signInWithPassword({
          email: 'tobias-lang@example.com', password: simPassword(),
        })
        await client.from('profiles').update({ theme: { scheme: 'light' }, avatar: 'fox' }).eq('id', data.user.id)
        await client.auth.signOut()
      }
      await page.goto(`${BASE}/appearance`)
      await page.waitForSelector('.swatch-card', { timeout: 20000 })
      await a.sleep(1800)
      a.markIn('style-theme', 'Make it yours.')
      const neon = page.locator('.swatch-card', { hasText: 'Neon' }).first()
      await neon.scrollIntoViewIfNeeded()
      await a.sleep(900)
      await a.tap(neon)
      await a.sleep(2800)
      a.markOut()

      a.markIn('style-emoji', 'Make it yours.')
      await page.goto(`${BASE}/profile`)
      await page.waitForSelector('.picker-title', { timeout: 20000 })
      await a.sleep(1300)
      await a.tap(page.locator('button', { hasText: 'Pick my emoji' }))
      await a.sleep(1500)
      await a.type(page.locator('input[aria-label="Search emoji"]'), 'crystal')
      await a.sleep(1100)
      await a.tap(page.locator('.cell').first())
      await a.sleep(2200)
      a.markOut()
    },
  },

  {
    id: 'close',
    persona: null,
    run: async ({ page, markIn, markOut, sleep }) => {
      await page.goto('file://' + join(HERE, 'cards', 'close.html').replaceAll('\\', '/'))
      await sleep(600)
      markIn('close', null)
      await sleep(7000)
      markOut()
    },
  },
]

// ---------------------------------------------------------------- main

const wanted = process.argv.slice(2)
const toRun = wanted.length ? scenes.filter((s) => wanted.includes(s.id)) : scenes
if (!toRun.length) throw new Error(`no scenes match: ${wanted.join(', ')}`)

browser = await chromium.launch({
  args: ['--window-size=432,768', '--force-device-scale-factor=2.5', '--hide-scrollbars'],
})

let failures = 0
for (const scene of toRun) {
  try {
    await runScene(scene)
  } catch {
    failures++
  }
}
await browser.close()
console.log(failures ? `\n${failures} scene(s) failed` : '\nall scenes recorded')
process.exit(failures ? 1 : 0)
