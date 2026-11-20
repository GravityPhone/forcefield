// Set the petition demo up for TODAY: compact turf in one good part of town,
// crews out on it, and knocks up to the clock.
//
//   node scripts/demo-today.mjs             full build (recuts ALL turf)
//   node scripts/demo-today.mjs --top-up    only bring today's knocks up to now
//   node scripts/demo-today.mjs --sites     only (re)write today's site signatures
//   node scripts/demo-today.mjs --dry-run   report the cut, write nothing
//
// Run scripts/shift-demo-era.mjs first if the history has gone stale. This
// script then fills the days between the end of that history and today.
//
// WHAT THE FULL BUILD DOES, in order:
//   1. Deletes every turf. The history's knock_logs keep their turf NAME
//      stamps, so Analytics still has the old cut; the board itself starts
//      clean. (The old auto cut grew turf along streets, so one turf could
//      span two kilometres and interleave with its neighbours. Fine for
//      generating history, wrong for a map somebody is shown.)
//   2. Finds the densest fully mapped part of Marysville and cuts it into
//      COMPACT turf: street blocks clustered by where they are, so every turf
//      is one patch of ground next to the others.
//   3. Makes today's crews from the simulated roster and keeps any squad a
//      real person made today, sending each one a turf. The most central turf
//      goes to the real squad.
//   4. Splits each dispatched turf between its members ("<name>'s doors"),
//      the way a leader does on the Squad page.
//   5. Writes knocks for the gap days and for today up to now. Simulated
//      people only: a real person's share is left for them to knock.
//
// --top-up touches nothing but today's simulated knocks, so it is safe after
// somebody has re-split or re-dispatched by hand.

import { randomUUID } from 'node:crypto'
import {
  supa, sql, insertChunked, makeRng, hash32, shuffle,
  localDayString, addDays, daysBetween, atHour, requireDemoCampaign, DEMO_CITY,
} from './demo-lib.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const topUp = args.includes('--top-up')
const TODAY = localDayString()
const log = (...a) => console.log(...a)

const TURF_DOORS = 165          // target doors per turf
const TURF_COUNT = 12           // six go out today, six wait on the board
const CREWS_TODAY = 6           // including any squad a real person made
const CREW_SIZE = 3
const CREWS_GAP_DAY = 5
const PALETTE = ['#7c3aed', '#0ea5e9', '#f97316', '#10b981', '#eab308', '#ec4899', '#14b8a6', '#6366f1', '#84cc16']
const CLOSED = new Set(['didnt_sign', 'skip', 'hostile'])

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
const nameOf = (street) => String(street).replace(/^\d+\s*/, '').trim().toUpperCase()
const numOf = (street) => Number((String(street).match(/^\d{1,9}/) ?? [0])[0])
const MX = 111320 * Math.cos((40.24 * Math.PI) / 180)
const xy = (d) => [d.lng * MX, d.lat * 111320]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

async function loadDoors() {
  const rows = await sql(`
    select a.id, a.street, a.lat, a.lng, a.turf_id, k.outcome, coalesce(k.signed_count,0) signed_count,
      (select array_agg(p.id) from persons p where p.household_id = a.id) persons,
      (select array_agg(distinct l.person_id) from knock_logs l where l.household_id = a.id and l.outcome = 'signed' and l.person_id is not null) signed
    from addresses a left join household_latest_knock k on k.household_id = a.id
    where a.city = ${q(DEMO_CITY)}`)
  return rows.map((r) => ({
    ...r, name: nameOf(r.street), num: numOf(r.street),
    persons: r.persons ?? [], signed: new Set(r.signed ?? []),
    closed: CLOSED.has(r.outcome),
  }))
}

// ------------------------------------------------------------------ the cut

/** Street blocks: runs of consecutive house numbers with no big gap, capped
 *  small so a cluster boundary can fall mid-street. Each is one segment. */
