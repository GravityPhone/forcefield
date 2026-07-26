/**
 * Get a worktree ready to work in, and tell the other agents you're here.
 *
 * Why this exists: several Claudes work on this repo at once, each in its own
 * git worktree under `.claude/worktrees/`. A worktree only ever contains
 * TRACKED files — and the three things this project can't run without are all
 * gitignored on purpose:
 *
 *   CLAUDE.md          every convention in the project, local-only by choice
 *   .env               VITE_GOOGLE_MAPS_API_KEY, which has NO fallback in
 *                      source (Netlify's secret scanner) — without it the app
 *                      boots and every map says "can't load Google Maps"
 *   KEYS-AND-ACCESS.md Supabase + Netlify credentials
 *
 * So a fresh worktree is an agent with no conventions, no maps, and no keys,
 * and none of that announces itself — the app runs, it's just wrong. This
 * script closes those gaps and registers the claim, in one command.
 *
 * It also owns the two things agents genuinely collide over:
 *   - the dev-server PORT (derived from the worktree name, so two agents can
 *     never race to pick the same "first free" one)
 *   - MIGRATIONS, which all run against the ONE live prod database and share a
 *     timestamp-ordered filename space — see the lock below.
 *
 *   node scripts/agent-setup.mjs                       # who's working, what's missing
 *   node scripts/agent-setup.mjs --claim "squad map"   # link files + take a lane
 *   node scripts/agent-setup.mjs --claim "x" --migrations
 *   node scripts/agent-setup.mjs --done                # release the lane
 *   node scripts/agent-setup.mjs --hook                # SessionStart hook (JSON out)
 *
 * `--hook` is wired into SessionStart in .claude/settings.json, which IS a
 * tracked file — so it lands in every worktree and every new agent runs this
 * without anyone remembering to. That is the whole point: an agent that has
 * never heard of this script still gets the rules, a reserved port, and the
 * other lanes. It auto-registers a placeholder lane so the port is held
 * immediately, and NEVER fails the session — a broken setup script must not be
 * able to stop somebody from working.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const HERE = resolve(git('rev-parse', '--show-toplevel'))
/** All worktrees share ONE .git directory — its parent is the main checkout,
 * which is the only place the gitignored files exist. */
const MAIN = resolve(dirname(resolve(HERE, git('rev-parse', '--git-common-dir'))))
const IS_MAIN = HERE === MAIN
const NAME = IS_MAIN ? 'main' : HERE.split(/[\\/]/).pop()

const BOARD = join(MAIN, '.claude', 'in-flight.json')

/** Seeded from the worktree name, then stepped past whatever the BOARD says is
 * taken — deliberately not "first free port on the machine". Two agents
 * starting at the same moment would both probe 5174 and both think they had
 * it; the board is the only shared state that can settle it. The name seed
 * alone isn't enough either: over 26 ports, four random worktree names collide
 * about a fifth of the time (measured). Vite would silently step to the next
 * port and `dev-login.mjs <port>` would then be pointed at the wrong server.
 * 5173 stays `npm run dev`'s default for the main checkout. */
function portFor(name, board = {}) {
  if (name === 'main') return 5173
  let h = 5381
  for (const ch of name) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  const taken = new Set(Object.entries(board).filter(([who]) => who !== name).map(([, r]) => r.port))
  let port = 5174 + (h % 26)
  for (let step = 0; step < 26 && taken.has(port); step++) port = port === 5199 ? 5174 : port + 1
  return port
}

/** A lane older than this is treated as gone. SessionStart auto-registers, so
 * without an expiry the board would fill with ghosts from every session that
 * ended without --done — and a ghost holding a port is worse than no board at
 * all. Any live session refreshes its own row every time it starts or claims. */
const LANE_TTL_MS = 12 * 60 * 60 * 1000

function readBoard() {
  if (!existsSync(BOARD)) return {}
  let raw
  try {
    raw = JSON.parse(readFileSync(BOARD, 'utf8'))
  } catch {
    return {} // a half-written board is not worth failing a setup over
  }
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(raw).filter(([, r]) => !r?.updated_at || now - r.updated_at < LANE_TTL_MS),
  )
}

