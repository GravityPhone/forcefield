/**
 * Writing a parsed site plan into the app, and keeping a linked Google Sheet
 * in step with it (2026-11-19).
 *
 * Two ways in, one writer:
 *   - a PASTE or a .csv is a one-time copy: every row becomes a new shift;
 *   - a LINKED SHEET is a source (`site_plan_sources`), and a refresh
 *     RECONCILES instead of appending: a row whose site, date and start time
 *     match a shift that came from that sheet updates it, a new row adds one,
 *     and an upcoming shift whose row has been deleted from the sheet is
 *     removed.
 *
 * WHAT A REFRESH WILL NOT DO, each one on purpose:
 *   - touch a shift that did not come from that sheet (added by hand, pasted,
 *     or from another sheet);
 *   - touch the past. Yesterday's shift stays as it was worked, whatever the
 *     sheet says now;
 *   - delete a shift that already has registrations counted on it. It is kept
 *     and reported, because the sheet losing a row must never lose work.
 *
 * Crew names are matched to accounts by display name, username, or a first
 * name only one person has. A name with no match is reported, never created.
 */

import { fetchAllRows, supabase } from './supabase'
import { apiBase } from './native'
import { localToday } from './day'
import { useAuthStore } from '@/stores/auth'
import { PLAN_FIELDS, parseTable, readPlan, type PlanField, type PlanRow } from './sheetImport'

export interface PlanSource {
  id: string
  url: string
  sheet_key: string
  title: string | null
  /** Field -> header NAME in the sheet. Names survive a column being moved. */
  mapping: Partial<Record<PlanField, string>>
  last_synced_at: string | null
}

export interface PlanWriteResult {
  added: number
  updated: number
  removed: number
  /** Dropped from the sheet but kept here: they have registrations on them. */
  kept: number
  sites: number
  unmatched: string[]
}

export interface SheetRead {
  csv: string
  title: string | null
  key: string
}

/** Read a link-shared Google Sheet through the server (the browser cannot
 * reach docs.google.com from here). Throws with a message fit to show. */
export async function fetchSheet(url: string): Promise<SheetRead> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  let res: Response
  try {
    res = await fetch(`${apiBase}/api/sheet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url }),
    })
  } catch {
    throw new Error('Could not reach the server. Try again.')
  }
  const body = (await res.json().catch(() => null)) as (SheetRead & { error?: string }) | null
  if (!res.ok || !body?.csv) throw new Error(body?.error ?? 'Could not read that sheet.')
  return body
}

export async function fetchSources(): Promise<PlanSource[]> {
  const cid = useAuthStore().profile?.campaign_id
  if (!cid) return []
  const { data } = await supabase
    .from('site_plan_sources')
    .select('id, url, sheet_key, title, mapping, last_synced_at')
    .eq('campaign_id', cid)
    .order('created_at')
  return (data ?? []) as PlanSource[]
}

/** Remember a sheet and how its columns were matched. Linking the same tab
 * again updates the matching rather than making a second source. */
export async function saveSource(
  read: SheetRead,
  url: string,
  mapping: Partial<Record<PlanField, string>>,
): Promise<string> {
  const auth = useAuthStore()
  const cid = auth.profile?.campaign_id
  if (!cid) throw new Error('No campaign selected.')
  const { data, error } = await supabase
    .from('site_plan_sources')
    .upsert(
      { campaign_id: cid, url, sheet_key: read.key, title: read.title, mapping, created_by: auth.profile?.id },
      { onConflict: 'campaign_id,sheet_key' },
    )
    .select('id')
    .single()
  if (error || !data) throw new Error('Could not save the link.')
  return data.id as string
}

const shiftKey = (siteId: string, date: string, start: string | null) =>
  `${siteId}|${date}|${start ? start.slice(0, 5) : ''}`

/** Write a plan. `sourceId` null = append every row (paste, .csv);
 * a source id = reconcile against that sheet's own shifts (see the header). */
export async function writePlan(rowsIn: PlanRow[], sourceId: string | null): Promise<PlanWriteResult> {
  const auth = useAuthStore()
  const cid = auth.profile?.campaign_id
  const me = auth.profile?.id
  if (!cid || !me) throw new Error('No campaign selected.')

  // ---- sites: reuse by name within the campaign, create the rest at once.
  const { data: existingSites, error: e1 } = await supabase.from('sites').select('id, name').eq('campaign_id', cid)
  if (e1) throw e1
  const siteIds = new Map<string, string>()
  for (const s of existingSites ?? []) siteIds.set((s.name as string).toLowerCase(), s.id as string)
  const fresh = new Map<string, { name: string; address: string | null }>()
  for (const r of rowsIn) {
    const key = r.site.toLowerCase()
    if (siteIds.has(key)) continue
    const seen = fresh.get(key)
    if (!seen) fresh.set(key, { name: r.site, address: r.address })
    else if (!seen.address && r.address) seen.address = r.address
  }
  if (fresh.size) {
    const { data: made, error: e2 } = await supabase
      .from('sites')
      .insert([...fresh.values()].map((s) => ({ ...s, campaign_id: cid, created_by: me })))
      .select('id, name')
    if (e2) throw e2
    for (const s of made ?? []) siteIds.set((s.name as string).toLowerCase(), s.id as string)
  }
  const siteOf = (r: PlanRow) => siteIds.get(r.site.toLowerCase())!

  // ---- which rows are new, and which are a shift this sheet already made.
  let rows = rowsIn
  const known = new Map<string, { id: string; shift_date: string }>()
  if (sourceId) {
    // The same site, day and start twice in one sheet is one shift: without
    // this the second copy would be re-added on every refresh. Last one wins.
    const byKey = new Map<string, PlanRow>()
    for (const r of rowsIn) byKey.set(shiftKey(siteOf(r), r.date, r.start), r)
    rows = [...byKey.values()]
    const { data: mine, error: e3 } = await supabase
      .from('site_shifts')
      .select('id, site_id, shift_date, start_time')
      .eq('source_id', sourceId)
      .limit(2000)
    if (e3) throw e3
    for (const s of mine ?? []) {
      known.set(shiftKey(s.site_id as string, s.shift_date as string, s.start_time as string | null), {
        id: s.id as string,
        shift_date: s.shift_date as string,
      })
    }
  }

  const toInsert: PlanRow[] = []
  const toUpdate: { id: string; row: PlanRow }[] = []
  const seenIds = new Set<string>()
  for (const r of rows) {
    const hit = known.get(shiftKey(siteOf(r), r.date, r.start))
    if (hit) {
      toUpdate.push({ id: hit.id, row: r })
      seenIds.add(hit.id)
    } else toInsert.push(r)
  }

  // ---- inserts. PostgREST returns rows in the order sent, which is what
  // lines each new shift up with its crew below.
  let insertedIds: string[] = []
  if (toInsert.length) {
    const { data: made, error: e4 } = await supabase
      .from('site_shifts')
      .insert(
        toInsert.map((r) => ({
          site_id: siteOf(r),
          shift_date: r.date,
          start_time: r.start,
          end_time: r.end,
          goal: r.goal,
          notes: r.notes,
          source_id: sourceId,
          created_by: me,
        })),
      )
      .select('id')
    if (e4) throw e4
    insertedIds = (made ?? []).map((s) => s.id as string)
  }

  // ---- updates, a handful at a time.
  for (let i = 0; i < toUpdate.length; i += 8) {
    const results = await Promise.all(
      toUpdate.slice(i, i + 8).map(({ id, row }) =>
        supabase
          .from('site_shifts')
          .update({ end_time: row.end, goal: row.goal, notes: row.notes })
          .eq('id', id),
      ),
    )
    const failed = results.find((r) => r.error)
    if (failed?.error) throw failed.error
  }

  // ---- rows that left the sheet: upcoming only, and only if nothing has
  // been counted on them.
  let removed = 0
  let kept = 0
  if (sourceId) {
    const today = localToday()
    const stale = [...known.values()].filter((s) => !seenIds.has(s.id) && s.shift_date >= today).map((s) => s.id)
    if (stale.length) {
      const { data: used } = await supabase.from('registration_logs').select('shift_id').in('shift_id', stale).limit(5000)
      const worked = new Set((used ?? []).map((u) => u.shift_id as string))
      const drop = stale.filter((id) => !worked.has(id))
      kept = stale.length - drop.length
      if (drop.length) {
        const { error: e5 } = await supabase.from('site_shifts').delete().in('id', drop)
        if (e5) throw e5
        removed = drop.length
      }
    }
  }

  // ---- crew. An updated shift's crew is replaced with what the sheet says.
  const unmatched = new Set<string>()
  const crewOf: { shiftId: string; names: string[] }[] = [
    ...toInsert.map((r, i) => ({ shiftId: insertedIds[i], names: r.crew })),
    ...toUpdate.map(({ id, row }) => ({ shiftId: id, names: row.crew })),
  ].filter((c) => !!c.shiftId)
  const updatedIds = toUpdate.map((u) => u.id)
  if (updatedIds.length) {
    const { error: e6 } = await supabase.from('site_shift_members').delete().in('shift_id', updatedIds)
    if (e6) throw e6
  }
  if (crewOf.some((c) => c.names.length)) {
    const people = await fetchAllRows<{ id: string; username: string; display_name: string | null }>((from, to) =>
      supabase.from('profiles').select('id, username, display_name').order('id').range(from, to),
    )
    const exact = new Map<string, string>()
    const firstNames = new Map<string, string[]>()
    for (const p of people) {
      exact.set(p.username.toLowerCase(), p.id)
      if (p.display_name) {
        exact.set(p.display_name.toLowerCase(), p.id)
        const first = p.display_name.trim().split(/\s+/)[0].toLowerCase()
        firstNames.set(first, [...(firstNames.get(first) ?? []), p.id])
      }
    }
    const members: { shift_id: string; user_id: string }[] = []
    for (const c of crewOf) {
      const added = new Set<string>()
      for (const typed of c.names) {
        const key = typed.toLowerCase()
        const firsts = firstNames.get(key)
        const id = exact.get(key) ?? (firsts?.length === 1 ? firsts[0] : undefined)
        if (!id) unmatched.add(typed)
        else if (!added.has(id)) {
          added.add(id)
          members.push({ shift_id: c.shiftId, user_id: id })
        }
      }
    }
    if (members.length) {
      const { error: e7 } = await supabase.from('site_shift_members').insert(members)
      if (e7) throw e7
    }
  }

  return {
    added: toInsert.length,
    updated: toUpdate.length,
    removed,
    kept,
    sites: new Set(rows.map((r) => r.site.toLowerCase())).size,
    unmatched: [...unmatched],
  }
}

/** Re-read a linked sheet and reconcile the plan with it. */
export async function syncSource(source: PlanSource): Promise<PlanWriteResult & { skipped: number }> {
  const read = await fetchSheet(source.url)
  const table = parseTable(read.csv)
  const headers = (table[0] ?? []).map((h) => h.trim().toLowerCase())
  const cols = {} as Record<PlanField, number>
  for (const f of PLAN_FIELDS) {
    const name = source.mapping[f.key]
    cols[f.key] = name ? headers.indexOf(name.trim().toLowerCase()) : -1
    if (f.required && cols[f.key] < 0) {
      throw new Error(`The sheet no longer has a "${name ?? f.label}" column. Read the link again to rematch.`)
    }
  }
  const plan = readPlan(table.slice(1), cols)
  const result = await writePlan(plan.rows, source.id)
  await supabase
    .from('site_plan_sources')
    .update({ last_synced_at: new Date().toISOString(), title: read.title ?? source.title })
    .eq('id', source.id)
  return { ...result, skipped: plan.skipped }
}

/** One line for after an import or a refresh. */
export function describeResult(r: PlanWriteResult & { skipped?: number }): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const parts: string[] = []
  if (r.added) parts.push(`${n(r.added, 'shift')} added`)
  if (r.updated) parts.push(`${r.updated} refreshed`)
  if (r.removed) parts.push(`${r.removed} removed`)
  if (!parts.length) parts.push('Nothing to change')
  let line = parts.join(', ') + '.'
  if (r.kept) line += ` ${n(r.kept, 'shift')} kept: no longer in the sheet, but already worked.`
  if (r.skipped) line += ` ${n(r.skipped, 'row')} skipped (no site or date).`
  if (r.unmatched.length) line += ` No account for: ${r.unmatched.join(', ')}.`
  return line
}