function buildAtoms(doors) {
  const byStreet = new Map()
  for (const d of doors) {
    let a = byStreet.get(d.name)
    if (!a) byStreet.set(d.name, (a = []))
    a.push(d)
  }
  const atoms = []
  for (const [name, list] of byStreet) {
    list.sort((a, b) => a.num - b.num)
    let cur = null
    let lastPt = null
    const close = () => { if (cur) atoms.push(cur); cur = null }
    for (let i = 0; i < list.length; i++) {
      const d = list[i]
      const pt = d.lat != null ? xy(d) : null
      const newNumber = i === 0 || list[i - 1].num !== d.num
      if (cur && newNumber && ((pt && lastPt && dist(pt, lastPt) > 150) || cur.doors.length >= 24)) close()
      if (!cur) { cur = { name, doors: [] }; }
      cur.doors.push(d)
      if (pt) lastPt = pt
    }
    close()
  }
  for (const a of atoms) {
    const pts = a.doors.filter((d) => d.lat != null).map(xy)
    a.geo = pts.length
    a.c = pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : null
    a.lo = a.doors[0].num
    a.hi = a.doors[a.doors.length - 1].num
    a.n = a.doors.length
  }
  return atoms
}

function centroid(atoms) {
  const n = atoms.reduce((s, a) => s + a.n, 0)
  return [atoms.reduce((s, a) => s + a.c[0] * a.n, 0) / n, atoms.reduce((s, a) => s + a.c[1] * a.n, 0) / n]
}

/** Weighted k-means over atoms, farthest-point seeded. */
function cluster(atoms, k) {
  const centers = [centroid(atoms)]
  // seed 0 is the atom nearest the middle; the rest are farthest-point
  centers[0] = atoms.reduce((b, a) => (dist(a.c, centers[0]) < dist(b.c, centers[0]) ? a : b)).c
  while (centers.length < k) {
    let best = null, bd = -1
    for (const a of atoms) {
      const d = Math.min(...centers.map((c) => dist(a.c, c)))
      if (d > bd) { bd = d; best = a }
    }
    centers.push(best.c)
  }
  let groups = []
  for (let it = 0; it < 40; it++) {
    groups = centers.map(() => [])
    for (const a of atoms) {
      let bi = 0, bd = Infinity
      centers.forEach((c, i) => { const d = dist(a.c, c); if (d < bd) { bd = d; bi = i } })
      groups[bi].push(a)
    }
    groups.forEach((g, i) => { if (g.length) centers[i] = centroid(g) })
  }
  return groups.filter((g) => g.length)
}

/** Even out sizes: a turf well over target hands its edge blocks to the
 *  nearest neighbour that is under. Keeps patches compact, stops one crew
 *  drawing 260 doors and the next 80. */
function balance(groups) {
  const size = (g) => g.reduce((s, a) => s + a.n, 0)
  for (let pass = 0; pass < 400; pass++) {
    const big = groups.filter((g) => size(g) > TURF_DOORS * 1.25).sort((a, b) => size(b) - size(a))[0]
    if (!big) break
    let move = null
    for (const a of big) {
      for (const g of groups) {
        if (g === big || size(g) + a.n > TURF_DOORS * 1.1) continue
        const d = Math.min(...g.map((b) => dist(a.c, b.c)))
        if (!move || d < move.d) move = { a, g, d }
      }
    }
    if (!move || move.d > 260) break
    big.splice(big.indexOf(move.a), 1)
    move.g.push(move.a)
  }
  return groups
}

function segmentsOf(atoms) {
  return atoms.map((a) => ({ street_name: a.name, city: DEMO_CITY.toUpperCase(), range_start: a.lo, range_end: a.hi, parity: 'both' }))
}

