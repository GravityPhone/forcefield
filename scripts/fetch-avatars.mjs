// Downloads Fluent Emoji (MIT, microsoft/fluentui-emoji) flat-style SVGs
// into public/avatars/ and generates src/lib/avatars.ts with the grouped
// slug lists the /profile "Pick my emoji" sheet renders. Re-run any time:
//   node scripts/fetch-avatars.mjs
//
// Names are CLDR emoji names. Repo folder = the name with its first letter
// capitalized; the file inside is lowercase with spaces as "_". Only emoji
// WITHOUT skin-tone variants belong here (people emoji live under an extra
// Default/ folder level this script doesn't know about).
//
// Curation rule (2026-07-21): no animal whose name doubles as a person-
// directed insult, a body-shaming jab, or a US-party symbol — this is a
// petition app, avatars label real teammates. Removed picks live on in
// LEGACY below so anyone who chose one before the cut still renders.
const GROUPS = [
  {
    label: 'Animals',
    names: [
      // mammals
      'dog face', 'dog', 'guide dog', 'poodle', 'fox', 'raccoon', 'cat face',
      'cat', 'lion', 'tiger face', 'tiger', 'leopard', 'horse face', 'horse',
      'unicorn', 'zebra', 'deer', 'bison', 'ox', 'water buffalo', 'ram', 'goat',
      'camel', 'two-hump camel', 'llama', 'giraffe', 'mammoth', 'hamster',
      'rabbit face', 'rabbit', 'chipmunk', 'hedgehog', 'bear', 'polar bear',
      'koala', 'panda', 'otter', 'kangaroo', 'badger',
      // birds
      'rooster', 'hatching chick', 'baby chick', 'front-facing baby chick',
      'bird', 'penguin', 'dove', 'eagle', 'duck', 'swan', 'owl', 'flamingo',
      // amphibians + reptiles (+ honorary dinosaurs)
      'frog', 'turtle', 'lizard', 'dragon face', 'dragon', 'sauropod', 't-rex',
      // marine
      'dolphin', 'seal', 'fish', 'tropical fish', 'blowfish', 'octopus',
      // the friendly bugs
      'butterfly', 'honeybee', 'beetle', 'lady beetle', 'cricket',
    ],
  },
  {
    label: 'Smileys & spooky',
    names: [
      'grinning face', 'face with tears of joy', 'rolling on the floor laughing',
      'slightly smiling face', 'upside-down face', 'melting face', 'winking face',
      'smiling face with halo', 'smiling face with hearts',
      'smiling face with heart-eyes', 'star-struck', 'pleading face',
      'face holding back tears', 'face with tongue', 'zany face',
      'money-mouth face', 'smiling face with sunglasses', 'nerd face',
      'face with monocle', 'thinking face', 'saluting face', 'partying face',
      'cowboy hat face', 'disguised face', 'exploding head', 'hot face',
      'cold face', 'smiling face with horns', 'clown face', 'ghost', 'alien',
      'alien monster', 'robot', 'jack-o-lantern', 'pile of poo',
    ],
  },
  {
    label: 'Food & drink',
    names: [
      'red apple', 'peach', 'cherries', 'strawberry', 'blueberries', 'grapes',
      'watermelon', 'lemon', 'banana', 'pineapple', 'mango', 'kiwi fruit',
      'coconut', 'avocado', 'hot pepper', 'carrot', 'ear of corn', 'broccoli',
      'mushroom', 'pretzel', 'bagel', 'croissant', 'waffle', 'pancakes',
      'cheese wedge', 'hamburger', 'french fries', 'pizza', 'hot dog', 'taco',
      'burrito', 'sushi', 'steaming bowl', 'popcorn', 'doughnut', 'cookie',
      'cupcake', 'birthday cake', 'candy', 'lollipop', 'chocolate bar',
      'honey pot', 'soft ice cream', 'ice cream', 'hot beverage', 'bubble tea',
      'tropical drink',
    ],
  },
  {
    label: 'Nature & weather',
    names: [
      'sun', 'sun with face', 'crescent moon', 'full moon face', 'new moon face',
      'star', 'glowing star', 'shooting star', 'comet', 'ringed planet',
      'globe showing americas', 'rainbow', 'cloud', 'high voltage', 'snowflake',
      'snowman', 'fire', 'droplet', 'water wave', 'tornado', 'volcano',
      'sunflower', 'rose', 'tulip', 'hibiscus', 'cherry blossom', 'blossom',
      'lotus', 'four leaf clover', 'maple leaf', 'seedling', 'cactus',
      'palm tree', 'evergreen tree', 'deciduous tree',
    ],
  },
  {
    label: 'Sports & games',
    names: [
      'soccer ball', 'basketball', 'baseball', 'american football', 'tennis',
      'volleyball', 'softball', 'ice hockey', 'badminton', 'boxing glove',
      'bowling', 'ping pong', 'pool 8 ball', 'flying disc', 'skateboard',
      'roller skate', 'ice skate', 'skis', 'trophy', 'sports medal',
      '1st place medal', 'bullseye', 'game die', 'puzzle piece', 'video game',
      'joystick', 'kite', 'yo-yo', 'teddy bear', 'piñata',
    ],
  },
  {
    label: 'Music & showtime',
    names: [
      'guitar', 'banjo', 'violin', 'trumpet', 'saxophone', 'drum', 'accordion',
      'microphone', 'headphone', 'musical notes', 'artist palette',
      'performing arts',
    ],
  },
  {
    label: 'Party & sparkle',
    names: [
      'balloon', 'party popper', 'confetti ball', 'wrapped gift', 'crown',
      'top hat', 'graduation cap', 'magic wand', 'crystal ball', 'gem stone',
      'red heart', 'orange heart', 'yellow heart', 'green heart', 'blue heart',
      'purple heart', 'sparkling heart', 'heart on fire', 'sparkles',
    ],
  },
  {
    label: 'Out & about',
    names: [
      'rocket', 'flying saucer', 'telescope', 'satellite', 'racing car',
      'helicopter', 'sailboat', 'anchor', 'roller coaster', 'ferris wheel',
      'circus tent', 'world map', 'compass', 'megaphone', 'door', 'bell',
      'light bulb',
    ],
  },
]

// Slugs removed from the picker whose SVGs stay in public/avatars/ — a
// profile that already points at one keeps rendering; it just can't be
// picked fresh. Never re-add these to GROUPS without re-reading the
// curation rule above.
const LEGACY = [
  'monkey_face', 'monkey', 'gorilla', 'orangutan', 'wolf', 'cow_face', 'cow',
  'pig_face', 'pig', 'boar', 'ewe', 'elephant', 'rhinoceros', 'hippopotamus',
  'mouse_face', 'mouse', 'rat', 'bat', 'sloth', 'skunk', 'beaver', 'turkey',
  'chicken', 'dodo', 'peacock', 'parrot', 'crocodile', 'snake',
  'spouting_whale', 'whale', 'shark', 'snail', 'bug', 'ant', 'spider',
  'scorpion', 'worm',
]

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const RAW = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets'
const outDir = path.resolve('public/avatars')
await mkdir(outDir, { recursive: true })

// Repo convention: spaces become "_", hyphens stay ("t-rex_flat.svg").
// Repo filenames keep diacritics ("piñata_flat.svg"); our local slugs are
// ASCII-folded so avatar URLs never need percent-encoding.
const remoteSlugOf = (name) => name.replace(/\s+/g, '_').toLowerCase()
const slugOf = (name) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_').toLowerCase()

/** Folder-name candidates: "T-rex" style first-letter caps, plus a couple of
 * known repo quirks. */
function folderCandidates(name) {
  const cap = name.charAt(0).toUpperCase() + name.slice(1)
  return [...new Set([cap, cap.replace(/-(\w)/g, (_, c) => `-${c.toUpperCase()}`)])]
}

async function fetchOne(name) {
  const slug = slugOf(name)
  const remote = encodeURIComponent(`${remoteSlugOf(name)}_flat.svg`)
  for (const folder of folderCandidates(name)) {
    const url = `${RAW}/${encodeURIComponent(folder)}/Flat/${remote}`
    const res = await fetch(url)
    if (res.ok) {
      await writeFile(path.join(outDir, `${slug}.svg`), Buffer.from(await res.arrayBuffer()))
      return slug
    }
  }
  return null
}

// Small worker pool — ~250 files sequentially is needlessly slow.
const jobs = GROUPS.flatMap((g) => g.names.map((name) => ({ group: g.label, name })))
const bySlug = new Map() // group label -> slugs kept in list order
for (const g of GROUPS) bySlug.set(g.label, [])
const missed = []
let done = 0
let cursor = 0
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++]
    const slug = await fetchOne(job.name)
    if (slug) bySlug.get(job.group).push({ name: job.name, slug })
    else missed.push(`${job.group}: ${job.name}`)
    done++
    process.stdout.write(`\r${done}/${jobs.length} fetched, ${missed.length} missed…   `)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
console.log()

// Preserve each group's curated order (workers finish out of order).
const groupsOut = GROUPS.map((g) => {
  const got = new Map(bySlug.get(g.label).map((e) => [e.name, e.slug]))
  return { label: g.label, slugs: g.names.filter((n) => got.has(n)).map((n) => got.get(n)) }
})

const ts = `// Generated by scripts/fetch-avatars.mjs — do not edit by hand.
// Fluent Emoji flat SVGs (MIT, microsoft/fluentui-emoji), one per slug in
// public/avatars/, grouped for the /profile "Pick my emoji" sheet.

export interface AvatarGroup {
  label: string
  slugs: readonly string[]
}

export const AVATAR_GROUPS: readonly AvatarGroup[] = ${JSON.stringify(groupsOut, null, 2)}

export const ALL_AVATARS: readonly string[] = AVATAR_GROUPS.flatMap((g) => [...g.slugs])

/** Retired from the picker (curation) but still renderable — profiles that
 * picked one before the cut keep their art. SVGs stay in public/avatars/. */
export const LEGACY_AVATARS: readonly string[] = ${JSON.stringify(LEGACY, null, 2)}

const AVATAR_SET = new Set([...ALL_AVATARS, ...LEGACY_AVATARS])

/** Public URL for an avatar slug; '' when the user hasn't picked one. */
export function avatarUrl(slug: string | null | undefined): string {
  return slug && AVATAR_SET.has(slug) ? \`/avatars/\${slug}.svg\` : ''
}

/** Human name for a slug — the CLDR emoji name the slug was derived from. */
export function avatarName(slug: string): string {
  const name = slug.replace(/_/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}
`
await writeFile(path.resolve('src/lib/avatars.ts'), ts)
const total = groupsOut.reduce((n, g) => n + g.slugs.length, 0)
console.log(`Wrote ${total} SVGs across ${groupsOut.length} groups and src/lib/avatars.ts`)
if (missed.length) console.log('MISSED:\n  ' + missed.join('\n  '))
