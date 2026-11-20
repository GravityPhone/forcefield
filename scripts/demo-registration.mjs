// Build (or remove) the voter registration demo campaign.
//
//   node scripts/demo-registration.mjs          rebuild it, relative to right now
//   node scripts/demo-registration.mjs --wipe   remove it
//
// Creates ONE campaign, "Voter Registration Demo", in registration mode, with
// six sample sites, three weeks of shifts (two behind today, one ahead) and
// simulated tallies for every shift that has already happened. Everybody who
// is on any campaign is added to it, so it shows up as a second chip on the
// Campaign page and in the header's switch sheet without anyone joining.
//
// EVERYTHING HERE IS FAKE and says so: the campaign is named "Demo", its
// description says sample data, and the sites are generic places rather than
// real businesses (nobody gave permission to stand anywhere).
//
// Rebuilding is idempotent: it keeps its campaign row and replaces the contents. Run it again the
// morning of a demo so "today" has shifts and the past week has numbers; the
// dates are computed from the clock, not stored.
//
// It also writes demo/site-plan-sample.csv: a small site plan for NEXT week,
// laid out the way a real one tends to be, with crew names that exist in the
// app, for showing the import.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { sql } from './apply-migration.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NAME = 'Voter Registration Demo'
const GOAL = 1500
const TZ = 'America/New_York'

// Per-conversation odds by site, so the places differ the way real ones do:
// a campus has many unregistered people, a library mostly registered ones.
// [registered, updated, already_registered, not_eligible, declined]
// `perHour` is results one person LOGS in an hour, not people approached:
// nobody tallies everyone who walks past. Most of what gets written down is a
// form (new or updated); the rest are names looked up and found on the roll.
const SITES = [
  { name: 'Community college, student center', notes: 'Table inside the main doors. Student life office signed off.', perHour: 2.4, odds: [0.56, 0.14, 0.2, 0.04, 0.06] },
  { name: 'Grocery store, east entrance', notes: 'Stay left of the cart return. Manager wants a heads up each visit.', perHour: 1.6, odds: [0.34, 0.16, 0.38, 0.03, 0.09] },
  { name: 'Public library, front steps', notes: 'Outside only.', perHour: 1.0, odds: [0.3, 0.18, 0.4, 0.03, 0.09] },
  { name: 'Farmers market', notes: 'Saturdays. Booth space by the entrance.', perHour: 2.2, odds: [0.38, 0.2, 0.32, 0.02, 0.08] },
  { name: 'Transit stop, uptown', notes: 'Short conversations. People are catching a bus.', perHour: 1.3, odds: [0.46, 0.12, 0.26, 0.06, 0.1] },
  { name: 'Apartment complex, mail room', notes: 'High turnover, lots of address updates. Leasing office OK.', perHour: 1.7, odds: [0.3, 0.42, 0.2, 0.03, 0.05] },
]
const RESULTS = ['registered', 'updated', 'already_registered', 'not_eligible', 'declined']
const SLOTS = [
  ['09:00', '13:00'],
  ['11:00', '15:00'],
  ['15:00', '19:00'],
]

// Deterministic, so two rebuilds on the same day tell the same story.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// THE REGISTRATION DRIVE HAS ITS OWN PEOPLE (2026-11-20, user call: "entirely
// different histories and people on both of them"). These accounts exist only
// in this campaign, on their own team, so its leaderboard, feed, shifts and
// Analytics never show a name from the petition crew. No first name here is
// used by the petition's simulated staff.
const TEAM = 'Registration Crew'
const STAFF = [
  ['Aurelio', 'V', 'team_lead'], ['Bronwyn', 'S', 'team_lead'],
  ['Cyrus', 'M'], ['Darcy', 'O'], ['Esme', 'K'], ['Felipe', 'R'], ['Greta', 'N'], ['Hollis', 'B'],
  ['Idris', 'W'], ['Joaquin', 'D'], ['Keiko', 'T'], ['Lucinda', 'P'], ['Marcus', 'E'], ['Nia', 'G'],
  ['Oskar', 'L'], ['Pilar', 'C'], ['Quentin', 'H'], ['Rosalind', 'F'], ['Santiago', 'J'], ['Tamsin', 'A'],
].map(([first, last, role]) => ({
  handle: `reg-${first}-${last}`.toLowerCase(),
  display: `${first} ${last}.`,
  role: role ?? 'canvasser',
}))
const AVATARS = ['accordion', 'anchor', 'avocado', 'badger', 'bagel', 'balloon', 'banjo', 'bear', 'beaver', 'bell',
  'bird', 'blossom', 'blueberries', 'broccoli', 'butterfly', 'cactus', 'camel', 'carrot', 'cherries', 'compass']

