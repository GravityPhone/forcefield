// Cut the whole of Marysville into walkable turf, automatically.
//
//   node scripts/demo-turf.mjs [--target 150] [--dry-run]
//
// This is the "auto turf" idea: given a city's doors and their coordinates,
// divide it into chunks a crew can actually walk in a shift. It exists for the
// simulation, but the algorithm is deliberately written as something that could
// move into the turf cutter behind a button — a campaign manager's starting
// point that they then edit by hand, not a finished cut.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ATOM IS A STREET BLOCK, NOT A DOOR. This is the whole design.
//
// Clustering raw doors by proximity produces turf that looks tidy on a map and
// is miserable to walk: it splits one side of a street from the other and hands
// a canvasser half of four streets instead of all of one. It is also not
// expressible — `turf_segments` are (street, house-number range, parity), so a
// turf that isn't made of contiguous number runs cannot be stored at all.
//
// So the unit is a BLOCK: a run of consecutive house numbers on one street with
// no large geographic gap. Blocks are found by walking each street in
// house-number order and cutting where consecutive doors jump more than
// BLOCK_GAP_M apart — which is what a cross street, a park, or a stretch of
// farmland looks like in the data. Then turf is grown out of whole blocks.
//
// NO NEW GEOCODING IS NEEDED. The coordinates already in `addresses` are the
// geocoding. Doors that still lack coordinates are placed by STREET: they join
// the block on their own street whose number range is nearest. A door with no
// pin is still a door on a street somebody walks.
// ─────────────────────────────────────────────────────────────────────────────
//
// Growth is single-linkage: a turf repeatedly absorbs the unassigned block
// nearest to ANY block it already holds, not nearest to its centroid. Centroid
// growth rounds turf into blobs that jump across a highway; single linkage
// follows the street grid, which is how walking works.
//
// Seeds start at the periphery (furthest block from the city centroid) and work
// inward. Seeding from the middle strands the sparse outskirts as unassignable
// leftovers; seeding from the edge lets the rural fringe form its own honestly
// larger turf and leaves the dense core, which packs cleanly, for last.

import {
  supa, sql, fetchAll, localDayString, DEMO_CITY, requireDemoCampaign,
} from './demo-lib.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targetArg = args.indexOf('--target')
const TARGET_DOORS = targetArg >= 0 ? Number(args[targetArg + 1]) : 150

// A gap this big between consecutive house numbers on a street is a block
// boundary. 180m is about two suburban lots — big enough not to trip on a
// corner lot, small enough to catch a genuine break.
const BLOCK_GAP_M = 180
// Metres of walking per door gained, at the margin. This is the compactness
// rule, and it is expressed as a RATIO rather than an absolute radius because
// "Marysville" as a mailing city spans 26km of farmland as well as a compact
// town: an absolute cap either shreds the country roads or lets the town sprawl.
// 80m/door absorbs a row of farmhouses along a lane and refuses an empty field.
const MAX_M_PER_DOOR = 80
// Absolute contiguity cap, and it is a SEPARATE rule from the ratio above.
// The ratio answers "are these doors worth the walk"; a big enough block always
// passes it, so a 20-door block six kilometres off scored 300m/door and got
// absorbed — which is how turfs ended up spanning the county while looking
// correctly sized. This answers the different question: is the next block even
// adjacent? Nothing joins a turf across a gap you would drive.
const MAX_JUMP_M = 800
// Never strand a tiny fragment: anything under this merges into a neighbour.
const MIN_TURF_DOORS = 40

// ── The walkability gate ────────────────────────────────────────────────────
// "Marysville" is a MAILING city: 12,332 doors spread over a 26km box that is
// mostly farmland, wrapped around a compact town. Isolated farmhouses cannot be
// assembled into walkable turf at any parameter setting — a turf of six houses
// four kilometres apart is a driving route, and no campaign canvasses it door
// to door.
//
// So the universe is the part of town where doors are close enough together to
// walk: a door counts as walkable when at least DENSE_MIN_NEIGHBOURS other
// doors sit within DENSE_RADIUS_M of it. Everything else is left UNTURFED on
// purpose — the doors still exist, still show on the map, and read as exactly
// what they are: ground the campaign never worked.
const DENSE_RADIUS_M = 250
const DENSE_MIN_NEIGHBOURS = 6

