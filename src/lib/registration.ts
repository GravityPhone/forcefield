/**
 * Voter registration mode (2026-11-19).
 *
 * A campaign is a petition or a registration drive (`campaigns.mode`), and
 * that one field decides three things: which buttons Talk shows at a door,
 * whether the Sites screens exist in the nav, and what the tally counts.
 *
 * Registration happens in two places and lands in one table
 * (`registration_logs`):
 *   - at a SITE, one tap per person talked to, written directly;
 *   - at a DOOR, riding on the knock (`knock_logs.reg_result`) so the maps,
 *     the street walk and the offline queue keep working untouched. A trigger
 *     mirrors it across. See the migration header.
 *
 * NOTHING ABOUT THE FORM IS STORED. No date of birth, no licence number, and
 * no reason behind "Not eligible": one button, never a why. The paper form or
 * the state portal is the legal record.
 *
 * The mode ref is a module singleton, like lib/appointments.ts: the nav, the
 * outcome grid and the Sites screens all need the same answer and none owns it.
 */

import { ref } from 'vue'
import { fetchAllRows, supabase } from './supabase'
import { useAuthStore } from '@/stores/auth'
import type { KnockOutcome } from '@/types'

export type CampaignMode = 'petition' | 'registration'

export type RegResult =
  | 'registered'
  | 'updated'
  | 'already_registered'
  | 'not_eligible'
  | 'declined'

/** The five things that can happen when you talk to somebody, in button
 * order. Fixed hexes for the reason lib/outcomes.ts gives: a result has to
 * read the same in every color scheme.
 *
 * `outcome` is what the DOOR is left as when this is logged from Talk, in the
 * six-value knock vocabulary the maps and the walk already understand:
 * a registration or an update is the door producing (green, counts);
 * "already registered" and "not eligible" close the door without counting
 * (skip: nothing to get here, don't walk back to it); declined is a no. */
export const REG_RESULTS: {
  value: RegResult
  label: string
  hex: string
  ink: string
  outcome: KnockOutcome
}[] = [
  { value: 'registered', label: 'Registered', hex: '#2e9e5b', ink: '#181c26', outcome: 'signed' },
  { value: 'updated', label: 'Updated', hex: '#1f8f8a', ink: '#ffffff', outcome: 'signed' },
  { value: 'already_registered', label: 'Already registered', hex: '#8a90a5', ink: '#181c26', outcome: 'skip' },
  { value: 'not_eligible', label: 'Not eligible', hex: '#8a90a5', ink: '#181c26', outcome: 'skip' },
  { value: 'declined', label: 'Declined', hex: '#d64545', ink: '#ffffff', outcome: 'didnt_sign' },
]

export const REG_LABELS = Object.fromEntries(REG_RESULTS.map((r) => [r.value, r.label])) as Record<
  RegResult,
  string
>

export const REG_HEX = Object.fromEntries(REG_RESULTS.map((r) => [r.value, r.hex])) as Record<
  RegResult,
  string
>

/** A skip that means the door could not be reached. Offered in both modes. */
export const INACCESSIBLE_LABEL = 'Inaccessible'

/** Talk's button grid in registration mode: the five results, then the three
 * visit outcomes that have nothing to do with registering anybody. */
export const REG_DOOR_BUTTONS: {
  key: string
  label: string
  hex: string
  outcome: KnockOutcome
  reg: RegResult | null
  inaccessible?: boolean
}[] = [
  ...REG_RESULTS.map((r) => ({ key: r.value, label: r.label, hex: r.hex, outcome: r.outcome, reg: r.value })),
  { key: 'maybe', label: 'Return', hex: '#e0a02e', outcome: 'maybe', reg: null },
  { key: 'not_home', label: 'Not Home', hex: '#8a90a5', outcome: 'not_home', reg: null },
  { key: 'skip', label: 'Skip', hex: '#d64545', outcome: 'skip', reg: null },
  { key: 'hostile', label: 'Hostile', hex: '#d64545', outcome: 'hostile', reg: null },
  { key: 'inaccessible', label: INACCESSIBLE_LABEL, hex: '#d64545', outcome: 'skip', reg: null, inaccessible: true },
]

/** What to call a knock: its registration result when it carries one, else
 * the ordinary outcome label. In a registration campaign a door closed as
 * "Already registered" is stored as a skip, and must not read as "Skip". */
export function knockLabel(
  k: { outcome: KnockOutcome; reg_result?: RegResult | null; inaccessible?: boolean | null },
  labels: Record<KnockOutcome, string>,
): string {
  if (k.reg_result) return REG_LABELS[k.reg_result]
  if (k.inaccessible) return INACCESSIBLE_LABEL
  // Doors are shared by every campaign, so a registration campaign opens
  // doors whose history was written by a petition. That history is still
  // true (somebody went, somebody said yes or no); what must not happen is a
  // registration screen saying "Signed" (2026-11-19, user call). The yes and
  // the no are the only two words that belong to the petition.
  if (campaignMode.value === 'registration') {
    if (k.outcome === 'signed') return REG_LABELS.registered
    if (k.outcome === 'didnt_sign') return REG_LABELS.declined
  }
  return labels[k.outcome]
}