function keysFile() {
  let dir = HERE
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'KEYS-AND-ACCESS.md')
    if (existsSync(p)) return p
    dir = dirname(dir)
  }
  throw new Error('KEYS-AND-ACCESS.md not found walking up from scripts/')
}
function admin() {
  const m = readFileSync(keysFile(), 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m)
  if (!m) throw new Error('SUPABASE_SERVICE_ROLE_KEY not found in KEYS-AND-ACCESS.md')
  return createClient('https://whrliwbdxjdcksbvwkrc.supabase.co', m[1].trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Make sure the registration crew exists and belongs to this campaign only.
 * Accounts are created with NO password: nobody signs in as them. */
async function ensureStaff(cid) {
  const supa = admin()
  let [team] = await sql(`select id from public.teams where name = ${q(TEAM)} limit 1`)
  if (!team) [team] = await sql(`insert into public.teams (name, campaign_id) values (${q(TEAM)}, ${q(cid)}) returning id`)
  else await sql(`update public.teams set campaign_id = ${q(cid)} where id = ${q(team.id)}`)

  const have = await sql(`select id, username from public.profiles where username in (${STAFF.map((p) => q(p.handle)).join(', ')})`)
  const idOf = new Map(have.map((r) => [r.username, r.id]))
  for (const p of STAFF) {
    if (idOf.has(p.handle)) continue
    const { data, error } = await supa.auth.admin.createUser({
      email: `${p.handle}@example.com`,
      email_confirm: true,
      user_metadata: { username: p.handle },
    })
    if (error) throw new Error(`createUser ${p.handle}: ${error.message}`)
    idOf.set(p.handle, data.user.id)
  }
  const ids = STAFF.map((p) => idOf.get(p.handle))
  // Membership first: the profile guard refuses an active campaign you have
  // not joined.
  await sql(`
    insert into public.campaign_members (campaign_id, user_id)
    values ${ids.map((id) => `(${q(cid)}, ${q(id)})`).join(', ')}
    on conflict do nothing;
    delete from public.campaign_members where user_id in (${ids.map(q).join(', ')}) and campaign_id <> ${q(cid)};
  `)
  for (let i = 0; i < STAFF.length; i++) {
    const p = STAFF[i]
    await sql(`
      update public.profiles set
        display_name = ${q(p.display)}, role = ${q(p.role)}, team_id = ${q(team.id)},
        campaign_id = ${q(cid)}, avatar = ${q(AVATARS[i % AVATARS.length])}, is_simulated = true
      where id = ${q(ids[i])}
    `)
  }
  // The petition's simulated staff were all added to this campaign by earlier
  // builds. Take them back out, except anyone actually switched into it.
  await sql(`
    delete from public.campaign_members m
    using public.profiles p
    where m.campaign_id = ${q(cid)} and p.id = m.user_id and p.is_simulated
      and p.team_id is distinct from ${q(team.id)}
      and p.campaign_id is distinct from ${q(cid)}
  `)
  return STAFF.map((p, i) => ({ id: ids[i], name: p.display }))
}

async function removeStaff() {
  const supa = admin()
  const rows = await sql(`select id from public.profiles where username in (${STAFF.map((p) => q(p.handle)).join(', ')})`)
  for (const { id } of rows) {
    const { error } = await supa.auth.admin.deleteUser(id)
    if (error) throw new Error(`deleteUser ${id}: ${error.message}`)
  }
  await sql(`delete from public.teams where name = ${q(TEAM)}`)
  if (rows.length) console.log(`Removed ${rows.length} registration crew accounts.`)
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

/** Today's date and the current minute of the day, in Ohio. */
function ohioNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  )
  return { today: `${parts.year}-${parts.month}-${parts.day}`, minute: +parts.hour * 60 + +parts.minute }
}

/** YYYY-MM-DD shifted by whole days, on calendar parts (never 86.4M ms). */
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}
const weekday = (day) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
const minutes = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5)
const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