const PALETTE = [
  '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#c026d3',
  '#65a30d', '#ea580c', '#0d9488', '#db2777', '#4f46e5', '#a16207',
]

const log = (...a) => console.log(...a)

// ------------------------------------------------------------------ geometry
// Equirectangular at Marysville's latitude. Accurate to well under a metre at
// these distances and far cheaper than haversine in an O(n²) growth loop.
const LAT0 = 40.24
const M_PER_LAT = 111_320
const M_PER_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180)

const toXY = (lat, lng) => ({ x: lng * M_PER_LNG, y: lat * M_PER_LAT })
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
const dist = (a, b) => Math.sqrt(dist2(a, b))

// ------------------------------------------------------------------ parsing
// Must match set_turf_segments() exactly:
//   street_name = upper(btrim(regexp_replace(street, '^\d+\s*', '')))
//   house num   = substring(street from '^\d{1,9}')::integer
const streetNameOf = (s) => String(s).replace(/^\d+\s*/, '').trim().toUpperCase()
const houseNumOf = (s) => {
  const m = String(s).match(/^\d{1,9}/)
  return m ? Number(m[0]) : 0
}

const titleCase = (s) =>
  s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
   .replace(/\b(Us|Oh|Sr)\b/g, (m) => m.toUpperCase())

// ------------------------------------------------------------------ blocks

function buildBlocks(addresses) {
  const byStreet = new Map()
  for (const a of addresses) {
    const name = streetNameOf(a.street)
    if (!name) continue
    let arr = byStreet.get(name)
    if (!arr) byStreet.set(name, (arr = []))
    arr.push({ id: a.id, n: houseNumOf(a.street), lat: a.lat, lng: a.lng })
  }

  const blocks = []
  for (const [street, doors] of byStreet) {
    // House-number order, NOT geographic order: a block has to be a contiguous
    // number range to be storable as a segment. On a real street the two
    // orders agree, which is exactly why this works.
    doors.sort((a, b) => a.n - b.n || String(a.id).localeCompare(String(b.id)))
    const placed = doors.filter((d) => d.lat != null)
    const unplaced = doors.filter((d) => d.lat == null)

    // Split the geocoded doors into runs separated by real geographic gaps.
    const runs = []
    let cur = []
    let prev = null
    for (const d of placed) {
      const p = toXY(d.lat, d.lng)
      if (prev && dist(prev, p) > BLOCK_GAP_M) { runs.push(cur); cur = [] }
      cur.push(d)
      prev = p
    }
    if (cur.length) runs.push(cur)

    // A street with no coordinates at all is still one block — it just has no
    // position, and gets attached by name later.
    if (!runs.length) {
      if (unplaced.length) {
        blocks.push(makeBlock(street, unplaced, null))
      }
      continue
    }

    const made = runs.map((run) => makeBlock(street, run, centroidOf(run)))
    // Ungeocoded doors join the run whose number range is closest — a door with
    // no pin is still a door on a street, and dropping it would silently shrink
    // the universe.
    for (const d of unplaced) {
      let best = made[0]
      let bestGap = Infinity
      for (const b of made) {
        const gap = d.n < b.minNum ? b.minNum - d.n : d.n > b.maxNum ? d.n - b.maxNum : 0
        if (gap < bestGap) { bestGap = gap; best = b }
      }
      best.doors.push(d)
      best.minNum = Math.min(best.minNum, d.n)
      best.maxNum = Math.max(best.maxNum, d.n)
    }
    blocks.push(...made)
  }
  return blocks
}

function centroidOf(doors) {
  const pts = doors.filter((d) => d.lat != null).map((d) => toXY(d.lat, d.lng))
  if (!pts.length) return null
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  }
}

function makeBlock(street, doors, pos) {
  return {
    street,
    doors: [...doors],
    minNum: Math.min(...doors.map((d) => d.n)),
    maxNum: Math.max(...doors.map((d) => d.n)),
    pos,
    turf: null,
  }
}

// ------------------------------------------------------------------ growing

/** Doors with enough close neighbours to be worth walking. Bucketed into a
 *  DENSE_RADIUS_M grid so this is O(n) rather than 12,000² comparisons. */
