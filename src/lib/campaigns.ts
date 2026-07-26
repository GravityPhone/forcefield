/**
 * Campaign membership (2026-07-26) — the one campaign you're working, and
 * every campaign you've joined.
 *
 * Before this, "which campaign am I on" was derived through the team
 * (profiles.team_id → teams.campaign_id), so it was never a choice. Now it's
 * a join: `campaign_members` is the roster, `profiles.campaign_id` is the one
 * you're currently working, and a signed-in account with neither is sent to
 * the chooser before it can reach any screen (see the router gate).
 *
 * A module singleton rather than a Pinia store, matching lib/appointments.ts
 * and lib/myTurf.ts: the chooser, the Campaign screen and the router gate all
 * need the same answer and none of them owns it. The active campaign itself
 * lives on the profile in the auth store — the source of truth for it is the
 * session's own row, not a copy kept here.
 */

import { ref } from 'vue'
import { supabase, fetchAllRows } from './supabase'
import { useAuthStore } from '@/stores/auth'
import type { Campaign } from '@/types'

/** A campaign plus the numbers worth seeing while choosing one. */
export interface CampaignOption extends Campaign {
  /** How many people have joined — the "is anyone actually on this" signal. */
  members: number
}

/** Every campaign still running, newest last. Loaded on demand. */
export const campaignOptions = ref<CampaignOption[]>([])
/** Campaign ids the signed-in user has joined. */
export const myCampaignIds = ref<Set<string>>(new Set())
export const campaignsLoading = ref(false)

/** Whose memberships are in the refs above. Logging out and back in as
 * somebody else never reloads the page, so a plain `loaded` flag would show
 * the previous account's campaigns on /campaign. */
let loadedFor: string | null = null

/** Campaigns you've joined, in the order they're listed. */
export function myCampaigns(): CampaignOption[] {
  return campaignOptions.value.filter((c) => myCampaignIds.value.has(c.id))
}

export function campaignById(id: string | null | undefined): CampaignOption | null {
  if (!id) return null
  return campaignOptions.value.find((c) => c.id === id) ?? null
}

/** Load the open campaigns and my memberships. `force` re-reads after a join. */
export async function loadCampaigns(force = false): Promise<void> {
  const uid = useAuthStore().profile?.id ?? null
  if (loadedFor === uid && !force) return
  campaignsLoading.value = true
  try {
    const [list, mine, rosters] = await Promise.all([
      supabase.from('campaigns').select('*').eq('is_active', true).order('created_at'),
      uid
        ? supabase.from('campaign_members').select('campaign_id').eq('user_id', uid)
        : Promise.resolve({ data: [] as { campaign_id: string }[] }),
      // Whole-set read, so it pages (PostgREST caps every response at 1000).
      fetchAllRows<{ campaign_id: string }>((from, to) =>
        supabase
          .from('campaign_members')
          .select('campaign_id')
          .order('campaign_id')
          .order('user_id')
          .range(from, to),
      ).catch(() => [] as { campaign_id: string }[]),
    ])

    const counts = new Map<string, number>()
    for (const row of rosters) counts.set(row.campaign_id, (counts.get(row.campaign_id) ?? 0) + 1)

    campaignOptions.value = ((list.data ?? []) as Campaign[]).map((c) => ({
      ...c,
      members: counts.get(c.id) ?? 0,
    }))
    myCampaignIds.value = new Set((mine.data ?? []).map((r) => r.campaign_id))
    loadedFor = uid
  } finally {
    campaignsLoading.value = false
  }
}

/** Join a campaign and make it the active one. Idempotent server-side, so
 * this doubles as "switch back to one I'm already on". */
export async function joinCampaign(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('join_campaign', { target_campaign_id: id })
  // The Postgres messages here are written to be read by a canvasser
  // ("That campaign is closed"), so they surface verbatim.
  if (error) return { error: error.message }
  myCampaignIds.value = new Set([...myCampaignIds.value, id])
  await useAuthStore().fetchProfile()
  void loadCampaigns(true)
  return {}
}

/** Switch to a campaign already joined. */
export async function switchCampaign(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('set_active_campaign', { target_campaign_id: id })
  if (error) return { error: error.message }
  await useAuthStore().fetchProfile()
  return {}
}