async function wipe() {
  const found = await sql(`select id from public.campaigns where name = ${q(NAME)}`)
  for (const { id } of found) {
    // Anyone whose ACTIVE campaign is this one goes back to another they are
    // on; deleting it out from under them would null the pointer and send
    // them to the join-a-campaign gate.
    await sql(`
      update public.profiles p
      set campaign_id = (
        select m.campaign_id from public.campaign_members m
        where m.user_id = p.id and m.campaign_id <> ${q(id)}
        order by m.joined_at limit 1
      )
      where p.campaign_id = ${q(id)};
      delete from public.registration_logs where campaign_id = ${q(id)};
      delete from public.campaigns where id = ${q(id)};
    `)
    console.log(`Removed ${NAME} (${id}).`)
  }
  if (!found.length) console.log('Nothing to remove.')
  await markUnregistered(0)
  await removeStaff()
}

const UNREGISTERED_SHARE = 0.2

async function markUnregistered(share = UNREGISTERED_SHARE) {
  await sql(`
    update public.persons set registered_voter = true where not registered_voter;
    update public.persons p set registered_voter = false
    from public.addresses a
    where a.id = p.household_id and a.city = 'Marysville'
      and (('x' || substr(md5(p.id::text), 1, 6))::bit(24)::int % 1000) < ${Math.round(share * 1000)}
      and not exists (select 1 from public.knock_logs k where k.person_id = p.id and k.outcome = 'signed');
  `)
}