function planCut(doors) {
  const atoms = buildAtoms(doors).filter((a) => a.c && a.geo >= a.n * 0.9)
  // The middle of the densest ground: the atom with the most doors within 900m.
  let best = null
  for (const a of atoms) {
    let n = 0
    for (const b of atoms) if (dist(a.c, b.c) < 900) n += b.n
    if (!best || n > best.n) best = { a, n }
  }
  const centre = best.a.c
  const ordered = [...atoms].sort((a, b) => dist(a.c, centre) - dist(b.c, centre))
  const region = []
  let total = 0
  for (const a of ordered) {
    if (total >= TURF_DOORS * TURF_COUNT) break
    region.push(a); total += a.n
  }
  let groups = balance(cluster(region, TURF_COUNT))
  const size = (g) => g.reduce((t, x) => t + x.n, 0)
  // A scrap joins its nearest neighbour; anything that leaves too big is
  // halved. Repeat until every turf is a morning's walk for a small crew.
  const halve = (g) => {
    const xs = g.map((a) => a.c[0]), ys = g.map((a) => a.c[1])
    const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
    const sorted = [...g].sort((a, b) => (wide ? a.c[0] - b.c[0] : a.c[1] - b.c[1]))
    const half = size(g) / 2
    const one = [], two = []
    let run = 0
    for (const a of sorted) { (run + a.n / 2 < half ? one : two).push(a); run += a.n }
    return [one, two]
  }
  for (let pass = 0; pass < 30; pass++) {
    const big = groups.find((g) => size(g) > TURF_DOORS * 1.4)
    if (big) { groups = groups.filter((g) => g !== big).concat(halve(big)); continue }
    const small = groups.find((g) => size(g) < TURF_DOORS * 0.6)
    if (!small) break
    const c = centroid(small)
    const host = groups.filter((g) => g !== small).sort((x, y) => dist(centroid(x), c) - dist(centroid(y), c))[0]
    groups = groups.filter((g) => g !== small)
    host.push(...small)
  }
  const used = new Set()
  const turfs = groups.map((g, i) => {
    const byStreet = new Map()
    for (const a of g) byStreet.set(a.name, (byStreet.get(a.name) ?? 0) + a.n)
    let name = title([...byStreet.entries()].sort((a, b) => b[1] - a[1])[0][0])
    while (used.has(name)) name += ' 2'
    used.add(name)
    const pts = g.flatMap((a) => a.doors.filter((d) => d.lat != null).map(xy))
    const w = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))
    const h = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))
    return { id: randomUUID(), name, color: PALETTE[i % PALETTE.length], atoms: g, c: centroid(g), n: g.reduce((s, a) => s + a.n, 0), w, h }
  })
  turfs.sort((a, b) => dist(a.c, centre) - dist(b.c, centre))
  return { turfs, centre }
}

/** A leader's split: strips along the turf's long axis, equal doors each. */
function splitTurf(turf, k) {
  const horizontal = turf.w >= turf.h
  const atoms = [...turf.atoms].sort((a, b) => (horizontal ? a.c[0] - b.c[0] : a.c[1] - b.c[1]))
  const shares = Array.from({ length: k }, () => [])
  let run = 0
  for (const a of atoms) {
    const i = Math.min(k - 1, Math.floor((run + a.n / 2) / (turf.n / k)))
    shares[i].push(a)
    run += a.n
  }
  return shares
}

// ------------------------------------------------------------------ knocks

function walkOrder(doors) {
  return [...doors].sort((a, b) => a.name.localeCompare(b.name) || a.num - b.num)
}

/** One person's day on one list of doors. Deterministic per (person, day),
 *  so a top-up an hour later replays the same morning and then carries on. */
function knockShare(member, doors, day, untilHour) {
  const rng = makeRng(hash32(`${member.id}:${day}`))
  const pace = 10 + rng() * 5
  let hour = day === TODAY ? 10 + rng() * 1.6 : rng() < 0.5 ? 9.5 + rng() * 2 : 15.5 + rng() * 2
  const end = Math.min(hour + 3.5 + rng() * 2, untilHour)
  const out = []
  for (const d of walkOrder(doors)) {
    if (d.closed) continue
    const unsigned = d.persons.filter((p) => !d.signed.has(p))
    if (d.persons.length && !unsigned.length) continue
    hour += (0.6 + rng() * 0.8) / pace
    if (hour > end) break
    const at = (h) => atHour(day, Math.floor(h), (h % 1) * 60)
    const row = (outcome, person_id, h = hour) => out.push({
      client_id: randomUUID(), household_id: d.id, person_id, canvasser_id: member.id, outcome, occurred_at: at(h),
    })
    const r = rng()
    if (r < 0.02) { row('skip', null); d.closed = true; continue }
    if (rng() > 0.4) { row('not_home', null); continue }
    const kind = rng()
    if (kind < 0.03) { row('hostile', null); d.closed = true; continue }
    const who = unsigned.length ? unsigned[Math.floor(rng() * unsigned.length)] : null
    if (kind < 0.47 && who) {
      row('signed', who); d.signed.add(who)
      let h = hour
      for (const p of unsigned) {
        if (p === who || rng() > 0.5) continue
        h += 1 / 60
        row('signed', p, h); d.signed.add(p)
      }
      hour += 3 / 60
    } else if (kind < 0.77) {
      row('didnt_sign', rng() < 0.7 ? who : null); d.closed = true
      hour += 1.5 / 60
    } else {
      row('maybe', rng() < 0.7 ? who : null)
      hour += 1.5 / 60
    }
  }
  return out
}

// ------------------------------------------------------------------ sites
//
// A petition is worked from a table too (the Site tab). Three places, and two
// people who are not out with a crew today collecting there. A site signature
// is a knock_logs row with site_id, filed at the signer's own household.

const PETITION_SITES = ['Farmers market', 'Public library, front steps', 'Grocery store, east entrance']

async function siteSignatures(campaign, sim, doors) {
  for (const name of PETITION_SITES) {
    await sql(`insert into sites (campaign_id, name) select ${q(campaign.id)}, ${q(name)}
      where not exists (select 1 from sites where campaign_id = ${q(campaign.id)} and name = ${q(name)})`)
  }
  const sites = await sql(`select id, name from sites where campaign_id = ${q(campaign.id)} order by name`)
  const out = new Set((await sql(`select m.user_id from squad_members m join squads s on s.id = m.squad_id where s.squad_date = ${q(TODAY)}`)).map((r) => r.user_id))
  const free = sim.filter((p) => p.role === 'canvasser' && !out.has(p.id)).sort((a, b) => a.id.localeCompare(b.id))
  const rng = makeRng(hash32(`sites:${TODAY}`))
  const open = shuffle(doors.filter((d) => !d.closed).flatMap((d) => d.persons.filter((p) => !d.signed.has(p)).map((p) => ({ p, d }))), rng)
  const rows = []
  const until = nowHour()
  sites.slice(0, 2).forEach((site, i) => {
    const who = free[i]
    if (!who) return
    let hour = 10.5 + rng()
    while (true) {
      hour += (4 + rng() * 14) / 60
      if (hour > Math.min(until, 16)) break
      const pick = open.pop()
      if (!pick) break
      const signed = rng() < 0.8
      if (signed) pick.d.signed.add(pick.p)
      rows.push({
        client_id: randomUUID(), household_id: pick.d.id, person_id: pick.p, canvasser_id: who.id, site_id: site.id,
        outcome: signed ? 'signed' : 'didnt_sign', occurred_at: atHour(TODAY, Math.floor(hour), (hour % 1) * 60),
      })
    }
  })
  await insertChunked('knock_logs', rows, 400)
  log(`  ${sites.length} petition sites, ${rows.length} logged at them today`)
}

function nowHour() {
  const d = new Date()
  return d.getHours() + d.getMinutes() / 60
}

// ------------------------------------------------------------------ main