function markWalkable(blocks) {
  const cell = DENSE_RADIUS_M
  const grid = new Map()
  const key = (gx, gy) => `${gx}:${gy}`
  const all = []
  for (const b of blocks) {
    for (const d of b.doors) {
      if (d.lat == null) continue
      const p = toXY(d.lat, d.lng)
      const gx = Math.floor(p.x / cell)
      const gy = Math.floor(p.y / cell)
      const rec = { p, gx, gy }
      all.push(rec)
      let arr = grid.get(key(gx, gy))
      if (!arr) grid.set(key(gx, gy), (arr = []))
      arr.push(rec)
    }
  }
  const r2 = DENSE_RADIUS_M ** 2
  for (const rec of all) {
    let n = 0
    for (let dx = -1; dx <= 1 && n < DENSE_MIN_NEIGHBOURS; dx++) {
      for (let dy = -1; dy <= 1 && n < DENSE_MIN_NEIGHBOURS; dy++) {
        const arr = grid.get(key(rec.gx + dx, rec.gy + dy))
        if (!arr) continue
        for (const other of arr) {
          if (other === rec) continue
          if (dist2(rec.p, other.p) <= r2 && ++n >= DENSE_MIN_NEIGHBOURS) break
        }
      }
    }
    rec.dense = n >= DENSE_MIN_NEIGHBOURS
  }
  // A block is walkable when most of its doors are. Judging per door would
  // split a street down the middle where the houses thin out at one end.
  let i = 0
  for (const b of blocks) {
    let dense = 0
    let placed = 0
    for (const d of b.doors) {
      if (d.lat == null) continue
      if (all[i].dense) dense++
      placed++
      i++
    }
    b.walkable = placed > 0 && dense * 2 >= placed
  }
}