/** "signed" or "registered": the word for a door's yes count ("2/4 signed"). */
export function yesWord(): string {
  return campaignMode.value === 'registration' ? 'registered' : 'signed'
}

export function emptyCounts(): Record<RegResult, number> {
  return { registered: 0, updated: 0, already_registered: 0, not_eligible: 0, declined: 0 }
}

/** Everybody talked to, whatever came of it. */
export function conversations(c: Record<RegResult, number>): number {
  return c.registered + c.updated + c.already_registered + c.not_eligible + c.declined
}

// --------------------------------------------------------------------- mode

/** The active campaign's mode. Petition until the row says otherwise, so a
 * failed read can never turn registration buttons on by itself. */
export const campaignMode = ref<CampaignMode>('petition')

let modeLoadedFor: string | null = null
let modeFlight: Promise<void> | null = null

/** Read the active campaign's mode. Idempotent per campaign; `force` re-reads
 * after a manager changes it.
 *
 * Concurrent callers SHARE one read, and that is load-bearing: the shell asks
 * on every screen and the Sites page asks again a tick later. If the second
 * caller returned early on "already asked", it would carry on with the mode
 * still reading 'petition' and render an empty plan (which it did). Awaiting
 * this always means the answer has landed. */
export function loadCampaignMode(force = false): Promise<void> {
  const cid = useAuthStore().profile?.campaign_id ?? null
  if (!cid) {
    campaignMode.value = 'petition'
    modeLoadedFor = null
    return Promise.resolve()
  }
  if (modeLoadedFor === cid && !force) return modeFlight ?? Promise.resolve()
  modeLoadedFor = cid
  const flight: Promise<void> = (async () => {
    const { data, error } = await supabase.from('campaigns').select('mode').eq('id', cid).maybeSingle()
    if (error) {
      if (modeLoadedFor === cid) modeLoadedFor = null
      return
    }
    // A late answer for a campaign we have since switched away from is stale.
    if (useAuthStore().profile?.campaign_id !== cid) return
    campaignMode.value = (data?.mode as CampaignMode | undefined) ?? 'petition'
  })().finally(() => {
    if (modeFlight === flight) modeFlight = null
  })
  modeFlight = flight
  return flight
}

/** Set the active campaign's mode (managers; RLS is the gate). */
export async function saveCampaignMode(mode: CampaignMode): Promise<{ error?: string }> {
  const cid = useAuthStore().profile?.campaign_id
  if (!cid) return { error: 'No campaign selected.' }
  const { error } = await supabase.from('campaigns').update({ mode }).eq('id', cid)
  if (error) return { error: 'Could not save. Try again.' }
  campaignMode.value = mode
  return {}
}

// -------------------------------------------------------------------- sites

export interface SitePerson {
  id: string
  username: string
  display_name: string | null
  avatar: string | null
  color: string | null
}

export interface SiteShift {
  id: string
  site_id: string
  /** YYYY-MM-DD, a local calendar day. */
  shift_date: string
  /** HH:MM:SS or null. */
  start_time: string | null
  end_time: string | null
  goal: number | null
  notes: string | null
  site: { id: string; name: string; address: string | null }
  members: SitePerson[]
  counts: Record<RegResult, number>
}

const SHIFT_SELECT =
  'id, site_id, shift_date, start_time, end_time, goal, notes, ' +
  'site:sites!inner(id, name, address, campaign_id), ' +
  'members:site_shift_members(person:profiles(id, username, display_name, avatar, color))'

interface ShiftRow extends Omit<SiteShift, 'members' | 'counts'> {
  members: { person: SitePerson | null }[]
}

function shape(row: ShiftRow): SiteShift {
  return {
    ...row,
    members: row.members.map((m) => m.person).filter((p): p is SitePerson => !!p),
    counts: emptyCounts(),
  }
}

async function fillCounts(shifts: SiteShift[]): Promise<void> {
  if (!shifts.length) return
  const byId = new Map(shifts.map((s) => [s.id, s]))
  const ids = [...byId.keys()]
  // Chunked: PostgREST carries an .in() list in the query string.
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    const rows = await fetchAllRows<{ shift_id: string; result: RegResult }>((from, to) =>
      supabase
        .from('registration_logs')
        .select('shift_id, result')
        .in('shift_id', chunk)
        .order('id')
        .range(from, to),
    )
    for (const r of rows) {
      const s = byId.get(r.shift_id)
      if (s && r.result in s.counts) s.counts[r.result]++
    }
  }
}

/** Shifts for the active campaign, upcoming (today on) or the past 30 days. */
export async function fetchShifts(scope: 'upcoming' | 'past', today: string): Promise<SiteShift[]> {
  const cid = useAuthStore().profile?.campaign_id
  if (!cid) return []
  let q = supabase.from('site_shifts').select(SHIFT_SELECT).eq('site.campaign_id', cid)
  q =
    scope === 'upcoming'
      ? q.gte('shift_date', today).order('shift_date').order('start_time', { nullsFirst: true })
      : q.lt('shift_date', today).order('shift_date', { ascending: false }).order('start_time')
  const { data, error } = await q.order('id').limit(400)
  if (error) throw new Error(error.message)
  const shifts = ((data ?? []) as unknown as ShiftRow[]).map(shape)
  await fillCounts(shifts)
  return shifts
}

export async function fetchShift(id: string): Promise<SiteShift | null> {
  const { data, error } = await supabase.from('site_shifts').select(SHIFT_SELECT).eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const shift = shape(data as unknown as ShiftRow)
  await fillCounts([shift])
  return shift
}

/** A place the campaign works, with what has come of it so far. */
export interface SiteRow {
  id: string
  name: string
  address: string | null
  notes: string | null
  /** Shifts ever planned here, past and future. */
  shifts: number
  counts: Record<RegResult, number>
}

/** Every site in the active campaign, by name, with all-time counts. This is
 * the number a site plan exists to produce: which places are worth a crew. */
export async function fetchSites(): Promise<SiteRow[]> {
  const cid = useAuthStore().profile?.campaign_id
  if (!cid) return []
  const { data, error } = await supabase
    .from('sites')
    .select('id, name, address, notes, site_shifts(count)')
    .eq('campaign_id', cid)
    .order('name')
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as unknown as (Omit<SiteRow, 'shifts' | 'counts'> & {
    site_shifts: { count: number }[]
  })[]).map((s) => ({
    id: s.id,
    name: s.name,
    address: s.address,
    notes: s.notes,
    shifts: s.site_shifts[0]?.count ?? 0,
    counts: emptyCounts(),
  }))
  const byId = new Map(rows.map((s) => [s.id, s]))
  const logs = await fetchAllRows<{ site_id: string; result: RegResult }>((from, to) =>
    supabase
      .from('registration_logs')
      .select('site_id, result')
      .eq('campaign_id', cid)
      .not('site_id', 'is', null)
      .order('id')
      .range(from, to),
  )
  for (const l of logs) {
    const s = byId.get(l.site_id)
    if (s && l.result in s.counts) s.counts[l.result]++
  }
  return rows
}

export interface RegistrationTotals {
  /** New registrations plus updates: the forms the campaign produced. */
  registered: number
  registered7d: number
  /** Everybody talked to, at sites and at doors. */
  talked: number
  /** People who have logged at least one. */
  canvassers: number
}

/** Whole-campaign registration numbers for the progress card. Counted by the
 * database (head requests), so the size of the log never reaches the phone. */
export async function fetchRegistrationTotals(campaignId: string): Promise<RegistrationTotals> {
  const base = () =>
    supabase.from('registration_logs').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const made = ['registered', 'updated']
  const [all, week, talked, people] = await Promise.all([
    base().in('result', made),
    base().in('result', made).gte('occurred_at', weekAgo),
    base(),
    fetchAllRows<{ canvasser_id: string }>((from, to) =>
      supabase
        .from('registration_logs')
        .select('canvasser_id')
        .eq('campaign_id', campaignId)
        .order('id')
        .range(from, to),
    ).catch(() => [] as { canvasser_id: string }[]),
  ])
  return {
    registered: all.count ?? 0,
    registered7d: week.count ?? 0,
    talked: talked.count ?? 0,
    canvassers: new Set(people.map((p) => p.canvasser_id)).size,
  }
}

export const MODE_LABELS: Record<CampaignMode, string> = {
  petition: 'Petition',
  registration: 'Voter registration',
}

// ------------------------------------------------------------------ display

/** "9 AM" / "9:30 AM" from a Postgres time. */
export function clockLabel(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const d = new Date(2000, 0, 1, h, m || 0)
  return d.toLocaleTimeString([], { hour: 'numeric', ...(m ? { minute: '2-digit' } : {}) })
}

export function shiftTimeLabel(s: { start_time: string | null; end_time: string | null }): string {
  if (s.start_time && s.end_time) return `${clockLabel(s.start_time)} to ${clockLabel(s.end_time)}`
  if (s.start_time) return `From ${clockLabel(s.start_time)}`
  if (s.end_time) return `Until ${clockLabel(s.end_time)}`
  return ''
}

/** "Today" / "Tomorrow" / "Fri, Nov 20". Built from y/m/d parts: a bare
 * YYYY-MM-DD handed to `new Date` parses as UTC and lands on the wrong day
 * in every US timezone (lib/day.ts has the long version). */
export function shiftDayLabel(dateStr: string, today: string): string {
  if (dateStr === today) return 'Today'
  const [y, m, d] = dateStr.split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const diff = Math.round((date.getTime() - new Date(ty, tm - 1, td).getTime()) / 86_400_000)
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(y !== ty ? { year: 'numeric' } : {}),
  })
}

export function personName(p: { username: string; display_name: string | null }): string {
  return p.display_name || p.username
}
