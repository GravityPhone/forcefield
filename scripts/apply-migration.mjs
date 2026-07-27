// Apply a migration file to the live database via the Supabase Management API.
//
// Pushing to GitHub does NOT apply migrations on this project (no Supabase
// integration), so this is the path. Reads SUPABASE_ACCESS_TOKEN from the
// gitignored KEYS-AND-ACCESS.md — walks up from scripts/ so it works from a
// worktree, where that file does not exist.
//
//   node scripts/apply-migration.mjs supabase/migrations/<file>.sql
//   node scripts/apply-migration.mjs --sql "select 1"

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_REF = 'whrliwbdxjdcksbvwkrc'

function keysFile() {
  let dir = HERE
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'KEYS-AND-ACCESS.md')
    if (existsSync(p)) return p
    dir = dirname(dir)
  }
  throw new Error('KEYS-AND-ACCESS.md not found walking up from scripts/')
}

function secret(name) {
  const keys = readFileSync(keysFile(), 'utf8')
  const m = keys.match(new RegExp(`^${name}=(.+)$`, 'm'))
  if (!m) throw new Error(`${name} not found in KEYS-AND-ACCESS.md`)
  return m[1].trim()
}

export async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret('SUPABASE_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('apply-migration.mjs')) {
  const args = process.argv.slice(2)
  const sqlIdx = args.indexOf('--sql')
  const query = sqlIdx >= 0 ? args[sqlIdx + 1] : readFileSync(resolve(args[0]), 'utf8')
  if (sqlIdx < 0) console.log(`Applying ${args[0]} …`)
  const out = await sql(query)
  console.log(JSON.stringify(out, null, 1).slice(0, 4000))
  if (sqlIdx < 0) console.log('OK')
}