async function main() {
  const campaign = await requireDemoCampaign()
  log(`Demo today — ${TODAY}${dryRun ? ' (dry run)' : topUp ? ' (top up)' : ''}`)

  const profiles = await sql(`select id, username, display_name, role, color, is_simulated from profiles where campaign_id = ${q(campaign.id)} and role in ('canvasser','team_lead')`)
  const sim = profiles.filter((p) => p.is_simulated && p.display_name)
  if (args.includes('--sites')) {
    await sql(`delete from knock_logs where site_id is not null and canvasser_id in (${profiles.filter((p) => p.is_simulated).map((p) => q(p.id)).join(',')})`)
    return siteSignatures(campaign, sim, await loadDoors())
  }
  const simIds = sim.map((p) => q(p.id)).join(',')
  const dayStart = (day) => q(atHour(day, 0, 0))

  if (topUp) {
    await doTopUp(sim, simIds, dayStart)
    return siteSignatures(campaign, sim, await loadDoors())
  }

  let doors = await loadDoors()
  const { turfs } = planCut(doors)
  log(`\n── The cut: ${turfs.length} turfs, ${turfs.reduce((s, t) => s + t.n, 0)} doors`)
  for (const t of turfs) log(`  ${t.name.padEnd(26)} ${String(t.n).padStart(4)} doors   ${Math.round(t.w)} x ${Math.round(t.h)} m`)
  if (dryRun) return log('\n[dry-run] nothing written')

  // ---- 1. clean board
  const lastKnock = (await sql(`select max((occurred_at at time zone 'America/New_York')::date)::text d from knock_logs where canvasser_id in (${simIds}) and occurred_at < ${dayStart(TODAY)}`))[0].d
  const gapDays = []
  for (let d = addDays(lastKnock, 1); daysBetween(d, TODAY) > 0; d = addDays(d, 1)) gapDays.push(d)
  const from = gapDays[0] ?? TODAY
  log(`\n── Clearing turf, and simulated activity from ${from}`)
  await sql(`
    delete from knock_logs where canvasser_id in (${simIds}) and occurred_at >= ${dayStart(from)};
    delete from squad_members where squad_id in (select s.id from squads s join profiles p on p.id = s.created_by where p.is_simulated and s.squad_date >= ${q(from)});
    delete from squads where squad_date >= ${q(from)} and created_by in (select id from profiles where is_simulated);
    delete from turfs where parent_turf_id is not null;
    update addresses set turf_id = null where turf_id is not null;
    delete from turfs;`)

  // ---- 2. cut
  const cutter = profiles.find((p) => p.is_simulated && p.role === 'team_lead') ?? sim[0]
  await insertChunked('turfs', turfs.map((t) => ({ id: t.id, name: t.name, color: t.color, created_by: cutter.id, created_at: atHour(TODAY, 8, 0) })))
  for (const t of turfs) {
    const got = (await sql(`select public.set_turf_segments(${q(t.id)}, ${q(JSON.stringify(segmentsOf(t.atoms)))}::jsonb) n`))[0].n
    if (got !== t.n) log(`  ! ${t.name}: planned ${t.n}, claimed ${got}`)
  }
  log(`  ${turfs.length} turfs cut`)

  // ---- 3. crews
  const rng = makeRng(hash32(`crews:${TODAY}`))
  const kept = await sql(`
    select s.id, s.name, (select array_agg(m.user_id) from squad_members m where m.squad_id = s.id) members
    from squads s where s.squad_date = ${q(TODAY)}`)
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const busy = new Set(kept.flatMap((s) => s.members ?? []))
  const makeCrews = (day, count, exclude) => {
    const r = makeRng(hash32(`crews:${day}`))
    const leads = shuffle(sim.filter((p) => p.role === 'team_lead' && !exclude.has(p.id)), r)
    const plain = shuffle(sim.filter((p) => p.role === 'canvasser' && !exclude.has(p.id)), r)
    const crews = []
    for (let i = 0; i < count; i++) {
      const lead = leads[i] ?? plain.pop()
      const members = [lead, ...plain.splice(0, CREW_SIZE - 1 + (r() < 0.35 ? 1 : 0))]
      crews.push({ id: randomUUID(), name: `${lead.display_name.split(' ')[0]}'s squad`, day, lead, members, fresh: true })
    }
    return crews
  }
  const todays = [
    ...kept.map((s) => ({ id: s.id, name: s.name, day: TODAY, members: (s.members ?? []).map((id) => byId.get(id)).filter(Boolean), fresh: false })),
    ...makeCrews(TODAY, Math.max(0, CREWS_TODAY - kept.length), busy),
  ]
  const gapCrews = gapDays.flatMap((d) => makeCrews(d, CREWS_GAP_DAY, new Set()))
  const fresh = [...todays, ...gapCrews].filter((c) => c.fresh)
  await insertChunked('squads', fresh.map((c) => ({ id: c.id, name: c.name, squad_date: c.day, created_by: c.lead.id })))
  await insertChunked('squad_members', fresh.flatMap((c) => c.members.map((m) => ({ squad_id: c.id, user_id: m.id }))))
  log(`  ${todays.length} crews today (${kept.length} kept), ${gapCrews.length} on ${gapDays.join(', ') || 'no gap days'}`)

  // ---- 4. dispatch + split (today)
  const knocks = []
  doors = await loadDoors()
  const doorById = new Map(doors.map((d) => [d.id, d]))
  const live = (atoms) => atoms.flatMap((a) => a.doors.map((d) => doorById.get(d.id)))
  for (let i = 0; i < todays.length; i++) {
    const crew = todays[i]
    const turf = turfs[i]
    if (!crew.members.length) continue
    await sql(`update turfs set squad_id = ${q(crew.id)} where id = ${q(turf.id)}`)
    const shares = splitTurf(turf, crew.members.length)
    for (let m = 0; m < crew.members.length; m++) {
      const who = crew.members[m]
      if (!shares[m].length) continue
      const sub = randomUUID()
      await insertChunked('turfs', [{
        id: sub, name: `${who.display_name ?? who.username}'s doors`, color: who.color ?? PALETTE[(i + m) % PALETTE.length],
        parent_turf_id: turf.id, assignee_id: who.id, created_by: (crew.lead ?? who).id, created_at: atHour(TODAY, 9, 0),
      }])
      await sql(`select public.set_turf_segments(${q(sub)}, ${q(JSON.stringify(segmentsOf(shares[m])))}::jsonb)`)
      if (who.is_simulated) knocks.push(...knockShare(who, live(shares[m]), TODAY, nowHour()))
    }
    log(`  ${crew.name.padEnd(22)} -> ${turf.name} (${crew.members.map((m) => m.display_name ?? m.username).join(', ')})`)
  }

  // ---- 5. gap days: the crews work the turf still waiting on the board
  const waiting = turfs.slice(todays.length)
  const perDay = new Map()
  for (const crew of gapCrews) {
    const n = perDay.get(crew.day) ?? 0
    perDay.set(crew.day, n + 1)
    const turf = [...waiting, ...turfs][(n + gapDays.indexOf(crew.day) * 2) % turfs.length]
    const shares = splitTurf(turf, crew.members.length)
    crew.members.forEach((who, m) => knocks.push(...knockShare(who, live(shares[m]), crew.day, 24)))
  }
  knocks.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  await insertChunked('knock_logs', knocks, 400)
  log(`  ${knocks.length} knocks written (${knocks.filter((k) => k.occurred_at >= atHour(TODAY, 0, 0)).length} today)`)
  await siteSignatures(campaign, sim, await loadDoors())
}

async function doTopUp(sim, simIds, dayStart) {
  await sql(`delete from knock_logs where canvasser_id in (${simIds}) and occurred_at >= ${dayStart(TODAY)}`)
  const doors = await loadDoors()
  const subs = await sql(`
    select t.id, t.assignee_id from turfs t join turfs p on p.id = t.parent_turf_id join squads s on s.id = p.squad_id
    where s.squad_date = ${q(TODAY)} and t.assignee_id in (${simIds})`)
  const byTurf = new Map()
  for (const d of doors) {
    if (!d.turf_id) continue
    let a = byTurf.get(d.turf_id)
    if (!a) byTurf.set(d.turf_id, (a = []))
    a.push(d)
  }
  const simById = new Map(sim.map((p) => [p.id, p]))
  const knocks = []
  for (const s of subs) knocks.push(...knockShare(simById.get(s.assignee_id), byTurf.get(s.id) ?? [], TODAY, nowHour()))
  knocks.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  await insertChunked('knock_logs', knocks, 400)
  log(`  ${subs.length} people out, ${knocks.length} knocks today so far`)
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })
