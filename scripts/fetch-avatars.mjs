// Downloads Fluent Emoji (MIT, microsoft/fluentui-emoji) flat-style SVGs
// into public/avatars/ and generates src/lib/avatars.ts with the grouped
// slug lists the /appearance picker renders. Re-run any time to refresh:
//   node scripts/fetch-avatars.mjs
//
// Names are CLDR emoji names. Repo folder = the name with its first letter
// capitalized; the file inside is lowercase with spaces as "_". Only emoji
// WITHOUT skin-tone variants belong here (people emoji live under an extra
// Default/ folder level this script doesn't know about).
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const GROUPS = [
  {
    label: 'Animals',
    names: [
      // mammals
      'monkey face', 'monkey', 'gorilla', 'orangutan', 'dog face', 'dog', 'guide dog',
      'poodle', 'wolf', 'fox', 'raccoon', 'cat face', 'cat', 'lion', 'tiger face',
      'tiger', 'leopard', 'horse face', 'horse', 'unicorn', 'zebra', 'deer', 'bison',
      'cow face', 'ox', 'water buffalo', 'cow', 'pig face', 'pig', 'boar', 'ram',
      'ewe', 'goat', 'camel', 'two-hump camel', 'llama', 'giraffe', 'elephant',
      'mammoth', 'rhinoceros', 'hippopotamus', 'mouse face', 'mouse', 'rat',
      'hamster', 'rabbit face', 'rabbit', 'chipmunk', 'beaver', 'hedgehog', 'bat',
      'bear', 'polar bear', 'koala', 'panda', 'sloth', 'otter', 'skunk', 'kangaroo',
      'badger',
      // birds
      'turkey', 'chicken', 'rooster', 'hatching chick', 'baby chick',
      'front-facing baby chick', 'bird', 'penguin', 'dove', 'eagle', 'duck', 'swan',
      'owl', 'dodo', 'flamingo', 'peacock', 'parrot',
      // amphibians + reptiles
      'frog', 'crocodile', 'turtle', 'lizard', 'snake', 'dragon face', 'dragon',
      'sauropod', 't-rex',
      // marine
      'spouting whale', 'whale', 'dolphin', 'seal', 'fish', 'tropical fish',
      'blowfish', 'shark', 'octopus',
      // bugs
      'snail', 'butterfly', 'bug', 'ant', 'honeybee', 'beetle', 'lady beetle',
      'cricket', 'spider', 'scorpion', 'worm',
    ],
  },
  {
    label: 'Smileys & spooky',
    names: [
      'grinning face', 'face with tears of joy', 'rolling on the floor laughing',
      'slightly smiling face', 'upside-down face', 'winking face',
      'smiling face with halo', 'smiling face with hearts',
      'smiling face with heart-eyes', 'star-struck', 'face with tongue',
      'zany face', 'money-mouth face', 'smiling face with sunglasses',
      'nerd face', 'face with monocle', 'thinking face', 'saluting face',
      'partying face', 'cowboy hat face', 'disguised face', 'exploding head',
      'hot face', 'cold face', 'smiling face with horns', 'clown face', 'ghost',
      'alien', 'alien monster', 'robot', 'jack-o-lantern', 'pile of poo',
    ],
  },
  {
    label: 'Food & drink',
    names: [
      'red apple', 'peach', 'cherries', 'strawberry', 'blueberries', 'grapes',
      'watermelon', 'lemon', 'banana', 'pineapple', 'mango', 'kiwi fruit',
      'avocado', 'hot pepper', 'carrot', 'ear of corn', 'broccoli', 'mushroom',
      'pretzel', 'bagel', 'croissant', 'waffle', 'pancakes', 'cheese wedge',
      'hamburger', 'french fries', 'pizza', 'hot dog', 'taco', 'burrito',
      'sushi', 'steaming bowl', 'popcorn', 'doughnut', 'cookie', 'cupcake',
      'birthday cake', 'soft ice cream', 'ice cream', 'hot beverage',
      'bubble tea', 'tropical drink',
    ],
  },
  {
    label: 'Nature & weather',
    names: [
      'sun', 'sun with face', 'full moon face', 'new moon face', 'star',
      'glowing star', 'shooting star', 'comet', 'ringed planet',
      'globe showing americas', 'rainbow', 'cloud', 'high voltage', 'snowflake',
      'fire', 'droplet', 'water wave', 'tornado', 'volcano', 'sunflower',
      'rose', 'tulip', 'hibiscus', 'cherry blossom', 'blossom', 'lotus',
      'four leaf clover', 'maple leaf', 'seedling', 'cactus', 'palm tree',
      'evergreen tree', 'deciduous tree',
    ],
  },
  {
    label: 'Fun & games',
    names: [
      'soccer ball', 'basketball', 'baseball', 'american football', 'tennis',
      'volleyball', 'bowling', 'ping pong', 'pool 8 ball', 'flying disc',
      'skateboard', 'roller skate', 'trophy', 'bullseye', 'game die',
      'puzzle piece', 'video game', 'joystick', 'balloon', 'party popper',
      'confetti ball', 'wrapped gift', 'magic wand', 'crystal ball',
      'gem stone', 'crown', 'top hat', 'graduation cap', 'guitar', 'drum',
      'saxophone', 'trumpet', 'violin', 'microphone', 'headphone',
      'musical notes', 'artist palette', 'rocket', 'flying saucer',
      'megaphone', 'door', 'world map', 'compass', 'light bulb',
    ],
  },
]

const RAW = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets'
const outDir = path.resolve('public/avatars')
await mkdir(outDir, { recursive: true })

// Repo convention: spaces become "_", hyphens stay ("t-rex_flat.svg").
const slugOf = (name) => name.replace(/\s+/g, '_').toLowerCase()

/** Folder-name candidates: "T-rex" style first-letter caps, plus a couple of
 * known repo quirks. */
function folderCandidates(name) {
  const cap = name.charAt(0).toUpperCase() + name.slice(1)
  return [...new Set([cap, cap.replace(/-(\w)/g, (_, c) => `-${c.toUpperCase()}`)])]
}

async function fetchOne(name) {
  const slug = slugOf(name)
  for (const folder of folderCandidates(name)) {
    const url = `${RAW}/${encodeURIComponent(folder)}/Flat/${slug}_flat.svg`
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
// public/avatars/, grouped for the /appearance picker.

export interface AvatarGroup {
  label: string
  slugs: readonly string[]
}

export const AVATAR_GROUPS: readonly AvatarGroup[] = ${JSON.stringify(groupsOut, null, 2)}

export const ALL_AVATARS: readonly string[] = AVATAR_GROUPS.flatMap((g) => [...g.slugs])

const AVATAR_SET = new Set(ALL_AVATARS)

/** Public URL for an avatar slug; '' when the user hasn't picked one. */
export function avatarUrl(slug: string | null | undefined): string {
  return slug && AVATAR_SET.has(slug) ? \`/avatars/\${slug}.svg\` : ''
}
`
await writeFile(path.resolve('src/lib/avatars.ts'), ts)
const total = groupsOut.reduce((n, g) => n + g.slugs.length, 0)
console.log(`Wrote ${total} SVGs across ${groupsOut.length} groups and src/lib/avatars.ts`)
if (missed.length) console.log('MISSED:\n  ' + missed.join('\n  '))
