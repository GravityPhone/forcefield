/**
 * Sharing where you are with your squad (2026-07-26).
 *
 * FOREGROUND ONLY, and this module is built to say so rather than paper over
 * it. A web app cannot ping from a pocket — iOS suspends a home-screen PWA's
 * JavaScript the moment it isn't on screen, and Chrome freezes a backgrounded
 * page shortly after and immediately on lock. So a dot means "where they were
 * when the app was last open", and everything here is arranged to make that
 * legible: pings carry their own timestamp, `isStale`/`isExpired` are the only
 * way callers are meant to read them, and there is no "sharing" flag anywhere
 * that could claim a closed phone is still reporting.
 *
 * SHAPED FOR NATIVE LATER. The Capacitor shells in this repo can add real
 * background pings with a plugin; when they do, they call `publishPing()`
 * directly with `source: 'native'` and nothing else in this file, on the Squad
 * page, or in the schema has to change. `startSharing`/`stopSharing` own only
 * the web-side timer.
 *
 * The opt-in lives in two places for a reason: the ROW's existence is the
 * server-side truth (stop sharing deletes it, so nothing outlives the app),
 * and the tier is a per-DEVICE preference in localStorage, because it decides
 * what a phone spends its battery on, not what anyone is allowed to see.
 */

import { ref } from 'vue'
import { Geolocation } from '@capacitor/geolocation'
import { supabase } from './supabase'
import { useAuthStore } from '@/stores/auth'

const TIER_KEY = 'forcefield.location_tier'
const SHARING_KEY = 'forcefield.location_sharing'

export type LocationTier = 'saver' | 'balanced' | 'precise'

export interface TierSpec {
  label: string
  /** How often a ping is taken while the app is open and in front. */
  intervalMs: number
  /** GPS vs. coarse network fix — the actual battery lever. */
  highAccuracy: boolean
}

/** Three tiers, because the honest trade here is battery against how closely
 *  a dot tracks somebody walking a street. A canvasser's phone is out most of
 *  the time they're working, so Balanced is the default rather than Saver. */
export const LOCATION_TIERS: Record<LocationTier, TierSpec> = {
  saver: { label: 'Battery saver', intervalMs: 180_000, highAccuracy: false },
  balanced: { label: 'Balanced', intervalMs: 60_000, highAccuracy: false },
  precise: { label: 'Precise', intervalMs: 20_000, highAccuracy: true },
}

/** Dots go pale past this — the phone has probably been in a pocket. */
export const STALE_AFTER_MS = 5 * 60_000
/** Past this a position isn't shown as live at all. Twenty minutes of walking
 *  is a different street; a dot that old is a lie with a timestamp on it. */
export const EXPIRED_AFTER_MS = 20 * 60_000

export interface MemberPing {
  user_id: string
  lat: number
  lng: number
  accuracy_m: number | null
  source: 'web' | 'native'
  updated_at: string
}

/** Am I sharing right now (this device, this session). */
export const sharing = ref(false)
export const tier = ref<LocationTier>(readTier())
/** Last error worth showing — a denied permission is the common one, and it
 *  has to surface or the switch just silently doesn't work. */
export const shareError = ref('')

function readTier(): LocationTier {
  const raw = localStorage.getItem(TIER_KEY)
  return raw === 'saver' || raw === 'balanced' || raw === 'precise' ? raw : 'balanced'
}

export function ageMs(ping: { updated_at: string }): number {
  return Date.now() - new Date(ping.updated_at).getTime()
}

export function isStale(ping: { updated_at: string }): boolean {
  return ageMs(ping) > STALE_AFTER_MS
}

export function isExpired(ping: { updated_at: string }): boolean {
  return ageMs(ping) > EXPIRED_AFTER_MS
}

/** "just now" / "4 min ago" / "1 hr ago" — a dot without this is a claim. */
export function lastSeenLabel(ping: { updated_at: string }): string {
  const mins = Math.floor(ageMs(ping) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
}

/**
 * Write one position. THIS is the seam a native background plugin plugs into:
 * call it with `source: 'native'` on whatever schedule the OS allows and
 * everything downstream — RLS, realtime, the Squad map, staleness — already
 * works.
 */
export async function publishPing(
  coords: { lat: number; lng: number; accuracy?: number | null },
  source: 'web' | 'native' = 'web',
): Promise<{ error?: string }> {
  const me = useAuthStore().profile?.id
  if (!me) return { error: 'Not signed in' }
  const { error } = await supabase.from('member_locations').upsert(
    {
      user_id: me,
      lat: coords.lat,
      lng: coords.lng,
      accuracy_m: coords.accuracy ?? null,
      source,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  return error ? { error: error.message } : {}
}

let timer: ReturnType<typeof setInterval> | undefined

async function pingOnce(): Promise<boolean> {
  const spec = LOCATION_TIERS[tier.value]
  try {
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: spec.highAccuracy,
      timeout: 15_000,
      // Re-using a fix from within the interval is free and is the whole
      // point of the saver tier.
      maximumAge: Math.floor(spec.intervalMs / 2),
    })
    const res = await publishPing({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    })
    if (res.error) {
      shareError.value = 'Couldn’t send your location.'
      return false
    }
    shareError.value = ''
    return true
  } catch {
    // Denied, unavailable, or timed out. On a LAN IP this is also just "not a
    // secure context" — the browser blocks geolocation outright there.
    shareError.value = 'Location unavailable. Check the permission.'
    return false
  }
}

function schedule() {
  clearInterval(timer)
  timer = setInterval(() => void pingOnce(), LOCATION_TIERS[tier.value].intervalMs)
}

/** Start sharing from THIS device. Pings while the app is open; the browser
 *  stops us the moment it isn't, which is the honest limit of the web build. */
export async function startSharing(): Promise<boolean> {
  shareError.value = ''
  const ok = await pingOnce()
  if (!ok) {
    sharing.value = false
    localStorage.removeItem(SHARING_KEY)
    return false
  }
  sharing.value = true
  localStorage.setItem(SHARING_KEY, 'on')
  schedule()
  return true
}

/** Stop, and REMOVE the row — no row is how "not sharing" is represented, so
 *  a stale dot can never outlive the decision to stop. */
export async function stopSharing(): Promise<void> {
  clearInterval(timer)
  timer = undefined
  sharing.value = false
  localStorage.removeItem(SHARING_KEY)
  shareError.value = ''
  const me = useAuthStore().profile?.id
  if (me) await supabase.from('member_locations').delete().eq('user_id', me)
}

export function setTier(next: LocationTier): void {
  tier.value = next
  localStorage.setItem(TIER_KEY, next)
  if (sharing.value) schedule()
}

/** Was this device sharing when it was last open? Used to offer resumption —
 *  never to resume silently, because a location switch that turns itself back
 *  on is exactly the behaviour nobody wants. */
export function wasSharing(): boolean {
  return localStorage.getItem(SHARING_KEY) === 'on'
}

/** Current positions for a set of squadmates. Expired ones are dropped here
 *  rather than by the caller, so no map can accidentally paint one. */
export async function fetchSquadPings(userIds: string[]): Promise<Map<string, MemberPing>> {
  const out = new Map<string, MemberPing>()
  if (!userIds.length) return out
  const { data } = await supabase
    .from('member_locations')
    .select('*')
    .in('user_id', userIds)
  for (const row of (data ?? []) as MemberPing[]) {
    if (!isExpired(row)) out.set(row.user_id, row)
  }
  return out
}
