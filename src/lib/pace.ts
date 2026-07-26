/**
 * Campaign pace (2026-07-26) — how many signatures a day the campaign needs
 * to make its filing deadline, and whether it's making them.
 *
 * The goal alone (`campaigns.signature_goal`, on the card since 2026-07-22)
 * only ever answered "how far along are we". With `campaigns.deadline` beside
 * it the more useful question becomes answerable: at today's rate, does this
 * petition qualify? That's one subtraction and one division, but it's the
 * number a campaign actually runs on, so it goes everywhere the goal does.
 *
 * The deadline is read straight off the campaigns row rather than through
 * get_campaign_stats — see the migration for why (that RPC belongs to the
 * campaign-membership work and this has no business forking its body).
 *
 * All day math is LOCAL, like everything else day-scoped in this app
 * (lib/day.ts): the filing office closes on a calendar day, and a UTC day
 * would roll over mid-evening in Ohio.
 */

import { supabase } from './supabase'

const MS_PER_DAY = 86_400_000

/** Where the campaign stands against its own deadline.
 *  - `met`      goal reached; nothing left to need
 *  - `passed`   deadline gone, goal not reached
 *  - `ahead`    recent rate covers what's still needed per day
 *  - `behind`   it doesn't */
export type PaceStatus = 'met' | 'passed' | 'ahead' | 'behind'

export interface CampaignPace {
  /** Calendar days left INCLUDING today — today is still a day you can knock.
   *  0 or less means the deadline has gone by. */
  daysLeft: number
  /** Signatures still to collect. Never negative. */
  remaining: number
  /** Signatures per day needed from here. 0 once the goal is met, and 0 once
   *  the deadline is gone — a rate is meaningless without days to spread it
   *  over, so callers show `remaining` instead. */
  perDayNeeded: number
  /** What the campaign has actually been averaging, from the last 7 days. */
  recentPerDay: number
  status: PaceStatus
}

/** Everything the pace line needs. Campaign name rides along for callers that
 *  aren't already showing it (the activity feed isn't). */
export interface CampaignPaceInput {
  signatures: number
  goal: number | null
  deadline: string | null
  /** Signatures in the last 7 days — `signatures_7d` from get_campaign_stats. */
  signatures7d: number
}

/**
 * Calendar days from today through `deadline`, inclusive.
 *
 * Built from split y/m/d components rather than `new Date('2026-09-12')`,
 * which parses a bare date string as UTC midnight and lands on the wrong day
 * in every US timezone. Both ends are local midnights, so rounding the
 * difference absorbs the 23- and 25-hour days at a DST boundary.
 */
export function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null
  const [y, m, d] = deadline.split('-').map(Number)
  if (!y || !m || !d) return null
  const end = new Date(y, m - 1, d, 0, 0, 0, 0)
  if (Number.isNaN(end.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((end.getTime() - today.getTime()) / MS_PER_DAY) + 1
}

/**
 * The pace, or null when there's nothing to say — a campaign with no goal or
 * no deadline set gets the plain totals it got before this existed, rather
 * than a line full of dashes.
 */
export function campaignPace(input: CampaignPaceInput): CampaignPace | null {
  const { signatures, goal, deadline, signatures7d } = input
  if (!goal || goal <= 0) return null
  const daysLeft = daysUntil(deadline)
  if (daysLeft === null) return null

  const remaining = Math.max(0, goal - signatures)
  const recentPerDay = Math.max(0, signatures7d) / 7
  // A rate needs days to spread over: past the deadline there are none, and
  // with the goal met there's nothing to spread.
  const perDayNeeded = remaining > 0 && daysLeft > 0 ? Math.ceil(remaining / daysLeft) : 0

  let status: PaceStatus
  if (remaining === 0) status = 'met'
  else if (daysLeft <= 0) status = 'passed'
  // Measured against the last 7 days rather than the campaign's lifetime
  // average: a campaign that started slow and found its feet should read as
  // winning, and one that has stalled should stop looking fine.
  else status = recentPerDay >= perDayNeeded ? 'ahead' : 'behind'

  return { daysLeft, remaining, perDayNeeded, recentPerDay, status }
}

/** "48 days left" / "Last day" / "Deadline passed" — state, not explanation. */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'Deadline passed'
  if (daysLeft === 1) return 'Last day'
  return `${daysLeft.toLocaleString()} days left`
}

export const PACE_STATUS_LABELS: Record<PaceStatus, string> = {
  met: 'Goal met',
  passed: 'Deadline passed',
  ahead: 'Ahead',
  behind: 'Behind',
}

/** The theme token each status paints with. Amber for behind rather than red:
 *  behind is a thing to fix with a bigger Saturday, while a missed deadline is
 *  the one state nothing can be done about. */
export const PACE_STATUS_TOKENS: Record<PaceStatus, string> = {
  met: 'var(--success)',
  passed: 'var(--danger)',
  ahead: 'var(--success)',
  behind: 'var(--warning)',
}

/** Shape returned by get_campaign_stats — the columns the pace needs. */
interface StatsRow {
  campaign_id: string
  campaign_name: string
  signatures: number | string
  signatures_7d: number | string
  signature_goal: number | string | null
}

export interface LoadedPace extends CampaignPaceInput {
  campaignId: string
  campaignName: string
}

/** The campaign's deadline, straight off its row. */
export async function fetchDeadline(campaignId: string): Promise<string | null> {
  const { data } = await supabase
    .from('campaigns')
    .select('deadline')
    .eq('id', campaignId)
    .maybeSingle()
  return (data as { deadline: string | null } | null)?.deadline ?? null
}

/**
 * Stats + deadline for the active campaign, for screens that don't already
 * hold them (the activity feed). Two small round trips; screens that have the
 * stats already should call `fetchDeadline` and skip the first.
 *
 * Null when the account isn't on a campaign, or the campaign has no goal —
 * both cases where the caller has no pace line to render anyway.
 */
export async function loadCampaignPace(): Promise<LoadedPace | null> {
  const { data } = await supabase.rpc('get_campaign_stats', { cid: null })
  const row = (data as StatsRow[] | null)?.[0]
  if (!row) return null
  const goal = row.signature_goal == null ? null : Number(row.signature_goal)
  if (!goal) return null
  return {
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    signatures: Number(row.signatures),
    signatures7d: Number(row.signatures_7d),
    goal,
    deadline: await fetchDeadline(row.campaign_id),
  }
}
