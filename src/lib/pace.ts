/**
 * Campaign pace (2026-07-26) — how long the campaign has left, next to how
 * far along it is.
 *
 * It shipped that morning as a RATE: signatures a day needed from here, plus
 * an ahead/behind verdict measured against the last seven days. Both are gone
 * by the afternoon (user call) — "we don't actually need the number of
 * signatures a day, and we don't need the thing that says behind. You can
 * just say forty nine days left and show how many out of how many signatures
 * we have." Nobody standing at a door can act on a derived rate, and a verdict
 * chip on every screen is a mood rather than information. What's left is the
 * two facts that need no interpreting: days left, and signatures of the goal.
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

/** What the pace line needs. A campaign missing either half gets the plain
 *  totals it got before this existed, rather than a line full of dashes. */
export interface CampaignPaceInput {
  signatures: number
  goal: number | null
  deadline: string | null
}

/**
 * Calendar days from today through `deadline`, inclusive — today is still a
 * day you can knock, so a deadline of today is 1 and yesterday is 0. Null
 * when there's no deadline set.
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

/** "48 days left" / "Last day" / "Deadline passed" — state, not explanation. */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'Deadline passed'
  if (daysLeft === 1) return 'Last day'
  return `${daysLeft.toLocaleString()} days left`
}

/** Shape returned by get_campaign_stats — the columns the pace needs. */
interface StatsRow {
  campaign_id: string
  campaign_name: string
  signatures: number | string
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
    goal,
    deadline: await fetchDeadline(row.campaign_id),
  }
}
