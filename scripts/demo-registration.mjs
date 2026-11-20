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
// Rebuilding is idempotent: it wipes its own campaign first. Run it again the
// morning of a demo so "today" has shifts and the past week has numbers; the
// dates are computed from the clock, not stored.
//
// It also writes demo/site-plan-sample.csv: a small site plan for NEXT week,
// laid out the way a real one tends to be, with crew names that exist in the
// app, for showing the import.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from './apply-migration.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NAME = 'Voter Registration Demo'
const GOAL = 1500
const TZ = 'America/New_York'

// Per-conversation odds by site, so the places differ the way real ones do:
// a campus has many unregistered people, a library mostly registered ones.
// [registered, updated, already_registered, not_eligible, declined]
const SITES = [
  { name: 'Community college, student center', notes: 'Table inside the main doors. Student life office signed off.', perHour: 7, odds: [0.2, 0.09, 0.42, 0.07, 0.22] },
  { name: 'Grocery store, east entrance', notes: 'Stay left of the cart return. Manager wants a heads up each visit.', perHour: 8, odds: [0.08, 0.07, 0.6, 0.04, 0.21] },
  { name: 'Public library, front steps', notes: 'Outside only.', perHour: 4, odds: [0.07, 0.08, 0.66, 0.03, 0.16] },
  { name: 'Farmers market', notes: 'Saturdays. Booth space by the entrance.', perHour: 9, odds: [0.09, 0.1, 0.58, 0.03, 0.2] },
  { name: 'Transit stop, uptown', notes: 'Short conversations. People are catching a bus.', perHour: 6, odds: [0.14, 0.06, 0.45, 0.08, 0.27] },
  { name: 'Apartment complex, mail room', notes: 'High turnover, lots of address updates. Leasing office OK.', perHour: 5, odds: [0.13, 0.2, 0.44, 0.05, 0.18] },
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
}

async function build() {
  await wipe()
  const { today, minute: nowMin } = ohioNow()
  const rand = rng(20261119)

  const [{ id: cid }] = await sql(`
    insert into public.campaigns (name, description, mode, signature_goal, is_active)
    values (${q(NAME)}, 'Sample data for the demo. None of these sites or numbers are real.', 'registration', ${GOAL}, true)
    returning id
  `)
  await sql(`
    insert into public.campaign_members (campaign_id, user_id)
    select distinct ${q(cid)}::uuid, m.user_id from public.campaign_members m
    on conflict do nothing
  `)

  const pool = await sql(`
    select p.id, coalesce(p.display_name, p.username) as name
    from public.profiles p
    where p.role in ('canvasser', 'team_lead')
      -- Simulated staff only ("Renata A."). A real person who signed up to
      -- look around must never find themselves scheduled on a fake shift.
      and p.display_name ~ '^[A-Z][a-z]+ [A-Z]\.$'
    order by p.username
  `)
  if (pool.length < 6) throw new Error('Not enough canvasser accounts to staff the demo shifts.')

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
          logs.push({ user: person.id, site: site.id, shift: shift.id, result, at: `${day} ${clock(at)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` })
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
      insert into public.registration_logs (campaign_id, canvasser_id, site_id, shift_id, result, occurred_at) values
      ${chunk
        .map(
          (l) =>
            `(${q(cid)}, ${q(l.user)}, ${q(l.site)}, ${q(l.shift)}, ${q(l.result)}, (${q(l.at)}::timestamp at time zone ${q(TZ)}))`,
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
  console.log(`  ${sites.length} sites, ${shifts.length} shifts (${shifts.filter((s) => s.day === today).length} today), ${logs.length} conversations, ${made} registrations.`)
  console.log('  Wrote demo/site-plan-sample.csv')
}

if (process.argv.includes('--wipe')) await wipe()
else await build()