function growTurfs(blocks) {
  markWalkable(blocks)
  const located = blocks.filter((b) => b.pos && b.walkable)
  const skipped = blocks.filter((b) => b.pos && !b.walkable)
  const floating = blocks.filter((b) => !b.pos)
  const skippedDoors = skipped.reduce((s, b) => s + b.doors.length, 0)
  log(`  walkable: ${located.length} blocks; leaving ${skipped.length} scattered blocks (${skippedDoors} doors) unturfed`)
  if (!located.length) throw new Error('No geocoded doors to cluster on')

  const cx = located.reduce((s, b) => s + b.pos.x, 0) / located.length
  const cy = located.reduce((s, b) => s + b.pos.y, 0) / located.length
  const center = { x: cx, y: cy }

  // Periphery first. Seeding from the middle leaves the sparse fringe as
  // unassignable crumbs; seeding from the edge lets it form honest turf.
  const byOuterness = [...located].sort((a, b) => dist2(b.pos, center) - dist2(a.pos, center))

  const turfs = []
  for (const seed of byOuterness) {
    if (seed.turf !== null) continue
    const turf = { id: turfs.length, blocks: [seed], doors: seed.doors.length }
    seed.turf = turf.id

    while (turf.doors < TARGET_DOORS) {
      // Grow toward the CHEAPEST doors, not the nearest block. Cost is metres
      // of walking per door gained, so a block of 12 houses 300m off beats a
      // block of 2 houses 120m off — which is the actual judgment a canvasser
      // makes. Nearest-block growth got this wrong in both directions: it
      // fragmented sparse areas into 40-door scraps and, because the absolute
      // spread cap only applied once a turf already had MIN_TURF_DOORS, it also
      // let a turf under that floor sprawl to seven kilometres.
      //
      // Single linkage is kept: distance is measured to the nearest block the
      // turf already holds, so growth follows the street grid instead of
      // ballooning around a centroid and jumping a highway.
      let best = null
      let bestCost = Infinity
      for (const cand of located) {
        if (cand.turf !== null) continue
        let gap = Infinity
        for (const held of turf.blocks) {
          const d = dist(held.pos, cand.pos)
          if (d < gap) gap = d
        }
        if (gap > MAX_JUMP_M) continue
        const cost = gap / cand.doors.length
        if (cost < bestCost) { bestCost = cost; best = cand }
      }
      if (!best) break

      // The marginal rule is what makes this work for dense town and open
      // country at once: it lets a rural turf keep collecting farmhouses strung
      // along a road, and stops it dead at the edge of an empty field.
      // The absolute ceiling has no size escape hatch, deliberately. Letting an
      // undersized turf ignore cost is what produced 20km turfs: it would reach
      // clear across the county rather than close at 30 doors.
      if (bestCost > MAX_M_PER_DOOR * 4) break
      if (bestCost > MAX_M_PER_DOOR && turf.doors >= MIN_TURF_DOORS) break
      // Overshoot control: stop rather than blow well past the target, unless
      // the turf is still too small to stand alone.
      if (turf.doors + best.doors.length > TARGET_DOORS * 1.45 && turf.doors >= MIN_TURF_DOORS) break

      best.turf = turf.id
      turf.blocks.push(best)
      turf.doors += best.doors.length
    }
    turfs.push(turf)
  }

  // Fold undersized turf into its nearest neighbour rather than shipping a
  // 12-door turf nobody would ever dispatch.
  const keep = []
  for (const t of turfs) {
    if (t.doors >= MIN_TURF_DOORS || turfs.length === 1) { keep.push(t); continue }
    let best = null
    let bestD = Infinity
    for (const other of turfs) {
      if (other === t || other.doors < MIN_TURF_DOORS) continue
      for (const a of t.blocks) for (const b of other.blocks) {
        const d = dist(a.pos, b.pos)
        if (d < bestD) { bestD = d; best = other }
      }
    }
    // Same contiguity rule as growth: a fragment merges into a NEIGHBOUR, not
    // into whichever turf happens to be least far away. Without this cap a
    // stranded hamlet joined a turf on the far side of the county and the
    // result measured 14km across.
    if (!best || bestD > MAX_JUMP_M * 2) { keep.push(t); continue }
    for (const b of t.blocks) { b.turf = best.id; best.blocks.push(b) }
    best.doors += t.doors
  }

  // Streets with no coordinates anywhere join the turf that already holds the
  // most doors on that same street name. If no turf holds that street, the
  // block stays UNTURFED — it is an unplaced address on a road nobody is
  // walking, and guessing it into the nearest turf would put doors in a turf
  // whose canvasser will never see them.
  let attached = 0
  for (const f of floating) {
    let best = null
    let bestCount = 0
    for (const t of keep) {
      const n = t.blocks.reduce((s, b) => s + (b.street === f.street ? b.doors.length : 0), 0)
      if (n > bestCount) { bestCount = n; best = t }
    }
    if (!best) continue
    f.turf = best.id
    best.blocks.push(f)
    best.doors += f.doors.length
    attached++
  }
  if (floating.length) log(`  ${attached}/${floating.length} unplaced street blocks matched to a turf by name`)
  return keep
}

function spreadWith(blocks, extra) {
  const pts = [...blocks.map((b) => b.pos), extra.pos].filter(Boolean)
  let max = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) max = Math.max(max, dist2(pts[i], pts[j]))
  }
  return Math.sqrt(max)
}

// ------------------------------------------------------------------ segments

/** Blocks -> turf_segments rows. Adjacent blocks on the same street merge into
 *  one range: two consecutive blocks of Collins Ave in the same turf should
 *  read as one stretch, not two. */
function segmentsFor(turf) {
  const byStreet = new Map()
  for (const b of turf.blocks) {
    let arr = byStreet.get(b.street)
    if (!arr) byStreet.set(b.street, (arr = []))
    arr.push(b)
  }
  const segs = []
  for (const [street, blocks] of byStreet) {
    blocks.sort((a, b) => a.minNum - b.minNum)
    let cur = { street_name: street, city: DEMO_CITY.toUpperCase(), range_start: blocks[0].minNum, range_end: blocks[0].maxNum, parity: 'both' }
    for (let i = 1; i < blocks.length; i++) {
      // Contiguous in number space -> one segment. The RPC rewrites these into
      // honest ranges from the doors it actually claims anyway, so a slightly
      // generous join here costs nothing.
      if (blocks[i].minNum <= cur.range_end + 2) {
        cur.range_end = Math.max(cur.range_end, blocks[i].maxNum)
      } else {
        segs.push(cur)
        cur = { street_name: street, city: DEMO_CITY.toUpperCase(), range_start: blocks[i].minNum, range_end: blocks[i].maxNum, parity: 'both' }
      }
    }
    segs.push(cur)
  }
  return segs
}