async function build() {
  const { today, minute: nowMin } = ohioNow()
  const rand = rng(20261119)

  // A rebuild KEEPS the campaign row and only replaces what is inside it.
  // The id staying put is the point: everybody already switched into the
  // campaign stays there, and nothing the app remembers about it goes stale.
  // Deleting and recreating it used to drop people back onto their other
  // campaign on the morning of a demo.
  const existing = await sql(`select id from public.campaigns where name = ${q(NAME)} order by created_at limit 1`)
  let cid = existing[0]?.id
  if (cid) {
    await sql(`
      delete from public.registration_logs where campaign_id = ${q(cid)};
      delete from public.site_plan_sources where campaign_id = ${q(cid)};
      delete from public.sites where campaign_id = ${q(cid)};
      update public.campaigns set mode = 'registration', is_active = true, signature_goal = ${GOAL} where id = ${q(cid)};
    `)
    console.log(`Refreshing ${NAME} (${cid}).`)
  } else {
    ;[{ id: cid }] = await sql(`
      insert into public.campaigns (name, description, mode, signature_goal, is_active)
      values (${q(NAME)}, 'Sample data for the demo. None of these sites or numbers are real.', 'registration', ${GOAL}, true)
      returning id
    `)
  }
  const pool = await ensureStaff(cid)
  // Names for today's "found on the roll" rows, so the Site tab's list for
  // today reads like a real afternoon. Pointers at voter-file rows only.
  //
  // NOT EVERYBODY IS REGISTERED. The file is a list of registered voters, so
  // a registration drive would have nobody in it to register. For the demo a
  // fixed share of Marysville (UNREGISTERED_SHARE, the same people every
  // rebuild) is marked persons.registered_voter = false. Nobody who has
  // signed the petition is in it. --wipe puts everyone back.
  await markUnregistered()
  const roll = (await sql(`select id from public.persons where registered_voter order by random() limit 400`)).map((r) => r.id)
  const open = (await sql(`select p.id from public.persons p where not p.registered_voter order by random() limit 400`)).map((r) => r.id)

  const sites = SITES.map((s) => ({ ...s, id: randomUUID() }))
  await sql(`
    insert into public.sites (id, campaign_id, name, address, notes) values
    ${sites.map((s) => `(${q(s.id)}, ${q(cid)}, ${q(s.name)}, 'Marysville, OH', ${q(s.notes)})`).join(',\n')}
  `)

  const shifts = []
  const members = []
  const logs = []
  for (let offset = -14; offset <= 6; offset++) {
    const day = addDays(today, offset)
    const dow = weekday(day)
    const weekend = dow === 0 || dow === 6
    // Which places today: the market only on Saturdays, more sites at weekends.
    const candidates = sites.filter((s) => s.name !== 'Farmers market' || dow === 6)
    const count = weekend ? 3 : 2 + (rand() < 0.4 ? 1 : 0)
    const picked = [...candidates].sort(() => rand() - 0.5).slice(0, count)
    if (dow === 6 && !picked.some((s) => s.name === 'Farmers market')) picked[0] = sites[3]

    picked.forEach((site, i) => {
      const [start, end] = SLOTS[i % SLOTS.length]
      const shift = { id: randomUUID(), site, day, start, end, goal: 10 + 5 * Math.floor(rand() * 4) }
      shifts.push(shift)
      const crew = [...pool].sort(() => rand() - 0.5).slice(0, 2 + (rand() < 0.5 ? 1 : 0))
      for (const person of crew) members.push({ shift: shift.id, user: person.id })

      // Tallies only for time that has actually passed.
      const startMin = minutes(start)
      const endMin = minutes(end)
      const through = offset < 0 ? endMin : offset === 0 ? Math.min(endMin, nowMin) : startMin
      const worked = through - startMin
      if (worked <= 0) return
      for (const person of crew) {
        const pace = site.perHour * (0.7 + rand() * 0.6)
        const n = Math.round((worked / 60) * pace)
        for (let k = 0; k < n; k++) {
          let roll = rand()
          let result = RESULTS[RESULTS.length - 1]
          for (let r = 0; r < RESULTS.length; r++) {
            roll -= site.odds[r]
            if (roll < 0) {
              result = RESULTS[r]
              break
            }
          }
          const at = startMin + Math.floor(rand() * worked)
          const onRoll = offset === 0 && (result === 'already_registered' || result === 'updated')
          // A new registration is usually somebody in the file who was not
          // registered; now and then it is a name the file never had.
          const fromOpen = offset === 0 && result === 'registered' && rand() < 0.75 && open.length
          logs.push({ user: person.id, site: site.id, shift: shift.id, result, person: onRoll ? roll[Math.floor(rand() * roll.length)] : fromOpen ? open.pop() : null, at: `${day} ${clock(at)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` })
        }
      }
    })
  }

  await sql(`
    insert into public.site_shifts (id, site_id, shift_date, start_time, end_time, goal) values
    ${shifts.map((s) => `(${q(s.id)}, ${q(s.site.id)}, ${q(s.day)}, ${q(s.start)}, ${q(s.end)}, ${s.goal})`).join(',\n')}
  `)
  await sql(`
    insert into public.site_shift_members (shift_id, user_id) values
    ${members.map((m) => `(${q(m.shift)}, ${q(m.user)})`).join(',\n')}
  `)
  for (let i = 0; i < logs.length; i += 800) {
    const chunk = logs.slice(i, i + 800)
    await sql(`
      insert into public.registration_logs (campaign_id, canvasser_id, site_id, shift_id, person_id, result, occurred_at) values
      ${chunk
        .map(
          (l) =>
            `(${q(cid)}, ${q(l.user)}, ${q(l.site)}, ${q(l.shift)}, ${l.person ? q(l.person) : 'null'}, ${q(l.result)}, (${q(l.at)}::timestamp at time zone ${q(TZ)}))`,
        )
        .join(',\n')}
    `)
  }

  // A site plan for NEXT week, shaped like somebody's real sheet: their own
  // header words, one "Hours" column, names separated by commas.
  const names = pool.slice(0, 6).map((p) => p.name)
  const us = (day) => {
    const [, m, d] = day.split('-').map(Number)
    return `${m}/${d}`
  }
  const csv = [
    ['Location', 'Address', 'Date', 'Hours', 'Target', 'Staff', 'Comments'],
    ['Community college, student center', 'Marysville, OH', us(addDays(today, 7)), '10am-2pm', '25', `${names[0]}, ${names[1]}`, 'Bring the folding table'],
    ['Grocery store, east entrance', 'Marysville, OH', us(addDays(today, 7)), '3-7pm', '15', `${names[2]}, ${names[3]}`, ''],
    ['County fairgrounds, gate B', '', us(addDays(today, 8)), '11am-3pm', '30', `${names[4]}, ${names[5]}, ${names[0]}`, 'New site. Event day'],
    ['Public library, front steps', 'Marysville, OH', us(addDays(today, 9)), '1-5pm', '10', names[1], ''],
  ]
    .map((row) => row.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\n')
  const dir = join(HERE, '..', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'site-plan-sample.csv'), csv + '\n')

  const made = logs.filter((l) => l.result === 'registered' || l.result === 'updated').length
  console.log(`Built ${NAME} (${cid}).`)
  console.log(`  ${sites.length} sites, ${shifts.length} shifts (${shifts.filter((s) => s.day === today).length} today), ${logs.length} results logged, ${made} registrations, ${pool.length} crew.`)
  console.log('  Wrote demo/site-plan-sample.csv')
}

if (process.argv.includes('--wipe')) await wipe()
else await build()