/** Write via temp + rename so a second agent saving at the same instant reads
 * either the old file or the new one, never a torn one. The read-modify-write
 * itself is still last-writer-wins; at human timing that has never mattered. */
function writeBoard(board) {
  mkdirSync(dirname(BOARD), { recursive: true })
  const tmp = `${BOARD}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`)
  renameSync(tmp, BOARD)
}

const stamp = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// ---------------------------------------------------------------- environment

/** Copy rather than symlink: symlinks need elevation on Windows, and these
 * files are gitignored in both places so a copy can never be committed. .env
 * is the one that MUST be local — Vite reads it from the project root and has
 * no parent walk. KEYS-AND-ACCESS.md deliberately is NOT copied: the scripts
 * that need it already walk up to the main checkout to find it, and a secret
 * duplicated per worktree is a secret in more places than it needs to be. */
function repairEnvironment(report) {
  if (IS_MAIN) return
  const env = join(HERE, '.env')
  if (!existsSync(env)) {
    if (existsSync(join(MAIN, '.env'))) {
      copyFileSync(join(MAIN, '.env'), env)
      report.push('  copied .env from the main checkout (maps would have failed without it)')
    } else {
      report.push('  !! no .env here OR in the main checkout — Google Maps will not load')
    }
  }
}

function environmentWarnings() {
  const warn = []
  // A worktree inherits the main checkout's CLAUDE.md by the parent-directory
  // walk (it sits three levels up). Verify rather than assume: if the
  // conventions aren't in your context, read MAIN/CLAUDE.md before touching
  // anything — most of this project's rules are impossible to re-derive.
  if (!existsSync(join(HERE, 'CLAUDE.md'))) {
    warn.push(`CLAUDE.md is not in this worktree. It should be inherited from ${join(MAIN, 'CLAUDE.md')} — confirm you actually have it.`)
  }
  if (!existsSync(join(HERE, 'node_modules', 'vite'))) {
    warn.push('No install here yet — run `npm install` before `npm run dev` or `npm run type-check`.')
  }
  return warn
}

// --------------------------------------------------------------------- output

/** This script is the ONLY channel that reliably reaches an agent in a
 * worktree. CLAUDE.md is gitignored, so it isn't checked out here; and Claude
 * Code keys its stored memories by directory, so a worktree gets its own
 * EMPTY memory (verified 2026-07-26 — the three worktree project directories
 * have no memory folder at all). A tracked file in the repo is the one thing
 * that is definitely present. So the rules that cost real money or real damage
 * when got wrong are printed here rather than only written down somewhere an
 * agent in a worktree may never see. */
const RULES = `  Before you start — the four that cost real money or real damage:

    1. NEVER push, and never 'netlify deploy'. Both are metered builds, and from
       a worktree they ship one lane's state as the whole live site. Commit on
       your branch, stop, report. The user does one merge and one push at the end.
    2. Migrations hit the ONE live prod database every agent and the live site
       share, and share a timestamp-ordered filename space. Hold the lock
       (--migrations) or don't write one.
    3. Never type a password into a login form. 'node scripts/dev-login.mjs <port>'
       is how you get past the sign-in screen.
    4. If your change alters a rule CLAUDE.md records, put the bullet you would
       have added in the COMMIT MESSAGE under a 'CLAUDE.md:' line — that file is
       gitignored, so an edit to it from here would never merge.

  Neither CLAUDE.md nor this project's stored memories reach a worktree on their
  own. If the conventions aren't already in your context, read them before you
  touch anything — most of them cannot be re-derived from the code.`

function render(board) {
  const port = portFor(NAME, board)
  const lines = []
  lines.push('')
  lines.push(`  You are in: ${NAME}${IS_MAIN ? '  (the main checkout — CLAUDE.md and the keys live here)' : ''}`)
  lines.push(`  Path:       ${HERE}`)
  lines.push(`  Dev port:   ${port}   ->  PORT=${port} npm run dev`)
  lines.push(`                        ->  node scripts/dev-login.mjs ${port}`)

  const warn = environmentWarnings()
  if (warn.length) {
    lines.push('')
    for (const w of warn) lines.push(`  !! ${w}`)
  }

  const rows = Object.entries(board)
  lines.push('')
  if (!rows.length) {
    lines.push('  Nobody else has claimed a lane.')
  } else {
    lines.push('  In flight:')
    for (const [who, row] of rows) {
      const mine = who === NAME ? ' <- you' : ''
      lines.push(`    ${who}${mine}`)
      lines.push(`      ${row.working_on}`)
      lines.push(`      branch ${row.branch} · port ${row.port} · updated ${row.updated}${row.migrations ? ' · HOLDS THE MIGRATION LOCK' : ''}`)
    }
  }

  const holder = rows.find(([, r]) => r.migrations)
  lines.push('')
  lines.push(holder
    ? `  Migrations: held by ${holder[0]}. Do not write or apply one — they share a live database and a timestamp order.`
    : '  Migrations: free. Take the lock with --migrations before you write one.')
  lines.push('')
  lines.push(`  CLAUDE.md:  ${join(MAIN, 'CLAUDE.md')}`)
  lines.push('')
  lines.push(RULES)
  lines.push('')
  return lines.join('\n')
}

// ----------------------------------------------------------------------- main

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}

const board = readBoard()

/** SessionStart. Prints ONE JSON object and nothing else — anything on stdout
 * that isn't the envelope is not injected, so keep every report inside it. */
if (flag('--hook')) {
  let context
  try {
    const report = []
    repairEnvironment(report)
    // Hold the port and show up on the board straight away, so this agent is
    // visible to the others even if it never gets around to --claim.
    const existing = board[NAME]
    board[NAME] = {
      path: HERE,
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      port: existing?.port ?? portFor(NAME, board),
      working_on: existing?.working_on ?? '(just started — not stated yet)',
      migrations: existing?.migrations ?? false,
      updated: stamp(),
      updated_at: Date.now(),
    }
    writeBoard(board)
    context = [
      report.join('\n'),
      render(board),
      `  Say what you're working on so the other agents can see it:\n` +
        `    node scripts/agent-setup.mjs --claim "<one line>"\n` +
        `  Add --migrations to that if you need to write one. Release with --done.`,
    ].filter(Boolean).join('\n')
  } catch (err) {
    // Never let this stop somebody working — degrade to the rules that matter.
    context =
      `Could not read the agent board (${err.message}). Working blind, so: do NOT push or run ` +
      `netlify deploy, do NOT write a migration without checking with the user first, and read ` +
      `CLAUDE.md in the main checkout before touching anything.`
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  )
  process.exit(0)
}

if (flag('--done')) {
  delete board[NAME]
  writeBoard(board)
  console.log(`\n  Released the lane for ${NAME}.\n`)
  console.log(render(board))
  process.exit(0)
}

if (flag('--claim')) {
  const working = valueOf('--claim')
  if (!working || working.startsWith('--')) {
    console.error('Usage: node scripts/agent-setup.mjs --claim "what you are working on" [--migrations]')
    process.exit(1)
  }

  const wantsMigrations = flag('--migrations')
  const holder = Object.entries(board).find(([who, r]) => r.migrations && who !== NAME)
  if (wantsMigrations && holder && !flag('--force')) {
    console.error(`\n  ${holder[0]} already holds the migration lock ("${holder[1].working_on}").`)
    console.error('  Migrations run against the ONE live prod database and share a timestamp-ordered')
    console.error('  filename space, so two at once is how a schema gets corrupted or a file gets')
    console.error('  silently overwritten. Wait for them, or ask the user to arbitrate.\n')
    process.exit(1)
  }

  const report = []
  repairEnvironment(report)

  board[NAME] = {
    path: HERE,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    port: portFor(NAME, board),
    working_on: working,
    migrations: wantsMigrations,
    updated: stamp(),
    updated_at: Date.now(),
  }
  writeBoard(board)

  if (report.length) console.log(`\n${report.join('\n')}`)
  console.log(render(board))
  process.exit(0)
}

console.log(render(board))