function nameFor(turf, taken) {
  const counts = new Map()
  for (const b of turf.blocks) counts.set(b.street, (counts.get(b.street) ?? 0) + b.doors.length)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  let base = titleCase(top)
  if (!taken.has(base)) { taken.add(base); return base }
  for (let i = 2; ; i++) {
    const c = `${base} ${i}`
    if (!taken.has(c)) { taken.add(c); return c }
  }
}

// ------------------------------------------------------------------ main

async function main() {
  const campaign = await requireDemoCampaign()
  log(`Auto turf for ${DEMO_CITY} — campaign "${campaign.name}", target ${TARGET_DOORS} doors/turf`)

  const addresses = await fetchAll('addresses', 'id, street, city, lat, lng', (q) => q.eq('city', DEMO_CITY))
  log(`  ${addresses.length} doors (${addresses.filter((a) => a.lat != null).length} geocoded)`)

  const blocks = buildBlocks(addresses)
  const placedBlocks = blocks.filter((b) => b.pos).length
  log(`  ${blocks.length} street blocks (${placedBlocks} positioned, ${blocks.length - placedBlocks} by street name only)`)

  const turfs = growTurfs(blocks)
  const sizes = turfs.map((t) => t.doors).sort((a, b) => a - b)
  const spreads = turfs.map((t) => {
    const pts = t.blocks.map((b) => b.pos).filter(Boolean)
    let max = 0
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) max = Math.max(max, dist2(pts[i], pts[j]))
    return Math.round(Math.sqrt(max))
  }).sort((a, b) => a - b)
  const med = (a) => a[Math.floor(a.length / 2)]

  log(`\n  ${turfs.length} turfs`)
  log(`    doors  min ${sizes[0]}  median ${med(sizes)}  max ${sizes[sizes.length - 1]}`)
  log(`    spread min ${spreads[0]}m  median ${med(spreads)}m  max ${spreads[spreads.length - 1]}m`)
  const covered = sizes.reduce((s, n) => s + n, 0)
  log(`    doors in turf: ${covered} / ${addresses.length} (${Math.round((100 * covered) / addresses.length)}%) — the rest is scattered rural, left unturfed`)

  if (dryRun) {
    log('\n  [dry-run] nothing written. Sample:')
    const taken = new Set()
    for (const t of turfs.slice(0, 8)) {
      const segs = segmentsFor(t)
      log(`    ${nameFor(t, taken)} — ${t.doors} doors, ${segs.length} segments, streets: ${[...new Set(t.blocks.map((b) => b.street))].slice(0, 4).join(', ')}`)
    }
    return
  }

  // created_at is TODAY on purpose: the turf cutter's whole working set is
  // turfs created on the client-local day (see CLAUDE.md "TURF IS FOR TODAY"),
  // so a turf stamped six weeks ago would land in the stale-turf prompt instead
  // of the dropdown. demo-simulate re-stamps this each time it advances a day.
  const today = localDayString()
  const taken = new Set()
  log('\n  writing turfs…')
  let done = 0
  for (const t of turfs) {
    const name = nameFor(t, taken)
    const { data: row, error } = await supa.from('turfs').insert({
      name,
      color: PALETTE[done % PALETTE.length],
    }).select().single()
    if (error) throw new Error(`create turf ${name}: ${error.message}`)
    t.turfId = row.id
    t.name = name

    const segs = segmentsFor(t)
    const { error: rpcErr } = await supa.rpc('set_turf_segments', {
      target_turf_id: row.id,
      segments: segs,
    })
    if (rpcErr) throw new Error(`set_turf_segments ${name}: ${rpcErr.message}`)
    done++
    if (done % 20 === 0) log(`    ${done}/${turfs.length}`)
  }

  await sql(`update public.turfs set created_at = '${today}T08:00:00-04:00' where parent_turf_id is null`)

  const check = await sql(`
    select count(*) filter (where turf_id is not null) as claimed,
           count(*) as total
    from public.addresses where city = '${DEMO_CITY}'`)
  log(`\n  ${turfs.length} turfs written`)
  log(`  ${check[0].claimed} / ${check[0].total} Marysville doors are in a turf`)
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })
