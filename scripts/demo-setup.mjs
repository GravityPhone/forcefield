// Build the Demo Campaign world: campaign, people, geography.
//
// This is the part that does not change day to day. scripts/demo-simulate.mjs
// generates the activity on top of it.
//
//   node scripts/demo-setup.mjs                 # campaign + accounts + roster (wipes old activity)
//   node scripts/demo-setup.mjs --geocode       # geocode the rest of Marysville (COSTS MONEY, ~$9)
//   node scripts/demo-setup.mjs --dry-run       # report what it would do
//
// Account policy, decided by the user 2026-07-26:
//   - The 59-account batch from the old sim (all first-last@example.com,
//     created inside 13 seconds on 2026-07-14) is DELETED. Its ids are in
//     sim-manifest.json, which is the authoritative list — pattern-matching on
//     the email would be a guess.
//   - The 6 Google sign-ups are REAL PEOPLE trying the app. Kept untouched
//     except for the display-name default.
//   - The ~14 leftover username accounts (testguy, qa-permbreaker, conan…)
//     are kept, moved into the Demo Campaign, and flagged is_simulated. They
//     become the "signed up and never went out" cohort, which a real roster
//     always has and which the simulation would otherwise have to invent.
//   - Everyone lands in the Demo Campaign.
//
// Display names are "First L." everywhere — set only where display_name is
// currently null, so a deliberately chosen name (Barry) survives.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  REPO_ROOT, supa, sql, fetchAll, secret, makeRng, shuffle, pick,
  addDays, atHour, DEMO_CAMPAIGN_NAME, DEMO_CITY, DEMO_TEAM_NAME,
} from './demo-lib.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const geocodeOnly = args.includes('--geocode')
const rand = makeRng(0x5eed1234)

const MANIFEST = join(REPO_ROOT, 'sim-manifest.json')
const DEMO_MANIFEST = join(REPO_ROOT, 'demo-manifest.json')
const USERS_MD = join(REPO_ROOT, 'DEMO-USERS.md')

// The campaign arc, decided with the user. See research/notes/simulation-model.md.
export const CAMPAIGN_START = '2026-06-15'   // ~6 weeks before the demo
export const SIGNATURE_GOAL = 4000
export const DEADLINE = '2026-09-12'         // matches CAMPAIGN_FACTS in campaignContent.ts
export const ROSTER_TARGET = 65

const FIRST = [
  'Alma', 'Marcus', 'Priya', 'Desmond', 'Nora', 'Tobias', 'Lena', 'Rashad', 'Imani', 'Curtis',
  'Sofia', 'Beau', 'Ingrid', 'Malik', 'Rosalie', 'Trevor', 'Yusuf', 'Deja', 'Callum', 'Mira',
  'Otto', 'Selena', 'Grant', 'Fatima', 'Neil', 'Camille', 'Xavier', 'Bettina', 'Jonah', 'Adaeze',
  'Roland', 'Petra', 'Emmett', 'Nadia', 'Corey', 'Liesl', 'Damon', 'Renata', 'Wes', 'Harriet',
  'Lorenzo', 'Cassie', 'Bernard', 'Anika', 'Vaughn', 'Delia', 'Elias', 'Marisol', 'Reggie', 'Thea',
  'Owen', 'Juno', 'Hector', 'Willa', 'Andre', 'Colette', 'Simon', 'Layla', 'Fitz', 'Odette',
  'Barrett', 'Noor', 'Gideon', 'Verity', 'Rufus', 'Esme', 'Dashiell', 'Paloma', 'Merritt', 'Ivy',
]
const LAST = [
  'Alvarez', 'Boone', 'Castellanos', 'Duffy', 'Ellington', 'Fairbanks', 'Grady', 'Hollis',
  'Ibarra', 'Janssen', 'Kowalski', 'Lindqvist', 'Mbeki', 'Nakamura', 'Ortega', 'Pruitt',
  'Quintero', 'Rasmussen', 'Sackett', 'Thorne', 'Ulrich', 'Vasquez', 'Whitfield', 'Yates',
  'Zamora', 'Ashford', 'Beckwith', 'Cardenas', 'Delacroix', 'Eastwood', 'Farrow', 'Gallagher',
  'Hutchins', 'Iverson', 'Jessup', 'Keating', 'Larkin', 'Moreau', 'Novak', 'Oyelaran',
  'Pemberton', 'Quigley', 'Rutherford', 'Sandoval', 'Tillman', 'Underwood', 'Vandermeer',
  'Wexler', 'Ybarra', 'Zeller', 'Abernathy', 'Bracken', 'Colefax', 'Dunmore', 'Everly',
  'Fontaine', 'Granville', 'Halloway', 'Ingersoll', 'Jarvis', 'Kingsley', 'Lockhart',
  'Mortimer', 'Northcott', 'Ovington',
]
const AVATARS = [
  'fox', 'owl', 'bear', 'raccoon', 'otter', 'badger', 'hedgehog', 'koala', 'panda', 'penguin',
  'duck', 'eagle', 'swan', 'parrot', 'flamingo', 'peacock', 'dove', 'cat', 'dog', 'poodle',
  'rabbit', 'hamster', 'chipmunk', 'beaver', 'deer', 'bison', 'horse', 'goat', 'llama', 'camel',
  'giraffe', 'kangaroo', 'frog', 'turtle', 'octopus', 'dolphin', 'seal', 'butterfly', 'honeybee',
  'sunflower', 'cactus', 'maple_leaf', 'mushroom', 'strawberry', 'avocado', 'taco', 'pretzel',
  'doughnut', 'cupcake', 'hot_beverage', 'guitar', 'trumpet', 'drum', 'artist_palette',
  'soccer_ball', 'basketball', 'bicycle', 'rocket', 'anchor', 'compass', 'hot_air_balloon',
  'rainbow', 'crescent_moon', 'sparkles', 'bullseye',
]
const COLORS = [
  '#e11d48', '#ea580c', '#d97706', '#65a30d', '#059669', '#0d9488',
  '#0891b2', '#2563eb', '#7c3aed', '#c026d3', '#db2777', '#78716c',
]
const BIOS = [
  'Lived in Marysville since 2009. Two kids, one very loud dog.',
  'Retired from Honda after 28 years. Walks the same three blocks every morning.',
  'Substitute teacher. Knocks doors on weekends when the grading is done.',
  'Grew up on a farm outside Richwood, moved into town for work.',
  'Runs the counter at a hardware store. Knows half these streets by name.',
  'Nursing student. Doing this between clinical rotations.',
  'Third-shift at the plant, so afternoons are free.',
  'Moved here for a job and stayed for the neighbors.',
  null, null, null,
]
const WHYS = [
  'Somebody knocked on my door once and it mattered.',
  'I want my kids to see that this is how it works.',
  'Easier to complain about things you never tried to change.',
  'A neighbor asked me to come out once and I never stopped.',
  'It is the one part of politics that still feels like people.',
  null, null,
]
const FUN_FACTS = [
  'Can name every street in the 43040 zip code.',
  'Has walked more than 400 miles for this campaign.',
  'Brings dog treats. Always.',
  'Undefeated at the county fair pie contest.',
  'Once got a signature from someone mowing their lawn mid-row.',
  null, null, null,
]

const log = (...a) => console.log(...a)

// ------------------------------------------------------------------ helpers

/** "Steven Sorensen" -> "Steven S." — the display convention for everybody.
 *
 *  `taken` disambiguates by lengthening the surname rather than by appending a
 *  number: two real people called Luke K. both collapse to "Luke K.", and
 *  "Luke K. (2)" reads as a duplicate account while "Luke Kr." reads as a
 *  person. Nothing enforces uniqueness in the schema — this is legibility, not
 *  a constraint. */
function firstLastInitial(fullName, taken) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  let [first, ...rest] = parts
  // "Luke Krewson 2" — a trailing number is a second account, not a surname.
  while (rest.length && /^\d+$/.test(rest[rest.length - 1])) rest.pop()
  if (!rest.length) return first

  const last = rest[rest.length - 1]
  for (let n = 1; n <= last.length; n++) {
    const candidate = `${first} ${last.slice(0, n)}.`
    if (!taken || !taken.has(candidate)) {
      taken?.add(candidate)
      return candidate
    }
  }
  const full = `${first} ${last}`
  taken?.add(full)
  return full
}

async function one(q, label) {
  const { data, error } = await q
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

// ------------------------------------------------------------------ phases

async function wipeActivity() {
  log('\n── Wiping the old activity layer')
  // Order matters: knock_logs references squads/turfs/profiles/persons.
  // appointments + volunteer_interest + member_locations reference profiles,
  // and profiles is about to lose 59 rows.
  const stmts = [
    `delete from public.knock_logs`,
    `delete from public.appointments`,
    `delete from public.volunteer_interest`,
    `delete from public.volunteer_phones`,
    `delete from public.member_locations`,
    `delete from public.squad_members`,
    `delete from public.squads`,
    `update public.addresses set turf_id = null where turf_id is not null`,
    `delete from public.turf_assignments`,
    `delete from public.turf_segments`,
    `delete from public.turfs`,
  ]
  if (dryRun) return log(`  [dry-run] would run ${stmts.length} deletes`)
  for (const s of stmts) await sql(s)
  log('  knocks, squads, turfs, appointments and location pings cleared')
}

async function deleteBatchAccounts() {
  log('\n── Deleting the old 59-account sim batch')
  if (!existsSync(MANIFEST)) {
    log('  no sim-manifest.json — nothing to delete')
    return []
  }
  const mf = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const ids = mf.userIds ?? []
  if (!ids.length) return []

  // Verify before deleting: every id must be an @example.com account created
  // in the batch window. A manifest is a record, not a guarantee, and this
  // deletes auth users irreversibly.
  const rows = await sql(`
    select u.id, u.email, u.created_at,
           coalesce(u.raw_app_meta_data->>'provider','') as provider
    from auth.users u where u.id in (${ids.map((i) => `'${i}'`).join(',')})`)
  const unsafe = rows.filter((r) => r.provider !== 'email' || !r.email.endsWith('@example.com'))
  if (unsafe.length) {
    throw new Error(`Refusing to delete: ${unsafe.length} manifest ids are not email/@example.com accounts (e.g. ${unsafe[0].email})`)
  }
  log(`  ${rows.length} accounts verified as batch-created @example.com`)
  if (dryRun) return ids

  await sql(`delete from auth.users where id in (${ids.map((i) => `'${i}'`).join(',')})`)
  log(`  deleted ${rows.length} auth users (profiles cascade)`)
  return ids
}

async function ensureCampaignAndTeam() {
  log('\n── Demo Campaign')
  let campaign = await one(
    supa.from('campaigns').select('*').eq('name', DEMO_CAMPAIGN_NAME).maybeSingle(),
    'campaign lookup',
  )
  if (dryRun && !campaign) {
    log(`  [dry-run] would create "${DEMO_CAMPAIGN_NAME}"`)
    return { campaign: { id: '00000000-0000-0000-0000-000000000000' }, team: { id: null } }
  }
  if (!campaign) {
    campaign = await one(
      supa.from('campaigns').insert({
        name: DEMO_CAMPAIGN_NAME,
        description: `Petition drive in ${DEMO_CITY}, Union County. Simulated demonstration data.`,
        is_active: true,
        is_demo: true,
        signature_goal: SIGNATURE_GOAL,
        deadline: DEADLINE,
      }).select().single(),
      'create campaign',
    )
    log(`  created "${DEMO_CAMPAIGN_NAME}" (goal ${SIGNATURE_GOAL}, deadline ${DEADLINE})`)
  } else {
    await one(
      supa.from('campaigns').update({
        is_demo: true, signature_goal: SIGNATURE_GOAL, deadline: DEADLINE, is_active: true,
      }).eq('id', campaign.id).select().single(),
      'update campaign',
    )
    log(`  reusing "${DEMO_CAMPAIGN_NAME}"`)
  }

  let team = await one(
    supa.from('teams').select('*').eq('name', DEMO_TEAM_NAME).maybeSingle(),
    'team lookup',
  )
  if (!team) {
    team = await one(
      supa.from('teams').insert({ name: DEMO_TEAM_NAME, campaign_id: campaign.id }).select().single(),
      'create team',
    )
    log(`  created team "${DEMO_TEAM_NAME}"`)
  } else if (team.campaign_id !== campaign.id) {
    await sql(`update public.teams set campaign_id = '${campaign.id}' where id = '${team.id}'`)
  }
  return { campaign, team }
}

/** Everybody who survived the batch delete: into the campaign, onto the team,
 *  display name defaulted, placeholders flagged. */
async function absorbExistingAccounts(campaign, team) {
  log('\n── Existing accounts')
  const rows = await sql(`
    select p.id, p.username, p.display_name, p.role, p.is_simulated,
           coalesce(u.raw_app_meta_data->>'provider','email') as provider,
           u.raw_user_meta_data->>'full_name' as google_name
    from public.profiles p join auth.users u on u.id = p.id
    order by u.created_at`)

  const google = rows.filter((r) => r.provider === 'google')
  const nonAdmin = rows.filter((r) => r.role !== 'admin')
  const placeholders = rows.filter((r) => r.provider !== 'google' && r.role !== 'admin' && r.username !== 'claudetest')

  log(`  ${rows.length} accounts: ${google.length} Google (real people), ${placeholders.length} to flag as placeholders`)
  if (dryRun) {
    for (const g of google) log(`    keep  ${g.username} -> "${g.display_name ?? firstLastInitial(g.google_name || g.username)}"`)
    for (const p of placeholders) log(`    flag  ${p.username}`)
    return rows
  }

  // Display-name default. Only fills a null: "Barry" was chosen deliberately.
  // Seeded with the names already in use so a new default cannot duplicate one
  // — both Luke Krewson accounts land here and would otherwise both be "Luke K."
  const taken = new Set(rows.map((r) => r.display_name).filter(Boolean))
  const updates = []
  for (const r of rows) {
    if (r.display_name) continue
    const source = r.google_name || r.username
    const dn = firstLastInitial(source, taken)
    if (dn && dn !== r.username) updates.push([r.id, dn])
  }
  if (updates.length) {
    const values = updates.map(([id, dn]) => `('${id}'::uuid, ${escapeLit(dn)})`).join(',')
    await sql(`update public.profiles p set display_name = v.dn
               from (values ${values}) as v(id, dn) where p.id = v.id`)
    log(`  set ${updates.length} display names to "First L."`)
  }

  if (placeholders.length) {
    await sql(`update public.profiles set is_simulated = true
               where id in (${placeholders.map((p) => `'${p.id}'`).join(',')})`)
    log(`  flagged ${placeholders.length} accounts as simulated`)
  }
  // Real Google people are explicitly NOT simulated, even if a prior run said so.
  if (google.length) {
    await sql(`update public.profiles set is_simulated = false
               where id in (${google.map((p) => `'${p.id}'`).join(',')})`)
  }

  // Into the campaign. Admins are exempt in both directions — the guard
  // trigger nulls campaign_id for them and join_campaign refuses them.
  if (nonAdmin.length) {
    const ids = nonAdmin.map((r) => `'${r.id}'`).join(',')
    await sql(`insert into public.campaign_members (campaign_id, user_id)
               select '${campaign.id}', id from public.profiles where id in (${ids})
               on conflict do nothing`)
    await sql(`update public.profiles set campaign_id = '${campaign.id}', team_id = '${team.id}'
               where id in (${ids})`)
    log(`  moved ${nonAdmin.length} accounts into the Demo Campaign`)
  }
  return rows
}

function escapeLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** The simulated roster. Join dates spread across the arc so the roster grows
 *  30 -> 50 -> 65, which is what makes "people came and went" visible. */
async function createRoster(campaign, team, existingRows) {
  log('\n── Simulated roster')

  // Idempotence: people generation is seeded, so a re-run regenerates the SAME
  // 65 handles. If those handles are already in `have` they all collide and the
  // script quietly builds 65 DIFFERENT people on top of the first set. Excluding
  // the previous run's ids is what makes a re-run a repair instead of a double.
  const prior = existsSync(DEMO_MANIFEST)
    ? new Set(JSON.parse(readFileSync(DEMO_MANIFEST, 'utf8')).userIds ?? [])
    : new Set()
  const outsiders = existingRows.filter((r) => !prior.has(r.id))
  const have = new Set(outsiders.map((r) => r.username))
  const takenDisplay = new Set(outsiders.map((r) => r.display_name).filter(Boolean))

  // ROSTER_TARGET is the CAMPAIGN — the 65 people whose join dates make the
  // 30 -> 50 -> 65 growth curve and who carry the canvassing. The surviving
  // legacy accounts are additional members on top of that, deliberately: they
  // are the signed-up-and-never-went-out cohort, and counting them against the
  // target would shrink the active roster to the point where "30 people out
  // today" needs an implausible turnout rate.
  const need = ROSTER_TARGET
  const legacy = existingRows.filter((r) => r.role !== 'admin').length
  log(`  ${legacy} legacy accounts kept as inactive members, creating ${need} campaign people`)

  const firsts = shuffle(FIRST, rand)
  const lasts = shuffle(LAST, rand)
  const avatars = shuffle(AVATARS, rand)
  const people = []
  let fi = 0
  for (let i = 0; people.length < need && fi < firsts.length * 2; fi++) {
    const first = firsts[fi % firsts.length]
    const last = lasts[(fi * 7 + i) % lasts.length]
    const display = `${first} ${last[0]}.`
    const handle = `${first}-${last}`.toLowerCase().replace(/[^a-z-]/g, '').slice(0, 24)
    if (have.has(handle) || takenDisplay.has(display)) continue
    have.add(handle)
    takenDisplay.add(display)

    // Roster growth: 30 at launch, ~50 by week 4, 65 by now.
    const k = people.length
    const joinOffset = k < 30 ? 0
      : k < 50 ? Math.floor(1 + (k - 30) * (21 / 20))
      : Math.floor(22 + (k - 50) * (18 / 15))

    people.push({
      first, last, display, handle,
      joined: addDays(CAMPAIGN_START, joinOffset),
      // 2 managers, 8 leads, rest canvassers — leads have to exist from day one.
      role: k < 2 ? 'campaign_manager' : k < 10 ? 'team_lead' : 'canvasser',
      avatar: avatars[people.length % avatars.length],
      color: pick(COLORS, rand),
      phone: rand() < 0.7 ? `(937) 555-${String(1000 + people.length).slice(-4)}` : null,
      bio: pick(BIOS, rand),
      why: pick(WHYS, rand),
      funFact: pick(FUN_FACTS, rand),
      id: null,
    })
    i++
  }

  if (dryRun) {
    log(`  [dry-run] would create ${people.length}: ${people.slice(0, 5).map((p) => p.display).join(', ')}…`)
    return people
  }

  const password = randomBytes(9).toString('base64url')
  log(`  creating ${people.length} auth users…`)
  for (const p of people) {
    const { data, error } = await supa.auth.admin.createUser({
      email: `${p.handle}@example.com`,
      password,
      email_confirm: true,
      user_metadata: { username: p.handle },
    })
    if (!error) { p.id = data.user.id; continue }
    if (!/already been registered/i.test(error.message)) throw new Error(`createUser ${p.handle}: ${error.message}`)
    const prof = await one(supa.from('profiles').select('id').eq('username', p.handle).single(), `lookup ${p.handle}`)
    p.id = prof.id
  }

  writeFileSync(DEMO_MANIFEST, JSON.stringify({
    campaignId: campaign.id, teamId: team.id,
    userIds: people.map((p) => p.id),
    createdAt: new Date().toISOString(),
  }, null, 2))

  log('  filling profiles…')
  const values = people.map((p) => [
    `'${p.id}'::uuid`, escapeLit(p.display), `'${p.role}'::public.app_role`, `'${team.id}'::uuid`,
    `'${campaign.id}'::uuid`, escapeLit(p.avatar), escapeLit(p.color),
    p.bio ? escapeLit(p.bio) : 'null', p.why ? escapeLit(p.why) : 'null',
    p.funFact ? escapeLit(p.funFact) : 'null', `'${atHour(p.joined, 9)}'::timestamptz`,
  ].join(',')).map((v) => `(${v})`).join(',')

  await sql(`
    update public.profiles p set
      display_name = v.display_name, role = v.role, team_id = v.team_id,
      campaign_id = v.campaign_id, avatar = v.avatar, color = v.color,
      bio = v.bio, why_canvassing = v.why, fun_fact = v.fun_fact,
      created_at = v.created_at, is_simulated = true
    from (values ${values}) as v(id, display_name, role, team_id, campaign_id,
                                 avatar, color, bio, why, fun_fact, created_at)
    where p.id = v.id`)

  await sql(`
    insert into public.campaign_members (campaign_id, user_id, joined_at)
    select '${campaign.id}', p.id, p.created_at from public.profiles p
    where p.id in (${people.map((p) => `'${p.id}'`).join(',')})
    on conflict (campaign_id, user_id) do update set joined_at = excluded.joined_at`)

  const withPhones = people.filter((p) => p.phone)
  if (withPhones.length) {
    await sql(`insert into public.member_phones (user_id, phone) values
      ${withPhones.map((p) => `('${p.id}', ${escapeLit(p.phone)})`).join(',')}
      on conflict (user_id) do update set phone = excluded.phone`)
  }

  writeFileSync(USERS_MD, [
    '# Demo Campaign — simulated accounts',
    '',
    `Generated ${new Date().toISOString()}. Gitignored.`,
    '',
    `Shared password for every account below: \`${password}\``,
    '',
    '| Display | Username | Role | Joined |',
    '|---|---|---|---|',
    ...people.map((p) => `| ${p.display} | ${p.handle} | ${p.role} | ${p.joined} |`),
  ].join('\n'))

  log(`  created ${people.length} people, wrote DEMO-USERS.md`)
  return people
}

// ------------------------------------------------------------------ geocoding

async function geocodeMarysville() {
  log('\n── Geocoding the rest of Marysville')
  const missing = await fetchAll('addresses', 'id, street, city, zip', (q) =>
    q.eq('city', DEMO_CITY).is('lat', null))
  log(`  ${missing.length} doors without coordinates`)
  if (!missing.length) return
  const estimate = (missing.length / 1000) * 5
  log(`  estimated cost: $${estimate.toFixed(2)} at $5/1000`)
  if (dryRun) return log('  [dry-run] no requests made')

  const key = geocodeKey()
  let ok = 0, rejected = 0, failed = 0
  const updates = []
  for (let i = 0; i < missing.length; i++) {
    const a = missing[i]
    const address = `${a.street}, ${a.city}, OH ${a.zip ?? ''}`.trim()
    try {
      const r = await geocodeOne(address, a.street, key)
      if (r) { updates.push([a.id, r.lat, r.lng]); ok++ } else rejected++
    } catch {
      failed++
    }
    if (updates.length >= 200) { await flushCoords(updates); updates.length = 0 }
    if ((i + 1) % 250 === 0) log(`  ${i + 1}/${missing.length} — ${ok} ok, ${rejected} rejected, ${failed} errors`)
  }
  if (updates.length) await flushCoords(updates)
  log(`  done: ${ok} geocoded, ${rejected} rejected by validation, ${failed} request errors`)
}

/** The server-side (unrestricted) Maps key lives in Netlify env, not the KEYS
 *  file. Fall back to the restricted key, which works for Geocoding from a
 *  server because the restriction is by HTTP referrer. */
function geocodeKey() {
  try {
    const out = execSync('netlify env:get GOOGLE_MAPS_API_KEY', {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const val = lines[lines.length - 1]
    if (val && /^AIza[\w-]+$/.test(val)) return val
  } catch { /* CLI unavailable — fall through */ }
  return secret('GOOGLE_MAPS_API_KEY_RESTRICTED')
}

// Union County, matching COUNTY_BOUNDS in src/lib/geocode.ts.
const BOUNDS = { minLat: 40.05, maxLat: 40.50, minLng: -83.65, maxLng: -83.15 }

/** Mirrors geocodeAndCache()'s validation in src/lib/geocode.ts — street-level
 *  result, route name matches the queried street, inside the county. Google
 *  never admits failure; it returns a town centroid instead, and caching that
 *  is what stacked 136 doors on 9 coordinates back in July. */
async function geocodeOne(address, street, key) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('key', key)
  url.searchParams.set('bounds', `${BOUNDS.minLat},${BOUNDS.minLng}|${BOUNDS.maxLat},${BOUNDS.maxLng}`)
  const res = await fetch(url)
  const json = await res.json()
  if (json.status !== 'OK' || !json.results?.length) return null
  const r = json.results[0]

  const loc = r.geometry?.location_type
  const types = r.types ?? []
  const streetLevel = loc === 'ROOFTOP' || loc === 'RANGE_INTERPOLATED'
    || types.includes('street_address') || types.includes('premise') || types.includes('subpremise')
  if (!streetLevel) return null

  const route = r.address_components?.find((c) => c.types.includes('route'))?.long_name
  if (!route || !streetMatches(route, street)) return null

  const { lat, lng } = r.geometry.location
  if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lng < BOUNDS.minLng || lng > BOUNDS.maxLng) return null
  return { lat, lng }
}

const ABBREV = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  BOULEVARD: 'BLVD', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER', PARKWAY: 'PKWY',
  HIGHWAY: 'HWY', TRAIL: 'TRL', CROSSING: 'XING', SQUARE: 'SQ',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
}
function normalizeStreet(s) {
  let t = String(s).toUpperCase().replace(/[.,]/g, ' ')
  t = t.replace(/^OH-(\d+)/, 'STATE ROUTE $1').replace(/^US-(\d+)/, 'US HIGHWAY $1')
  return t.split(/\s+/).filter(Boolean).map((w) => ABBREV[w] ?? w).join(' ')
}
function streetMatches(route, street) {
  const a = normalizeStreet(route)
  const b = normalizeStreet(String(street).replace(/^[0-9]+[A-Z]?\s+/i, ''))
  return a === b || a.includes(b) || b.includes(a)
}

async function flushCoords(updates) {
  const values = updates.map(([id, lat, lng]) => `('${id}'::uuid, ${lat}, ${lng})`).join(',')
  await sql(`update public.addresses a set lat = v.lat, lng = v.lng
             from (values ${values}) as v(id, lat, lng) where a.id = v.id`)
}

// ------------------------------------------------------------------ main

async function main() {
  log(`Demo Campaign setup${dryRun ? ' (dry run)' : ''}`)

  if (geocodeOnly) {
    await geocodeMarysville()
    return
  }

  await wipeActivity()
  await deleteBatchAccounts()
  const { campaign, team } = await ensureCampaignAndTeam()
  const existing = await absorbExistingAccounts(campaign, team)
  await createRoster(campaign, team, existing)

  const stats = await sql(`
    select
      (select count(*) from public.profiles where campaign_id is not null) as in_campaign,
      (select count(*) from public.profiles where is_simulated) as simulated,
      (select count(*) from public.knock_logs) as knocks,
      (select count(*) from public.turfs) as turfs,
      (select count(*) from public.addresses where city = '${DEMO_CITY}') as doors,
      (select count(*) from public.addresses where city = '${DEMO_CITY}' and lat is not null) as geocoded`)
  log('\n── Result')
  log(`  ${JSON.stringify(stats[0])}`)
  log('\nNext: node scripts/demo-setup.mjs --geocode   (then demo-turf, then demo-simulate)')
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })
