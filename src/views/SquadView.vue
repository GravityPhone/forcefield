<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import AddMembersSheet from '@/components/squads/AddMembersSheet.vue'
import { fadeUp } from '@/lib/motion'
import { startOfLocalDayISO } from '@/lib/day'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { attachPoiTapGuard, loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  readMapPref,
  readPinMode,
  readTurfShadeMode,
  writeMapPref,
  writePinMode,
  writeTurfShadeMode,
} from '@/lib/mapLayers'
import type { PinMode, TurfShadeMode } from '@/lib/mapLayers'
import { DoorCanvasLayer, PINS_MIN_ZOOM } from '@/lib/doorCanvas'
import type { CanvasDoor, DoorBadge, DoorPaintState } from '@/lib/doorCanvas'
import { createBadgeFactory } from '@/lib/doorBadges'
import { attachMapScrollGuard } from '@/lib/mapScroll'
import type { MapScrollGuard } from '@/lib/mapScroll'
import { afterScrollUnlock, keepInSafeView, scrollIntoSafeView } from '@/lib/appChrome'
import {
  OUTCOME_HEX,
  OUTCOME_SHORT,
  PIN_DEFAULT_HEX,
  doorPaint,
  doorPartlySigned,
  doorStatusOutcome,
  outcomeRowTint,
} from '@/lib/outcomes'
import OutcomeSquare from '@/components/canvass/OutcomeSquare.vue'
import { avatarUrl } from '@/lib/avatars'
import {
  fetchSquadPings,
  isExpired,
  isStale,
  lastSeenLabel,
  LOCATION_TIERS,
  setTier,
  sharing,
  shareError,
  startSharing,
  stopSharing,
  tier,
  type LocationTier,
  type MemberPing,
} from '@/lib/presence'
import { inkOn, memberColor } from '@/lib/memberColors'
import { telHref } from '@/lib/phone'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useSquadsStore, type SquadListItem } from '@/stores/squads'
import { useTalkStore } from '@/stores/talk'
import { ROLE_LABELS } from '@/types'
import type { ChatProfile, HouseholdLatestKnock, KnockLog, KnockOutcome } from '@/types'

// Fallback map center: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }

// Zoom thresholds and the tap radius are shared with Scout and the turf
// cutter — see src/lib/doorCanvas.ts, which is also where every door on all
// three maps is actually painted.

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const chat = useChatStore()
const squads = useSquadsStore()
const talk = useTalkStore()

// --- Which squad is "mine" ---
//
// ONE squad per person (2026-07-25, user call): "every person can only be in
// one squad, but they can leave and make new squads and join squads at will."
// So there's no picking to do — this page is simply your crew. The old
// multi-squad switcher and its ?squad= override are gone.
//
// ?squad= is still ACCEPTED, because a campaign manager opening a crew from
// /squads is a real path and a CM may be looking at a squad that isn't
// theirs. It just no longer arbitrates between several of your own.
const selectedSquadId = ref<string | null>(
  typeof route.query.squad === 'string' ? route.query.squad : null,
)
const mySquad = computed<SquadListItem | null>(() => {
  const mine = squads.mySquads
  return mine.find((s) => s.id === selectedSquadId.value) ?? mine[0] ?? null
})

// --- Dashboard data ---

interface TurfLite {
  id: string
  name: string
  color: string
  squad_id: string | null
  assignee_id: string | null
  parent_turf_id: string | null
}

interface TurfDoor {
  id: string
  street: string
  unit: string | null
  city: string
  zip: string | null
  lat: number | null
  lng: number | null
  turf_id: string
}

interface RecentDoor {
  addressId: string
  street: string
  lat: number | null
  lng: number | null
  occurredAt: string
}

const squadTurfs = ref<TurfLite[]>([])
const turfDoors = ref<Map<string, TurfDoor>>(new Map())
/** Distinct turf doors with at least one knock (any time, any member). */
const knockedDoors = ref<Set<string>>(new Set())
/** member id -> distinct turf doors that member has knocked. */
const knockedByMember = ref<Map<string, Set<string>>>(new Map())
/** member id -> their latest knocked doors, newest first, deduped, max 5. */
const recentByMember = ref<Map<string, RecentDoor[]>>(new Map())

// --- Live location: where squadmates are RIGHT NOW, when they're sharing ---
//
// Foreground-only on the web (see lib/presence.ts) — a dot is "where they were
// when the app was last open", so it dims when stale and disappears when
// expired rather than quietly going on claiming a position.
const pingsByMember = ref<Map<string, MemberPing>>(new Map())
/** Repaints the pins on a clock so staleness ages on its own — the markers
 *  are updated imperatively, so there's nothing reactive to tick here. */
let presenceTimer: ReturnType<typeof setInterval> | undefined
let presenceFeed: RealtimeChannel | null = null
/** door id -> latest-knock status row (outcome + signed/person counts) —
 * the door pins wear the same doorStatusOutcome colors as the Scout map. */
const statusByDoor = ref<Map<string, HouseholdLatestKnock>>(new Map())
/** door id -> who knocked it most recently TODAY (`at` = epoch ms). Doors a
 * squad member knocked today wear that member's animal avatar on the map —
 * the "who's covered what so far" layer. Non-member knockers can land here
 * too (turf is shared); they simply have no avatar to show. */
const todayKnockerByDoor = ref<Map<string, { canvasserId: string; at: number }>>(new Map())
const selectedMemberId = ref<string | null>(null)
const dashboardLoading = ref(false)

const memberIdSet = computed(() => new Set(mySquad.value?.members.map((m) => m.id) ?? []))
const memberById = computed(
  () => new Map((mySquad.value?.members ?? []).map((m) => [m.id, m])),
)
const turfIdSet = computed(() => new Set(squadTurfs.value.map((t) => t.id)))

/** Yourself first, then everyone else alphabetically — your own card is the
 * one you check most. */
const orderedMembers = computed<ChatProfile[]>(() => {
  const me = auth.profile?.id
  const members = [...(mySquad.value?.members ?? [])]
  members.sort((a, b) => {
    if (a.id === me) return -1
    if (b.id === me) return 1
    return (a.display_name || a.username).localeCompare(b.display_name || b.username)
  })
  return members
})

const doorsTotal = computed(() => turfDoors.value.size)
/** How far along the crew is — TODAY by default (2026-07-25, user call). A
 * squad lasts one day and its turf is meant to be walked in one, so the
 * number that answers "how are we doing" has to reset at midnight the way the
 * crew does; an all-time count only ever climbs and would read as progress
 * nobody made this morning. `todayKnockerByDoor` is already the day's
 * distinct turf doors (any knocker, kept live by the realtime feed), so
 * today's number costs nothing extra. "All time" stays one tap away — it
 * answers the different question of whether any door has never been reached.
 * (The rundown below is always the door's CURRENT state, which is cumulative
 * by nature — that's what its colors mean everywhere else in the app.) */
const progressScope = ref<'today' | 'all'>('today')
const doorsKnockedToday = computed(() => todayKnockerByDoor.value.size)
const doorsKnocked = computed(() =>
  progressScope.value === 'today' ? doorsKnockedToday.value : knockedDoors.value.size,
)

// Splitting the squad's turf among members is a leader's / manager's job —
// with two ways it can fall to the canvassers instead, both mirrored in the
// DB's can_member_subcut: nobody on the crew outranks a canvasser today, or
// the leader deliberately handed claiming to the crew for the day
// (squads.member_claim, the "Crew claims their own doors" switch below —
// "there's a leader, but it's chaotic out there and I'd rather people grab
// their own stretch than wait on me"). It happens right here on the squad
// map: pick a member, sweep doors, save — a sub-turf assigned to them.
const squadHasRankedMember = computed(() =>
  (mySquad.value?.members ?? []).some((m) => m.role != null && m.role !== 'canvasser'),
)
const memberClaimOn = computed(() => mySquad.value?.member_claim ?? false)
/** Who may flip that switch: managers, a squad leader on the crew, or
 * whoever started it. Same gate the set_squad_member_claim RPC enforces. */
const canToggleClaim = computed(() => {
  const squad = mySquad.value
  if (!squad) return false
  const role = auth.profile?.role
  if (role === 'admin' || role === 'campaign_manager' || role === 'team_lead') return true
  return squad.created_by === auth.profile?.id
})
const claimSaving = ref(false)

// --- Who's on the crew (2026-07-25, user asks): a campaign manager assigns
// people to squads from here, and a squad leader adds someone to their own
// crew as long as that person isn't already out with another one. Same gate as
// the claim switch and as the add_squad_member RPC — manager, a squad leader
// on this crew, or whoever started it. ---
const isManagerRole = computed(
  () => auth.profile?.role === 'admin' || auth.profile?.role === 'campaign_manager',
)
const canManageRoster = computed(() => {
  const squad = mySquad.value
  if (!squad) return false
  if (isManagerRole.value) return true
  if (squad.created_by === auth.profile?.id) return true
  return auth.profile?.role === 'team_lead' && memberIdSet.value.has(auth.profile.id)
})
const addMembersOpen = ref(false)
const removingMemberId = ref<string | null>(null)

async function removeFromSquad(memberId: string) {
  const squad = mySquad.value
  if (!squad || removingMemberId.value) return
  removingMemberId.value = memberId
  const reason = await squads.removeMember(squad.id, memberId)
  removingMemberId.value = null
  if (reason) {
    squads.actionError = reason
    return
  }
  sheetMemberId.value = null
}

async function toggleMemberClaim() {
  const squad = mySquad.value
  if (!squad || claimSaving.value) return
  claimSaving.value = true
  await squads.setMemberClaim(squad.id, !squad.member_claim)
  claimSaving.value = false
}
/** Top-level squad turfs the current user may divide, mirroring the DB's
 * can_lead_subcut / can_member_subcut so the UI offers exactly what the
 * set_turf_segments RPC will accept. */
const assignableParentIds = computed<Set<string>>(() => {
  const role = auth.profile?.role
  const me = auth.profile?.id
  const squadId = mySquad.value?.id
  const out = new Set<string>()
  for (const t of squadTurfs.value) {
    if (t.parent_turf_id) continue
    if (role === 'campaign_manager' || role === 'admin') out.add(t.id)
    else if (role === 'team_lead') {
      if (t.assignee_id === me || (t.squad_id !== null && t.squad_id === squadId)) out.add(t.id)
    } else if (
      (!squadHasRankedMember.value || memberClaimOn.value) &&
      t.squad_id !== null &&
      t.squad_id === squadId
    ) {
      out.add(t.id)
    }
  }
  return out
})
const canAssign = computed(() => assignableParentIds.value.size > 0)
/** A plain canvasser cutting under the leader's switch picks doors for
 * THEMSELVES — that's what the leader handed out. (The leaderless fallback is
 * unchanged: with nobody to do the dividing, any member may hand doors to
 * anyone.) The DB gate is squad-scoped either way, so this is the product
 * rule, not the security boundary. */
const claimSelfOnly = computed(
  () =>
    auth.profile?.role === 'canvasser' && squadHasRankedMember.value && memberClaimOn.value,
)
function canAssignTo(memberId: string): boolean {
  if (!canAssign.value) return false
  return !claimSelfOnly.value || memberId === auth.profile?.id
}
/** "Claim mine" when you're picking for yourself, "Assign" when you're
 * handing them out. Short on purpose — it's a button on a square tile. */
function assignVerb(memberId: string): string {
  return memberId === auth.profile?.id && claimSelfOnly.value ? 'Claim mine' : 'Assign'
}
const progressPct = computed(() =>
  doorsTotal.value ? Math.round((doorsKnocked.value / doorsTotal.value) * 100) : 0,
)

/** "Our doors": the crew's whole assignment counted out by what happened at
 * each one, in the same colors the map paints (2026-07-25, user call). The
 * progress bar says how much is done; this says how it went. Derived from
 * the door statuses already loaded — no fetch, and it moves with live
 * knocks like everything else on the page.
 *
 * Buckets follow doorStatusOutcome exactly, so a row can never disagree with
 * the pins: partly-signed is its own line (green with a yellow band on the
 * map, and the one state a single color can't say), and the three reds keep
 * their own labels — to a canvasser they all mean "don't come back", but
 * "hostile" and "skip" are different things to plan around. */
const rundownOpen = ref(false)

interface RundownRow {
  key: string
  label: string
  color: string
  band: string | null
  count: number
}

const doorRundown = computed<RundownRow[]>(() => {
  const counts = new Map<string, number>()
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const id of turfDoors.value.keys()) {
    const s = statusByDoor.value.get(id)
    if (!s) {
      bump('todo')
      continue
    }
    if (doorPartlySigned(s.outcome, s.signed_count, s.person_count)) {
      bump('partly')
      continue
    }
    const eff = doorStatusOutcome(s.outcome, s.signed_count, s.person_count)
    bump(eff ?? 'todo')
  }
  const rows: RundownRow[] = [
    { key: 'signed', label: 'Everyone signed', color: OUTCOME_HEX.signed, band: null, count: 0 },
    { key: 'partly', label: 'Partly signed', color: OUTCOME_HEX.signed, band: OUTCOME_HEX.maybe, count: 0 },
    { key: 'maybe', label: OUTCOME_SHORT.maybe, color: OUTCOME_HEX.maybe, band: null, count: 0 },
    { key: 'not_home', label: OUTCOME_SHORT.not_home, color: OUTCOME_HEX.not_home, band: null, count: 0 },
    { key: 'didnt_sign', label: OUTCOME_SHORT.didnt_sign, color: OUTCOME_HEX.didnt_sign, band: null, count: 0 },
    { key: 'skip', label: OUTCOME_SHORT.skip, color: OUTCOME_HEX.skip, band: null, count: 0 },
    { key: 'hostile', label: OUTCOME_SHORT.hostile, color: OUTCOME_HEX.hostile, band: null, count: 0 },
    { key: 'todo', label: 'Not knocked yet', color: PIN_DEFAULT_HEX, band: null, count: 0 },
  ]
  return rows
    .map((r) => ({ ...r, count: counts.get(r.key) ?? 0 }))
    .filter((r) => r.count > 0)
})

function rundownPct(count: number): number {
  return doorsTotal.value ? Math.round((count / doorsTotal.value) * 100) : 0
}

/** Guards against an older async load landing after a newer one. */
let loadSeq = 0

/** Latest-knock status rows for the squad's doors. The view has no turf
 * column to filter on server-side, so this chunks .in() over door ids —
 * scoped to the turf (vs pulling the org-wide view like Scout must) while
 * staying clear of URL-length limits. Best-effort like the other fetches. */
const STATUS_CHUNK = 150
async function fetchDoorStatuses(doorIds: string[]): Promise<HouseholdLatestKnock[]> {
  const chunks: string[][] = []
  for (let i = 0; i < doorIds.length; i += STATUS_CHUNK) {
    chunks.push(doorIds.slice(i, i + STATUS_CHUNK))
  }
  const results = await Promise.all(
    chunks.map(async (ids) => {
      const { data } = await supabase
        .from('household_latest_knock')
        .select('*')
        .in('household_id', ids)
      return (data ?? []) as HouseholdLatestKnock[]
    }),
  )
  return results.flat()
}

async function loadDashboard() {
  const squad = mySquad.value
  if (!squad) return
  const seq = ++loadSeq
  dashboardLoading.value = true
  const memberIds = squad.members.map((m) => m.id)

  // Squad turf = dispatched to this squad, or to a member directly — same
  // "your crew's assignment" definition the Hunt map opens framed on.
  // Top-level turf only: sub-turfs ride in via their parent below, so
  // splitting the turf never makes doors disappear from the squad's progress
  // — but yesterday's "<name>'s doors" splits (sub-turfs assigned to members
  // under some OTHER crew's turf) can't follow people into today's squad.
  const { data: turfData } = await supabase
    .from('turfs')
    .select('id, name, color, squad_id, assignee_id, parent_turf_id')
  const all = (turfData ?? []) as TurfLite[]
  const direct = all.filter(
    (t) =>
      !t.parent_turf_id &&
      (t.squad_id === squad.id ||
        (t.assignee_id !== null && memberIds.includes(t.assignee_id))),
  )
  const directIds = new Set(direct.map((t) => t.id))
  const mine = [
    ...direct,
    ...all.filter(
      (t) => t.parent_turf_id !== null && directIds.has(t.parent_turf_id) && !directIds.has(t.id),
    ),
  ]
  const turfIds = mine.map((t) => t.id)

  // Both "whole set" queries page past PostgREST's 1000-row response cap
  // (a plain .limit() above that silently truncates). Best-effort: a failed
  // page just means fewer doors/knocks this refresh, same as before.
  const [doorsData, knocksData, ...recentRes] = await Promise.all([
    turfIds.length
      ? fetchAllRows<TurfDoor>((from, to) =>
          supabase
            .from('addresses')
            .select('id, street, unit, city, zip, lat, lng, turf_id')
            .in('turf_id', turfIds)
            .order('id')
            .range(from, to),
        ).catch(() => [] as TurfDoor[])
      : Promise.resolve([] as TurfDoor[]),
    turfIds.length
      ? fetchAllRows<{ household_id: string; canvasser_id: string; occurred_at: string }>(
          (from, to) =>
            supabase
              .from('knock_logs')
              .select('household_id, canvasser_id, occurred_at, addresses!inner(turf_id)')
              .in('addresses.turf_id', turfIds)
              .not('household_id', 'is', null)
              .order('id')
              .range(from, to),
        ).catch(() => [] as { household_id: string; canvasser_id: string; occurred_at: string }[])
      : Promise.resolve([] as { household_id: string; canvasser_id: string; occurred_at: string }[]),
    // Last doors each member touched TODAY — anywhere, not just in turf, so
    // the card answers "where are they right now". Today-only on purpose
    // (2026-07-24, user call): a squad is one day long, so yesterday's doors
    // on a card read as activity that isn't happening. Overfetch then dedupe
    // (re-knocking the same door shouldn't eat the whole list).
    ...memberIds.map((id) =>
      supabase
        .from('knock_logs')
        .select('occurred_at, addresses!inner(id, street, lat, lng)')
        .eq('canvasser_id', id)
        .gte('occurred_at', startOfLocalDayISO())
        .order('occurred_at', { ascending: false })
        .limit(15),
    ),
  ])
  const statusRows = await fetchDoorStatuses(doorsData.map((d) => d.id)).catch(
    () => [] as HouseholdLatestKnock[],
  )
  if (seq !== loadSeq) return

  squadTurfs.value = mine
  allTurfList.value = all
  turfDoors.value = new Map(doorsData.map((d) => [d.id, d]))
  statusByDoor.value = new Map(statusRows.map((r) => [r.household_id, r]))

  const knocked = new Set<string>()
  const byMember = new Map<string, Set<string>>()
  // Epoch-ms compare, not ISO-string compare — PostgREST's timestamptz
  // formatting (+00:00, varying precision) doesn't sort lexicographically
  // against Date.toISOString().
  const dayStart = new Date().setHours(0, 0, 0, 0)
  const todayBy = new Map<string, { canvasserId: string; at: number }>()
  for (const row of knocksData) {
    knocked.add(row.household_id)
    if (memberIds.includes(row.canvasser_id)) {
      let set = byMember.get(row.canvasser_id)
      if (!set) byMember.set(row.canvasser_id, (set = new Set()))
      set.add(row.household_id)
    }
    const at = Date.parse(row.occurred_at)
    if (at >= dayStart) {
      const prev = todayBy.get(row.household_id)
      if (!prev || prev.at < at) {
        todayBy.set(row.household_id, { canvasserId: row.canvasser_id, at })
      }
    }
  }
  knockedDoors.value = knocked
  knockedByMember.value = byMember
  todayKnockerByDoor.value = todayBy

  const recents = new Map<string, RecentDoor[]>()
  memberIds.forEach((id, i) => {
    type Row = { occurred_at: string; addresses: { id: string; street: string; lat: number | null; lng: number | null } }
    const rows = ((recentRes[i]?.data ?? []) as unknown as Row[])
    const seen = new Set<string>()
    const list: RecentDoor[] = []
    for (const r of rows) {
      if (seen.has(r.addresses.id)) continue
      seen.add(r.addresses.id)
      list.push({
        addressId: r.addresses.id,
        street: r.addresses.street,
        lat: r.addresses.lat,
        lng: r.addresses.lng,
        occurredAt: r.occurred_at,
      })
      if (list.length === 5) break
    }
    recents.set(id, list)
  })
  recentByMember.value = recents
  dashboardLoading.value = false
  applyMapData(true)
}

// --- Map ---

const mapEl = ref<HTMLElement | null>(null)
const mapCardEl = ref<HTMLElement | null>(null)
let map: google.maps.Map | null = null
const markersByMember = new Map<string, google.maps.marker.AdvancedMarkerElement>()
/** Every turf door paints on ONE canvas — the shared renderer Scout and the
 * turf cutter use (src/lib/doorCanvas.ts). The old per-door AdvancedMarkers
 * plus a MarkerClusterer are gone: clustering only ever existed to keep the
 * DOM marker count survivable, and there are no DOM markers now. Member
 * avatars stay real markers — there are at most a handful of them. */
let doorLayer: DoorCanvasLayer | null = null
const mapFailed = ref(false)
const pinMode = ref<PinMode>(readPinMode('squad-pin-mode', 'numbers'))

function setPinMode(mode: PinMode) {
  if (pinMode.value === mode) return
  pinMode.value = mode
  writePinMode('squad-pin-mode', mode)
  doorLayer?.requestRepaint()
}

// Turf colors for painting come from anyTurfColorById (built off allTurfList,
// so "All turf" can ring other crews' doors in their own colors too).
const turfById = computed(() => new Map(squadTurfs.value.map((t) => [t.id, t])))

let mapInitBusy = false

async function initMap() {
  if (mapInitBusy) return
  mapInitBusy = true
  try {
    await loadMaps()
  } catch {
    mapFailed.value = true
    mapInitBusy = false
    return
  }
  const el = mapEl.value
  // No element (squad state changed while the API loaded) or this element is
  // already live — nothing to do. Leaving and rejoining a squad remounts the
  // div, so "already have a map" isn't enough: it must be THIS div's map.
  if (!el || (map && map.getDiv() === el)) {
    mapInitBusy = false
    return
  }
  doorLayer?.dispose()
  doorLayer = null
  for (const marker of markersByMember.values()) marker.map = null
  markersByMember.clear()
  map = new google.maps.Map(el, {
    center: FALLBACK_CENTER,
    zoom: 13,
    // mapId — required for the member AdvancedMarker avatar pins and the
    // cloud style (doors are canvas, and don't need it).
    mapId: GOOGLE_MAPS_MAP_ID,
    renderingType: MAP_RENDERING_TYPE,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
  })
  attachPoiTapGuard(map)
  doorLayer = new DoorCanvasLayer(map, {
    pinMode: () => pinMode.value,
    paintFor: paintForDoor,
  })
  map.addListener('click', (e: google.maps.MapMouseEvent) => onMapClick(e))
  // Settled pan/zoom: the canvas repaints only if the view outgrew its
  // painted box or landed on a new zoom — nothing per-frame.
  map.addListener('idle', () => doorLayer?.checkView())
  applyMapData(true)
}

/** Push current turf + member data onto the map (idempotent — safe to call
 * whenever either the map or the data finishes loading first). */
function applyMapData(refit = false) {
  if (!map) return

  // The campaign-wide door set, pulled once behind the crew's own doors: with
  // no layer switched on this map shows EVERY door on plain status colors
  // (2026-07-25, user call — the same rule as Scout), so it can't wait for a
  // toggle any more. Guarded, so repeated applyMapData calls don't refetch,
  // and deliberately not awaited: the crew's ground paints first.
  if (!orgDoorsLoaded) void ensureOrgDoors().then(() => applyDoorPins())
  applyDoorPins()

  // One avatar marker per member, sitting on their last geocoded knock.
  const members = mySquad.value?.members ?? []
  const alive = new Set(members.map((m) => m.id))
  for (const [id, marker] of markersByMember) {
    if (!alive.has(id)) {
      marker.map = null
      markersByMember.delete(id)
    }
  }
  for (const m of members) updateMemberMarker(m)

  // …and their live positions on top, for whoever is sharing. Unawaited: the
  // crew's doors and last-knock pins are the page, this only moves some dots.
  void loadPresence()
  subscribePresence()

  if (refit) fitToSquad()
}

// --- Turf layer: which doors are on the map, and whether they wear their
// turf's color.
//
// Area SHADING is gone (2026-07-24, user call). The shaded polygons could
// visibly overlap wherever two turfs met — turfAreaFor() marks every ~44m
// grid cell within 14m of a door and bridges cells along each street run, so
// turfs facing each other across a street both claim the cells in between,
// and two translucent fills stacked (the "yellow over blue" patch). Doors
// themselves can't overlap: addresses.turf_id is ONE column.
//
// So the map now does what the turf cutter's OVERVIEW does — every door
// keeps its knock-status fill and wears its owning turf's color as the outer
// ring. "Our turf" FILTERS to the crew's doors; "All turf" colors every turf's
// doors in its own color; with neither on you get every door in the county on
// plain status pins. Its OWN pref key, since only this map has to fetch the
// campaign-wide set. ---

// OFF by default (2026-07-25, user call): nothing toggled = every door,
// regular outcome colors, on every screen in the app. 'doors' is Scout's
// fourth state and this map has no button for it; a value that somehow lands
// under this key reads as the crew's turf rather than a dead button.
const storedShade = readTurfShadeMode('squad-turf-shading', 'off')
const turfShade = ref<TurfShadeMode>(storedShade === 'doors' ? 'mine' : storedShade)
/** Every turf row, unfiltered — "All turf" paints from these. */
const allTurfList = ref<TurfLite[]>([])

interface OrgDoor {
  id: string
  street: string
  lat: number
  lng: number
  /** Null for a door nobody has cut yet — those load too (2026-07-25), so
   * "All turf" shows the campaign's ground as it really is: claimed doors
   * ringed in their turf's color, unclaimed ones on plain status pins. It
   * used to fetch only turf-held doors, which left every uncut street blank
   * and read as "All turf isn't showing me that turf". */
  turf_id: string | null
}
/** Every turf door in the campaign, ours included — only downloaded once
 * "All turf" is switched on. */
const orgDoorsById = ref<Map<string, OrgDoor>>(new Map())
/** Statuses for those doors, kept SEPARATE from statusByDoor: the crew's own
 * statuses are refetched (and replaced wholesale) on every roster reload and
 * kept live by the knock feed, so merging this one-shot snapshot into them
 * would either get clobbered or clobber. paintForDoor falls back to it. */
const orgStatusByDoor = ref<Map<string, HouseholdLatestKnock>>(new Map())
let orgDoorsLoaded = false
let orgDoorsLoading: Promise<void> | null = null
const orgLoading = ref(false)

/** The rest of the campaign's doors. Kicked off in the background on every
 * load now, so `orgLoading` is only raised by the button that WAITS on it —
 * a "Loading…" chip nobody asked for is just noise on arrival. */
async function ensureOrgDoors(): Promise<void> {
  if (orgDoorsLoaded) return
  if (!orgDoorsLoading) {
    orgDoorsLoading = Promise.all([
      fetchAllRows<OrgDoor>((from, to) =>
        supabase
          .from('addresses')
          .select('id, street, lat, lng, turf_id')
          .not('lat', 'is', null)
          .order('id')
          .range(from, to),
      ),
      // Statuses for those doors too — a door painted with no status would
      // read as "nobody's been here", which is a lie about someone else's
      // ground. Same one-shot deal the turf cutter makes.
      fetchAllRows<HouseholdLatestKnock>((from, to) =>
        supabase.from('household_latest_knock').select('*').order('household_id').range(from, to),
      ),
    ])
      .then(([rows, statuses]) => {
        const byId = new Map<string, OrgDoor>()
        for (const r of rows) byId.set(r.id, r)
        orgDoorsById.value = byId
        orgStatusByDoor.value = new Map(statuses.map((s) => [s.household_id, s]))
        orgDoorsLoaded = true
      })
      .catch(() => {
        // Flaky signal — the next toggle retries.
        orgDoorsLoaded = false
      })
      .finally(() => {
        orgDoorsLoading = null
      })
  }
  await orgDoorsLoading
}

/** "Our doors": who on the crew owns which door — the sub-turf assignee's
 * color as the ring, their avatar in the middle. Its own on/off switch
 * (2026-07-25, user call), so it composes with the turf row rather than
 * competing with it: filter to the crew's ground AND see how it's split.
 * Assign mode turns it on for free — dividing turf is exactly when "who has
 * what" is the question.
 *
 * ON by default since 2026-07-25 (user call: "I do [want individual people's
 * doors] on the squad map"): who is walking what is the crew page's subject,
 * not a layer you go looking for. Today's knocker still wins the badge slot,
 * so this only ever fills in doors nobody has reached yet. */
const ownerLayer = ref(readMapPref('squad-owner-layer', true))

function toggleOwnerLayer() {
  ownerLayer.value = !ownerLayer.value
  writeMapPref('squad-owner-layer', ownerLayer.value)
}

/** Owner of a door = whoever the turf holding it is assigned to (a sub-turf
 * from "Assign doors", or a top-level turf handed to one canvasser). */
function ownerOf(turfId: string | null): ChatProfile | null {
  if (!turfId) return null
  const assignee = turfById.value.get(turfId)?.assignee_id
  return assignee ? (memberById.value.get(assignee) ?? null) : null
}

async function setTurfShade(mode: 'mine' | 'all') {
  turfShade.value = turfShade.value === mode ? 'off' : mode
  writeTurfShadeMode('squad-turf-shading', turfShade.value)
  // "All turf" is the one reading that's wrong until the campaign-wide set
  // lands (every other crew's ground unringed), so it's the one that waits
  // on the background fetch and says so.
  if (turfShade.value === 'all' && !orgDoorsLoaded) {
    orgLoading.value = true
    try {
      await ensureOrgDoors()
    } finally {
      orgLoading.value = false
    }
  }
  applyDoorPins()
  // Switching the filter ON takes you to the ground it's filtering to —
  // otherwise "only our turf" can leave you staring at an empty county
  // corner. Only when none of it is on screen already: flicking the layer to
  // check something shouldn't re-frame the map under you (Scout's rule).
  if (turfShade.value === 'mine' && !ourTurfInView()) focusDoorSet([...turfDoors.value.values()])
}

/** Is any of these doors on screen right now? The rule behind every
 * "don't re-frame a map somebody is already reading" check on this page —
 * Scout's, verbatim. Reads the MAP's viewport, not the page's, so it answers
 * the same whether or not the map card is scrolled into view. */
function anyDoorInView(doors: Iterable<{ lat: number | null; lng: number | null }>): boolean {
  const bounds = map?.getBounds()
  if (!bounds) return false
  for (const d of doors) {
    if (d.lat != null && d.lng != null && bounds.contains({ lat: d.lat, lng: d.lng })) return true
  }
  return false
}

/** Is any of the crew's own turf on screen right now? */
function ourTurfInView(): boolean {
  return anyDoorInView(turfDoors.value.values())
}

/** Turf color by id across the WHOLE campaign, not just the crew's turfs —
 * "All turf" rings other crews' doors in their own colors. */
const anyTurfColorById = computed(() => new Map(allTurfList.value.map((t) => [t.id, t.color])))

/** Today-knocker avatars, from the shared badge factory every map uses
 * (src/lib/doorBadges.ts). Images decode async — the canvas repaints when one
 * lands; until then the door shows the member's initial on their own color. */
const { badgeFor } = createBadgeFactory(() => doorLayer?.requestRepaint())

/** Paint state for one door — the Squad reading of the shared three-band
 * model (halo / membership ring / status fill). The fill NEVER stops meaning
 * "what happened here"; the layers only ever change the ring and the badge,
 * so no switch can cost you the progress reading (2026-07-25, user call).
 *
 * fill  = the door's knock STATUS, the exact colors Scout and the cutter use
 *         (doorPaint: green only when everyone signed, green+yellow
 *         band partly signed, red closed-no, blue untouched).
 * ring  = whose it is. "Our doors" wins it when the door belongs to somebody
 *         on the crew (their own accent, the same color as their card and
 *         their name in chat); otherwise "All turf" rings it in its turf's
 *         color. A door can only be in one turf, so rings can't overlap the
 *         way the old shaded polygons did.
 * badge = the face in the middle: whoever knocked this door TODAY, and — with
 *         "Our doors" on — its owner when nobody has been yet. Today's
 *         knocker wins that slot (user call): what just happened outranks
 *         what was planned, and the ring still says whose it is.
 *
 * The turf row is a FILTER, not a coloring: "Our turf" paints ONLY the crew's
 * doors (null = invisible AND untappable in the canvas layer), "All turf"
 * adds the whole campaign's ground. */
function paintForDoor(id: string): DoorPaintState | null {
  const door = turfDoors.value.get(id)
  // Anyone else's ground — there by default, hidden only by the "Our turf"
  // filter. It gets its turf's ring and its real status, but none of the
  // crew's own decoration, and it can never join an assignment.
  const foreign = door ? null : orgDoorsById.value.get(id)
  if (!door && !foreign) return null
  if (!door && turfShade.value === 'mine') return null
  const turfId = door ? door.turf_id : foreign!.turf_id
  const status = statusByDoor.value.get(id) ?? orgStatusByDoor.value.get(id)
  // The shared reading, so a pin can never disagree with the same door's row
  // or its Knock button. doorPaint owns the partly-signed rule: GREEN with a
  // YELLOW band rather than plain yellow — "one of the three signed" is
  // progress with work left, and shouldn't look identical to a door where
  // nobody has signed at all.
  const { fill, band: innerRing } = doorPaint(
    status?.outcome,
    status?.signed_count,
    status?.person_count,
  )
  // "All turf" is the only mode that rings by TURF — the crew's own ground
  // doesn't need coloring to be found once the map is filtered to it.
  const turfColor =
    turfShade.value === 'all' ? (anyTurfColorById.value.get(turfId ?? '') ?? null) : null

  const assignee = assigningMember.value
  if (assignee) {
    // Assign mode shows ONE thing: the turf you're dividing. Everything else
    // — another crew's ground, turf you may not cut — paints nothing at all,
    // so the map is the pile you're picking from and nothing else. Doors
    // already spoken for wear their owner (ring + face) whether or not the
    // layer is switched on: handing out doors is the moment you most need to
    // see what's taken.
    if (!door || poolParentOf(door) === null) return null
    const picked = assignSelected.value.has(id)
    if (picked) {
      return {
        fill: memberColor(assignee),
        ring: '#ffffff',
        emphasis: true,
      }
    }
    const owner = ownerOf(door.turf_id)
    return {
      fill,
      innerRing,
      ring: owner ? memberColor(owner) : null,
      badge: owner ? badgeFor(owner) : null,
      emphasis: false,
    }
  }

  const owner = ownerLayer.value && door ? ownerOf(door.turf_id) : null
  const knocker = todayKnockerByDoor.value.get(id)
  const knockerMember = door && knocker ? memberById.value.get(knocker.canvasserId) : undefined
  const badge: DoorBadge | null = knockerMember
    ? badgeFor(knockerMember)
    : owner
      ? badgeFor(owner)
      : null
  return {
    fill,
    // Coexists with the badge: the avatar owns the pin's middle, so the
    // partly-signed yellow strokes the rim instead of filling a band.
    innerRing,
    ring: owner ? memberColor(owner) : turfColor,
    // Today's covered doors are the map's live story — they draw bigger and
    // above their plain neighbors. Ownership deliberately does NOT emphasize:
    // with the layer on, most doors have an owner, and emphasizing all of
    // them just makes every pin big.
    emphasis: !!knockerMember,
    badge,
  }
}

/** Push doors onto the canvas layer: the crew's own turf, plus every other
 * door in the campaign once that set lands. There's no pin cap to worry
 * about, so the whole county is just more doors in the same one repaint —
 * and paintForDoor is where "Our turf" hides the rest. Idempotent: safe
 * whenever the map or either fetch lands first. */
function applyDoorPins() {
  if (!doorLayer) return
  const points: CanvasDoor[] = []
  const canvasDoor = (id: string, street: string, lat: number, lng: number) => {
    const n = houseNumber(street)
    points.push({ id, lat, lng, house: n > 0 ? String(n) : '' })
  }
  for (const door of turfDoors.value.values()) {
    if (door.lat == null || door.lng == null) continue
    canvasDoor(door.id, door.street, door.lat, door.lng)
  }
  for (const d of orgDoorsById.value.values()) {
    if (turfDoors.value.has(d.id)) continue
    canvasDoor(d.id, d.street, d.lat, d.lng)
  }
  doorLayer.setDoors(points)
}

/** Map taps: a door if one is under the finger (and we're zoomed in enough
 * for that to mean a specific door), otherwise nothing. Doors have no
 * elements of their own now, so this one listener covers every pin. */
function onMapClick(e: google.maps.MapMouseEvent) {
  const zoomedIn = (map?.getZoom() ?? 0) >= PINS_MIN_ZOOM
  const id = zoomedIn && e.latLng ? doorLayer?.doorAt(e.latLng) : null
  if (streetTapActive.value && assigningMemberId.value) {
    // The whole-street tool resolves off a door, so it needs one under the
    // finger — say so rather than doing nothing.
    if (id) handleStreetTap(id)
    else flashSweep(zoomedIn ? 'Tap a door pin on the street you want.' : 'Zoom in to pick a street.')
    return
  }
  if (id) onDoorTap(id)
}

/** Door pins do double duty: normally they open the door in Talk mode; in
 * assign mode they toggle the door in and out of the member's pile. */
function onDoorTap(addressId: string) {
  if (assigningMemberId.value) {
    toggleAssignDoor(addressId)
    return
  }
  void openDoor(addressId)
}

/** Tap a door pin: load it into Talk mode and jump to the canvass screen —
 * the squad map as a second way into knock logging. */
async function openDoor(addressId: string) {
  await talk.loadAddress(addressId)
  await router.push({ name: 'canvass' })
}

// Taking the turf offline used to be a "Save today's turf for offline" button
// here, with a saved-at line and a Clear (2026-07-26, gone the same day at the
// user's call — "I don't want the save today's turf for offline, I just want
// regular offline/online syncing so the door is always saved on the client side
// for whatever turf we're currently in"). It's automatic now and lives in
// lib/offlineCache.ts, kicked from AppShell: nothing to press, nothing to
// forget to press before walking into a dead zone.

const shareBusy = ref(false)

/** Turning it on asks the browser for the permission and sends one ping
 *  straight away — a switch that flips on and then shows nothing for a minute
 *  reads as broken. Turning it off DELETES the row, so no dot outlives the
 *  decision. */
async function toggleSharing() {
  if (shareBusy.value) return
  shareBusy.value = true
  if (sharing.value) await stopSharing()
  else await startSharing()
  shareBusy.value = false
  void loadPresence()
}

/** Everyone on the crew whose position we may see (RLS agrees separately). */
function squadUserIds(): string[] {
  return (mySquad.value?.members ?? []).map((m) => m.id)
}

async function loadPresence() {
  const ids = squadUserIds()
  if (!ids.length) return
  pingsByMember.value = await fetchSquadPings(ids)
  for (const m of mySquad.value?.members ?? []) updateMemberMarker(m)
}

/** Live dots. Subscribed for the whole table and filtered to the crew here —
 *  RLS already means nothing else is deliverable. */
function subscribePresence() {
  if (presenceFeed) return
  // Ages the "4 min ago" labels and the stale fade without waiting for a ping
  // to arrive — staleness is a function of the clock, not of traffic.
  presenceTimer = setInterval(() => {
    for (const m of mySquad.value?.members ?? []) updateMemberMarker(m)
  }, 30_000)
  presenceFeed = supabase
    .channel('squad-presence')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'member_locations' },
      (payload) => {
        const row = (payload.new ?? payload.old) as MemberPing | undefined
        if (!row?.user_id || !squadUserIds().includes(row.user_id)) return
        const next = new Map(pingsByMember.value)
        // A DELETE is somebody switching sharing off — the dot goes with it.
        if (payload.eventType === 'DELETE') next.delete(row.user_id)
        else next.set(row.user_id, payload.new as MemberPing)
        pingsByMember.value = next
        const member = (mySquad.value?.members ?? []).find((m) => m.id === row.user_id)
        if (member) updateMemberMarker(member)
      },
    )
    .subscribe()
}

/** Where to draw somebody. A LIVE ping wins over their last knocked door —
 *  it's the more recent fact — but only while it's still fresh enough to mean
 *  anything (presence.ts expires them). Past that we fall back to the door,
 *  which at least never claims to be current. */
function latestGeo(memberId: string): { lat: number; lng: number } | null {
  const ping = pingsByMember.value.get(memberId)
  if (ping && !isExpired(ping)) return { lat: ping.lat, lng: ping.lng }
  for (const r of recentByMember.value.get(memberId) ?? []) {
    if (r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng }
  }
  return null
}

function updateMemberMarker(member: ChatProfile, plink = false) {
  if (!map) return
  const spot = latestGeo(member.id)
  const existing = markersByMember.get(member.id)
  if (!spot) {
    if (existing) {
      existing.map = null
      markersByMember.delete(member.id)
    }
    return
  }
  if (existing) {
    existing.position = { lat: spot.lat, lng: spot.lng }
  } else {
    const el = document.createElement('div')
    el.className = 'member-marker'
    const color = memberColor(member)
    el.style.border = `3px solid ${color}`
    const url = avatarUrl(member.avatar)
    if (url) {
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      el.appendChild(img)
    } else {
      el.style.background = color
      el.textContent = (member.display_name || member.username).slice(0, 1).toUpperCase()
    }
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: spot.lat, lng: spot.lng },
      title: member.display_name || member.username,
      content: el,
      gmpClickable: true,
      zIndex: 500,
    })
    // Tap someone's icon in the field and you get the person: their run so
    // far, their profile, their phone number — and the map frames the crew's
    // turf behind the sheet, ready to divide. Zooming to THEM is the sheet's
    // "Show on map"; out here you already know where they are, you're looking
    // at them.
    marker.addListener('gmp-click', () => {
      selectedMemberId.value = member.id
      void openMemberSheet(member.id)
    })
    markersByMember.set(member.id, marker)
  }
  const marker = markersByMember.get(member.id)!
  const el = marker.content as HTMLElement
  el.classList.toggle('selected', selectedMemberId.value === member.id)
  // Live vs. last-knocked, said on the pin itself: a ring while a fresh ping
  // is driving the position, faded once it's gone stale, and the title carries
  // the age. Without this a dot from twenty minutes ago looks exactly like one
  // from ten seconds ago, which is the whole failure mode of foreground-only
  // sharing.
  const ping = pingsByMember.value.get(member.id)
  const live = !!ping && !isExpired(ping)
  const name = member.display_name || member.username
  el.classList.toggle('live', live)
  el.classList.toggle('stale', live && isStale(ping!))
  marker.title = live ? `${name} · ${lastSeenLabel(ping!)}` : name
  marker.zIndex = selectedMemberId.value === member.id ? 1000 : live ? 700 : 500
  if (plink) {
    el.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }],
      { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
  }
}

/** Frame the squad's TURF — that's the assignment, so that's the opening
 * shot. Members' last knocks can be anywhere (a lead checking in from home,
 * yesterday's doors across town), so they only set the frame when there are
 * no mapped turf doors at all. */
function fitToSquad() {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const d of turfDoors.value.values()) {
    if (d.lat != null && d.lng != null) bounds.extend({ lat: d.lat, lng: d.lng })
  }
  if (bounds.isEmpty()) {
    for (const marker of markersByMember.values()) {
      if (marker.position) bounds.extend(marker.position)
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
}

/**
 * Put the whole map card in view — the map, and the assign bar above it that
 * carries Save.
 *
 * Held back until the scroll lock is off, because every caller is reached from
 * a member sheet that has just closed and Reka releases its body scroll lock
 * only when the dialog UNMOUNTS — 0.2s later, once the slide-down animation has
 * run. A scroll fired before then is a silent no-op and is simply lost (see
 * afterScrollUnlock).
 *
 * That alone wasn't enough, and this is the second pass at it (2026-07-26,
 * reported: assigning one member lands at the top as it should, the next one
 * "snapped to the bottom", the same member sometimes either way). Two reasons,
 * both now handled by keepInSafeView rather than guessed at:
 *
 *  - `scrollIntoView({ block: 'start' })` scrolls unconditionally to a fixed
 *    landing. The lock has already clamped the page offset to 0 by then and
 *    doesn't restore it, so where the page IS when we get to move it isn't
 *    where the tap left it — which makes "scroll to a fixed place" the wrong
 *    instruction. What the request actually is, is "have the map fully on
 *    screen", so that's what's asked for now: the minimum delta that puts the
 *    card inside the chrome band, and nothing at all when it's already there.
 *  - The landing is verified for a moment afterwards. Assign mode inserts the
 *    assign bar INSIDE this card, above the map, so the target moves after the
 *    scroll starts; and a smooth scroll dies to any stray touch.
 *
 * Since the third pass this is the BACKSTOP, not the fix: `openMemberSheet`
 * scrolls the map up before the sheet's lock lands, so by the time Assign is
 * tapped the page is normally already right and `keepInSafeView` moves nothing.
 * It still matters for the ways in that skip the member sheet (the map's own
 * Assign button and its picker) and for whatever the lock did to the offset.
 */
function scrollMapIntoView() {
  void nextTick(() => {
    afterScrollUnlock(() => {
      if (mapCardEl.value) keepInSafeView(mapCardEl.value)
    })
  })
}

/** "Show on map" in a member's sheet: zoom to the last door they knocked, and
 * bring the map into view. Tapping the person themselves frames the crew's
 * turf instead — see openMemberSheet. */
function selectMember(memberId: string, scroll = true) {
  selectedMemberId.value = memberId
  for (const m of mySquad.value?.members ?? []) updateMemberMarker(m)
  const spot = latestGeo(memberId)
  if (map && spot) {
    map.panTo({ lat: spot.lat, lng: spot.lng })
    map.setZoom(17)
  }
  if (scroll) scrollMapIntoView()
}

/** Cell edge for clustering, degrees latitude (~1.1km) — same as Scout's
 * "frame my turf" geometry. Doors in the same or a touching cell are the same
 * patch of ground; a wider gap means genuinely separate parts. */
const CLUSTER_CELL_DEG = 0.01

/** Frame a set of doors: all of it when it's one patch, otherwise the BIGGEST
 * patch. An assignment split between Richwood and Marysville would otherwise
 * fit 20km of empty county and read as "the map doesn't know where to start"
 * — the exact complaint Scout's opening frame solved. */
function focusDoorSet(doors: { lat: number | null; lng: number | null }[]) {
  if (!map) return
  const cells = new Map<string, { lat: number; lng: number }[]>()
  for (const d of doors) {
    if (d.lat == null || d.lng == null) continue
    // Longitude cells widen by 1/cos(lat) so they stay square this far north.
    const key = `${Math.floor(d.lat / CLUSTER_CELL_DEG)}:${Math.floor(
      (d.lng * Math.cos((d.lat * Math.PI) / 180)) / CLUSTER_CELL_DEG,
    )}`
    const list = cells.get(key)
    if (list) list.push({ lat: d.lat, lng: d.lng })
    else cells.set(key, [{ lat: d.lat, lng: d.lng }])
  }
  if (!cells.size) return
  const seen = new Set<string>()
  let best: { lat: number; lng: number }[] = []
  for (const key of cells.keys()) {
    if (seen.has(key)) continue
    const patch: { lat: number; lng: number }[] = []
    const stack = [key]
    seen.add(key)
    while (stack.length) {
      const k = stack.pop()!
      patch.push(...(cells.get(k) ?? []))
      const [cx, cy] = k.split(':').map(Number)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = `${cx + dx}:${cy + dy}`
          if (cells.has(n) && !seen.has(n)) {
            seen.add(n)
            stack.push(n)
          }
        }
      }
    }
    if (patch.length > best.length) best = patch
  }
  const bounds = new google.maps.LatLngBounds()
  for (const d of best) bounds.extend(d)
  if (!bounds.isEmpty()) map.fitBounds(bounds, 56)
}

/** Frame the ground you're allowed to divide — the doors in the pools you may
 * cut from, biggest patch first. Starting zoomed out on the whole county
 * means every assign session begins with the same pinch-and-hunt.
 *
 * Holds still when some of it is already on screen (2026-07-26, user call),
 * which is what merely TAPPING a person does: the sheet shouldn't jerk the
 * map behind it, and the frame you already have is a frame that works.
 * `force` is for the moment assign mode actually opens — see
 * focusAssignTarget. */
function focusAssignPool(force = false) {
  const pool: TurfDoor[] = []
  for (const d of turfDoors.value.values()) {
    if (poolParentOf(d) !== null) pool.push(d)
  }
  // The pool, not the whole crew turf: assign mode paints nothing outside it,
  // so a visible door you can't divide would still leave an empty map.
  const doors = pool.length ? pool : [...turfDoors.value.values()]
  if (!force && anyDoorInView(doors)) return
  focusDoorSet(doors)
}

/** Opening shot for assign mode: THEIR doors when they already have some,
 * otherwise the whole pool you're dividing (2026-07-26, user call — "have our
 * turf zoomed into, or rather their doors if they have any").
 *
 * Unconditional, unlike focusAssignPool's own rule. Framing on every tap was
 * dropped this morning because the three ways in each fit the same pool from
 * a different starting frame, so the map read as wandering — but a target
 * that depends on WHO you picked lands in the same place every time you pick
 * that person, from any of the three doors in. Consistency was the point, not
 * holding still. */
function focusAssignTarget(theirs: Set<string>) {
  const mine: TurfDoor[] = []
  for (const id of theirs) {
    const d = turfDoors.value.get(id)
    if (d && d.lat != null && d.lng != null) mine.push(d)
  }
  // No doors yet — or none of them geocoded, which frames nothing at all.
  if (!mine.length) {
    focusAssignPool(true)
    return
  }
  focusDoorSet(mine)
}

function focusTurf(turfId: string) {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const d of turfDoors.value.values()) {
    if (d.turf_id === turfId && d.lat != null && d.lng != null) {
      bounds.extend({ lat: d.lat, lng: d.lng })
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
}

// --- Live knocks: squadmates' doors land on the page as they happen ---

let knockFeed: RealtimeChannel | null = null

function subscribeToKnocks() {
  knockFeed = supabase
    .channel('squad-knock-feed')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'knock_logs' },
      (payload) => void onLiveKnock(payload.new as KnockLog),
    )
    .subscribe()
}

async function onLiveKnock(knock: KnockLog) {
  if (!knock.household_id || !memberIdSet.value.has(knock.canvasser_id)) return
  const { data: a } = await supabase
    .from('addresses')
    .select('id, street, lat, lng, turf_id')
    .eq('id', knock.household_id)
    .maybeSingle()
  if (!a) return

  const list = recentByMember.value.get(knock.canvasser_id) ?? []
  recentByMember.value.set(knock.canvasser_id, [
    { addressId: a.id, street: a.street, lat: a.lat, lng: a.lng, occurredAt: knock.occurred_at },
    ...list.filter((r) => r.addressId !== a.id),
  ].slice(0, 5))

  if (a.turf_id && turfIdSet.value.has(a.turf_id)) {
    knockedDoors.value.add(a.id)
    let set = knockedByMember.value.get(knock.canvasser_id)
    if (!set) knockedByMember.value.set(knock.canvasser_id, (set = new Set()))
    set.add(a.id)
    // The knocker's avatar lands on the pin live — guard on "today" anyway
    // (an offline knock can sync in hours late) and keep the newest.
    const at = Date.parse(knock.occurred_at)
    if (at >= new Date().setHours(0, 0, 0, 0)) {
      const prev = todayKnockerByDoor.value.get(a.id)
      if (!prev || prev.at <= at) {
        todayKnockerByDoor.value.set(a.id, { canvasserId: knock.canvasser_id, at })
      }
    }
    // Re-pull just this door's status row so the pin recolors exactly
    // (signed counts included) instead of approximating from the raw knock.
    const { data: status } = await supabase
      .from('household_latest_knock')
      .select('*')
      .eq('household_id', a.id)
      .maybeSingle()
    if (status) statusByDoor.value.set(a.id, status as HouseholdLatestKnock)
    // These writes are in-place, so repaint explicitly (the watcher above
    // only sees whole-Map replacements), then pop the door — the thing that
    // makes a squadmate's live progress watchable.
    doorLayer?.requestRepaint()
    doorLayer?.plink(a.id, 2.4, 700)
  }

  // Someone's full-run sheet is open on this exact person — land the knock in
  // it too. One row fetched with its embeds, prepended: refetching the whole
  // list would blank the sheet mid-read.
  if (sheetMemberId.value === knock.canvasser_id) {
    const { data: row } = await supabase
      .from('knock_logs')
      .select('id, outcome, occurred_at, household_id, person:persons(name), addresses(street, city)')
      .eq('id', knock.id)
      .maybeSingle()
    type Row = {
      id: string
      outcome: KnockOutcome
      occurred_at: string
      household_id: string | null
      person: { name: string } | null
      addresses: { street: string; city: string } | null
    }
    const r = row as unknown as Row | null
    if (r && sheetMemberId.value === knock.canvasser_id && !sheetFeed.value.some((f) => f.id === r.id)) {
      sheetFeed.value = [
        {
          id: r.id,
          outcome: r.outcome,
          occurredAt: r.occurred_at,
          addressId: r.household_id,
          street: r.addresses?.street ?? '',
          city: r.addresses?.city ?? '',
          person: r.person?.name ?? null,
        },
        ...sheetFeed.value,
      ]
    }
  }

  const member = mySquad.value?.members.find((m) => m.id === knock.canvasser_id)
  if (member) updateMemberMarker(member, true)
}

// --- Assign mode: hand doors to a member right on the squad map ---
// Tap "Assign doors" on a member's card, tap doors on the map, save. The
// selection becomes a sub-turf assigned to that member ("<name>'s doors"),
// cut with the same set_turf_segments machinery as the /turf sub-cutter, so
// Hunt, progress bars, and RLS all keep working unchanged.

const assigningMemberId = ref<string | null>(null)
const assignSelected = ref<ReadonlySet<string>>(new Set())
const assignSaving = ref(false)
const assignError = ref('')

/** Selection snapshots for the assign-mode Undo. A lasso takes two hundred
 * doors in one drag, so "put that back" has to be one tap and not two hundred
 * — same reason the turf cutter carries Undo on the map. Capped like the
 * cutter's at 25. */
const assignUndo = ref<ReadonlySet<string>[]>([])
const canUndoAssign = computed(() => assignUndo.value.length > 0)

/** Call BEFORE any change to the pile. */
function snapshotAssign() {
  const stack = assignUndo.value.slice(-24)
  stack.push(assignSelected.value)
  assignUndo.value = stack
}

function undoAssign() {
  const stack = assignUndo.value.slice()
  const prev = stack.pop()
  if (!prev) return
  assignUndo.value = stack
  assignSelected.value = prev
  sweepFlash.value = ''
}

const assigningMember = computed<ChatProfile | null>(
  () => (mySquad.value?.members ?? []).find((m) => m.id === assigningMemberId.value) ?? null,
)

// Anything paintForDoor reads repaints the one canvas (rAF-coalesced in the
// layer). This replaces what used to be a loop restyling every door marker's
// ~20 inline style properties — assign-mode taps in particular used to
// restyle EVERY pin on the map per tap. Declared down here because it closes
// over the assign refs above.
//
// Not a deep watch: every source here is REPLACED wholesale (loadDashboard
// rebuilds the Maps, assign taps build a new Set), so reference equality is
// enough. The one in-place path is the live knock feed, which repaints
// explicitly.
watch(
  [
    turfDoors,
    statusByDoor,
    todayKnockerByDoor,
    anyTurfColorById,
    turfShade,
    ownerLayer,
    turfById,
    orgDoorsById,
    orgStatusByDoor,
    assigningMemberId,
    assignSelected,
  ],
  () => doorLayer?.requestRepaint(),
)

/** The top-level pool a door would be claimed from (itself for a door still
 * in a parent turf, its parent for a door already in a sub-turf) — or null
 * when the viewer isn't allowed to divide that turf. */
function poolParentOf(door: TurfDoor): string | null {
  const t = turfById.value.get(door.turf_id)
  if (!t) return null
  const pid = t.parent_turf_id ?? t.id
  return assignableParentIds.value.has(pid) ? pid : null
}

function startAssign(memberId: string) {
  if (assigningMemberId.value === memberId) {
    scrollMapIntoView()
    return
  }
  assignError.value = ''
  assigningMemberId.value = memberId
  // Pre-select what's already theirs, so re-opening a member edits their
  // existing pile instead of starting from scratch.
  const pre = new Set<string>()
  for (const d of turfDoors.value.values()) {
    const t = turfById.value.get(d.turf_id)
    if (
      t?.parent_turf_id &&
      t.assignee_id === memberId &&
      assignableParentIds.value.has(t.parent_turf_id)
    ) {
      pre.add(d.id)
    }
  }
  assignSelected.value = pre
  assignUndo.value = []
  disarmTools()
  sweepFlash.value = ''
  scrollMapIntoView()
  // Land on the ground being divided, not on the county. The map is already
  // filtered to that turf (paintForDoor), so this frames exactly what's
  // painted — set up and ready to sweep. `pre` is what's already theirs, so
  // re-opening someone frames the pile you're about to edit.
  focusAssignTarget(pre)
}

function cancelAssign() {
  assigningMemberId.value = null
  assignSelected.value = new Set()
  assignUndo.value = []
  assignError.value = ''
  disarmTools()
  sweepFlash.value = ''
}

/** The map's own way into assigning (2026-07-25, user call — "I don't see any
 * lasso or street tap tool on the squad page"). The sweep tools only exist
 * once a pile is open, and until now the only door into that was tapping a
 * person, then Assign in their sheet: a leader looking at the map for a lasso
 * found nothing at all. So the map carries the entry itself — one button that
 * asks who the doors are for (or goes straight to you, when the switch has
 * handed claiming to the crew). */
const assignPickerOpen = ref(false)
const assignableMembers = computed<ChatProfile[]>(() =>
  orderedMembers.value.filter((m) => canAssignTo(m.id)),
)

function startAssignFromMap() {
  const me = auth.profile?.id
  if (claimSelfOnly.value && me) {
    startAssign(me)
    return
  }
  if (assignableMembers.value.length === 1) {
    startAssign(assignableMembers.value[0].id)
    return
  }
  assignPickerOpen.value = true
}

/** One tap, one door, in or out. That's the whole gesture.
 *
 * The two-tap walk sweep (tap A, tap B, take everything between) is GONE as
 * of 2026-07-25 (user call, both maps): "the tap one and then sweep the whole
 * street is no longer a feature." It was invisible — nothing on screen said a
 * door had become an anchor — so the second tap could rope in a hundred
 * houses you never asked for. The lasso and the Streets tool do bulk
 * selection now, visibly, and you refine with the lasso afterward. */
function toggleAssignDoor(addressId: string) {
  const door = turfDoors.value.get(addressId)
  if (!door || poolParentOf(door) === null) return
  snapshotAssign()
  const next = new Set(assignSelected.value)
  if (next.has(addressId)) next.delete(addressId)
  else next.add(addressId)
  assignSelected.value = next
}

// --- Sweep tools: lasso and whole-street taps -------------------------------
// Tapping doors one at a time (or two-tapping a walk) is fine for a stretch;
// it is not fine for "give Angie everything east of the tracks". So the squad
// map carries the turf cutter's two sweep tools, cut down to what this map
// needs — the selection here is a set of door ids, not street segments, so
// there's no draft/claim machinery behind either one.
//
// Lasso: freeze the map under a pointer-capture overlay, drag a loop, and
// every assignable door inside it (or brushed by the line) joins the pile.
// Streets: tap a door pin and its whole street comes with it.
// Both share one Add/Erase switch, shown only while a tool is armed.

/** How close (screen px) the lasso LINE must pass to a door to brush it —
 * scribbling over a few pins works without enclosing them. Same 16px the
 * cutter uses. */
const LASSO_BRUSH_PX = 16

const lassoActive = ref(false)
const streetTapActive = ref(false)
const sweepMode = ref<'add' | 'erase'>('add')
const lassoCanvasEl = ref<HTMLCanvasElement | null>(null)
let lassoPath: { x: number; y: number }[] = []
let lassoDrawing = false

/** Transient one-liner under the assign bar ("Lasso: added 34 doors") — the
 * sweep tools take a lot of doors at once and silence reads as "did that
 * work?". */
const sweepFlash = ref('')
let sweepFlashTimer: ReturnType<typeof setTimeout> | undefined
function flashSweep(msg: string) {
  sweepFlash.value = msg
  clearTimeout(sweepFlashTimer)
  sweepFlashTimer = setTimeout(() => (sweepFlash.value = ''), 3500)
}

/** Put the map back the way we found it and drop any half-drawn loop. */
function disarmTools() {
  if (lassoActive.value) map?.setOptions({ gestureHandling: 'greedy' })
  lassoActive.value = false
  streetTapActive.value = false
  sweepMode.value = 'add'
  lassoPath = []
  lassoDrawing = false
}

function toggleLasso() {
  const on = !lassoActive.value
  disarmTools()
  lassoActive.value = on
  map?.setOptions({ gestureHandling: on ? 'none' : 'greedy' })
  if (on) void nextTick(sizeLassoCanvas)
}

function toggleStreetTap() {
  const on = !streetTapActive.value
  disarmTools()
  streetTapActive.value = on
}

function sizeLassoCanvas() {
  const c = lassoCanvasEl.value
  const host = mapEl.value
  if (!c || !host) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  c.width = Math.round(host.clientWidth * dpr)
  c.height = Math.round(host.clientHeight * dpr)
  c.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function lassoPoint(e: PointerEvent): { x: number; y: number } {
  const rect = (lassoCanvasEl.value ?? mapEl.value)!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function drawLassoTrail() {
  const c = lassoCanvasEl.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  ctx.clearRect(0, 0, c.width, c.height)
  if (lassoPath.length < 2) return
  ctx.beginPath()
  ctx.moveTo(lassoPath[0].x, lassoPath[0].y)
  for (let i = 1; i < lassoPath.length; i++) ctx.lineTo(lassoPath[i].x, lassoPath[i].y)
  // The loop draws in the member's own color while adding, and in the
  // shared "this is a no" red while erasing — the intent reads before the
  // finger lifts.
  ctx.strokeStyle =
    sweepMode.value === 'erase'
      ? '#d64545'
      : assigningMember.value
        ? memberColor(assigningMember.value)
        : '#1d2433'
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.setLineDash([6, 6])
  ctx.beginPath()
  ctx.moveTo(lassoPath[lassoPath.length - 1].x, lassoPath[lassoPath.length - 1].y)
  ctx.lineTo(lassoPath[0].x, lassoPath[0].y)
  ctx.stroke()
  ctx.setLineDash([])
}

function onLassoDown(e: PointerEvent) {
  sizeLassoCanvas()
  lassoDrawing = true
  lassoPath = [lassoPoint(e)]
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onLassoMove(e: PointerEvent) {
  if (!lassoDrawing) return
  const p = lassoPoint(e)
  const last = lassoPath[lassoPath.length - 1]
  if (Math.hypot(p.x - last.x, p.y - last.y) < 4) return
  lassoPath.push(p)
  drawLassoTrail()
}

function clearLassoCanvas() {
  const c = lassoCanvasEl.value
  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
}

function onLassoUp() {
  if (!lassoDrawing) return
  lassoDrawing = false
  const path = lassoPath
  lassoPath = []
  clearLassoCanvas()
  if (path.length < 3 || !assigningMemberId.value) return
  const ids = doorLayer?.doorsInPolygon(path, LASSO_BRUSH_PX) ?? []
  applySweep(ids, 'Lasso')
}

function onLassoCancel() {
  lassoDrawing = false
  lassoPath = []
  clearLassoCanvas()
}

/** Tap a door pin while ☝ Streets is armed: its whole street joins (or
 * leaves) the pile. Resolving off the tapped DOOR rather than reverse
 * geocoding the point — unlike the cutter, every door this map can act on is
 * already loaded and painted, so there is nothing to guess at. */
function handleStreetTap(addressId: string) {
  const door = turfDoors.value.get(addressId)
  if (!door) return
  const key = streetKeyOf(door)
  const ids: string[] = []
  for (const d of turfDoors.value.values()) {
    if (streetKeyOf(d) === key) ids.push(d.id)
  }
  applySweep(ids, prettyStreet(streetNameOf(door.street)))
}

function streetKeyOf(d: TurfDoor): string {
  return `${streetNameOf(d.street)}|${d.city.toUpperCase()}`
}

/** Fold a swept batch of door ids into the member's pile (or out of it) and
 * say what happened. Doors the viewer can't hand out — another crew's turf,
 * a turf they may not divide — are skipped and counted, never silently
 * included. Sweeps clear the two-tap walk anchor: the anchor means "the last
 * door you tapped", and after a loop that's not a thing. */
function applySweep(ids: string[], what: string) {
  const next = new Set(assignSelected.value)
  if (sweepMode.value === 'erase') {
    let removed = 0
    for (const id of ids) {
      if (next.delete(id)) removed++
    }
    if (!removed) {
      flashSweep('Nothing of theirs there. Erase takes doors back out of the pile.')
      return
    }
    snapshotAssign()
    assignSelected.value = next
    flashSweep(`${what}: removed ${removed} door${removed === 1 ? '' : 's'}.`)
    return
  }
  let added = 0
  let skipped = 0
  for (const id of ids) {
    const door = turfDoors.value.get(id)
    if (!door || poolParentOf(door) === null) {
      if (!next.has(id)) skipped++
      continue
    }
    if (!next.has(id)) {
      next.add(id)
      added++
    }
  }
  if (!added) {
    flashSweep(
      skipped
        ? `${what}: nothing to take. ${skipped} door${skipped === 1 ? '' : 's'} belong to turf you can't divide.`
        : `${what}: those doors are already in the pile.`,
    )
    return
  }
  snapshotAssign()
  assignSelected.value = next
  flashSweep(
    skipped
      ? `${what}: added ${added} door${added === 1 ? '' : 's'} · ${skipped} skipped (not yours to divide).`
      : `${what}: added ${added} door${added === 1 ? '' : 's'}.`,
  )
}

interface SegmentDraft {
  street_name: string
  city: string
  range_start: number
  range_end: number
  parity: 'both'
}

/** Compress a door pile into street segments for set_turf_segments. Runs of
 * house numbers merge into one range, but never across a "blocker": a door
 * the RPC could also claim from the same pool (poolDoors) that ISN'T in the
 * pile — a spanning range would swallow it. */
function segmentsFor(doors: TurfDoor[], poolDoors: TurfDoor[]): SegmentDraft[] {
  const keyOf = (d: TurfDoor) => `${streetNameOf(d.street)}|${d.city.toUpperCase()}`
  const chosen = new Set(doors.map((d) => d.id))
  const byStreet = new Map<string, { name: string; city: string; nums: Set<number>; blocked: Set<number> }>()
  for (const d of doors) {
    const key = keyOf(d)
    let g = byStreet.get(key)
    if (!g) byStreet.set(key, (g = { name: streetNameOf(d.street), city: d.city, nums: new Set(), blocked: new Set() }))
    g.nums.add(houseNumber(d.street))
  }
  for (const d of poolDoors) {
    if (chosen.has(d.id)) continue
    const g = byStreet.get(keyOf(d))
    if (!g) continue
    const n = houseNumber(d.street)
    // A left-out unit at a picked house number can't split the range (the
    // RPC claims whole numbers) — it just rides along with its neighbors.
    if (!g.nums.has(n)) g.blocked.add(n)
  }
  const segs: SegmentDraft[] = []
  for (const g of byStreet.values()) {
    const nums = [...g.nums].sort((a, b) => a - b)
    const blocked = [...g.blocked].sort((a, b) => a - b)
    let start = nums[0]
    let prev = nums[0]
    for (let i = 1; i <= nums.length; i++) {
      const n = nums[i]
      if (n === undefined || blocked.some((b) => b > prev && b < n)) {
        segs.push({ street_name: g.name, city: g.city, range_start: start, range_end: prev, parity: 'both' })
        if (n !== undefined) start = n
      }
      if (n !== undefined) prev = n
    }
  }
  return segs
}

async function saveAssignment() {
  const member = assigningMember.value
  if (!member || assignSaving.value) return
  assignSaving.value = true
  assignError.value = ''
  try {
    // Selection grouped by which top-level turf's pool each door sits in
    // (a squad can hold more than one turf; each needs its own sub-turf).
    const byParent = new Map<string, TurfDoor[]>()
    for (const id of assignSelected.value) {
      const d = turfDoors.value.get(id)
      const p = d ? poolParentOf(d) : null
      if (!d || !p) continue
      const list = byParent.get(p)
      if (list) list.push(d)
      else byParent.set(p, [d])
    }
    // The member's existing sub-turfs, so a deselected-to-empty one is
    // deleted (its doors return to the parent via the DB trigger).
    const ownByParent = new Map<string, TurfLite>()
    for (const t of squadTurfs.value) {
      if (
        t.parent_turf_id !== null &&
        t.assignee_id === member.id &&
        assignableParentIds.value.has(t.parent_turf_id)
      ) {
        ownByParent.set(t.parent_turf_id, t)
      }
    }
    const doorsIn = (turfId: string) =>
      [...turfDoors.value.values()].filter((d) => d.turf_id === turfId)

    for (const parentId of new Set([...byParent.keys(), ...ownByParent.keys()])) {
      const sel = byParent.get(parentId) ?? []
      const selIds = new Set(sel.map((d) => d.id))
      const own = ownByParent.get(parentId) ?? null

      // 1. Doors taken over from a squadmate's sub-turf get released first by
      //    re-cutting that sub-turf without them — the RPC only claims doors
      //    from the parent's pool, so a straight cut can't steal them.
      for (const sib of squadTurfs.value) {
        if (sib.parent_turf_id !== parentId || sib.id === own?.id) continue
        const sibDoors = doorsIn(sib.id)
        const keep = sibDoors.filter((d) => !selIds.has(d.id))
        if (keep.length === sibDoors.length) continue
        if (!keep.length) {
          const { error } = await supabase.from('turfs').delete().eq('id', sib.id)
          if (error) throw error
        } else {
          const { error } = await supabase.rpc('set_turf_segments', {
            target_turf_id: sib.id,
            segments: segmentsFor(keep, [...doorsIn(parentId), ...sibDoors]),
          })
          if (error) throw error
        }
      }

      // 2. The member's own sub-turf: create, re-cut, or delete when emptied.
      if (!sel.length) {
        if (own) {
          const { error } = await supabase.from('turfs').delete().eq('id', own.id)
          if (error) throw error
        }
        continue
      }
      let turfId = own?.id ?? null
      if (!turfId) {
        const { data, error } = await supabase
          .from('turfs')
          .insert({
            name: `${memberName(member)}'s doors`,
            color: memberColor(member),
            assignee_id: member.id,
            parent_turf_id: parentId,
            created_by: auth.profile?.id,
          })
          .select('id')
          .single()
        if (error || !data) throw error ?? new Error('insert failed')
        turfId = data.id as string
      }
      const { error } = await supabase.rpc('set_turf_segments', {
        target_turf_id: turfId,
        segments: segmentsFor(sel, [...doorsIn(parentId), ...(own ? doorsIn(own.id) : [])]),
      })
      if (error) throw error
    }
    assigningMemberId.value = null
    assignSelected.value = new Set()
    disarmTools()
    sweepFlash.value = ''
    await loadDashboard()
  } catch {
    assignError.value = "Couldn't save that assignment. Try again."
  } finally {
    assignSaving.value = false
  }
}

// --- Member sheet: the last five on a card, the whole day behind it --------
// The card's recent list answers "where are they right now" in a glance and
// then runs out. Tapping it (or the card's ⋯ button) opens the same member's
// full run — last 60 knocks with outcomes, the people answered, and the way
// through to their profile page.

const sheetMemberId = ref<string | null>(null)
const sheetOpen = computed({
  get: () => sheetMemberId.value !== null,
  set: (v: boolean) => {
    if (!v) sheetMemberId.value = null
  },
})
const sheetMember = computed<ChatProfile | null>(
  () => (sheetMemberId.value ? (memberById.value.get(sheetMemberId.value) ?? null) : null),
)

interface FeedRow {
  id: string
  outcome: KnockOutcome
  occurredAt: string
  addressId: string | null
  street: string
  city: string
  person: string | null
}

const sheetFeed = ref<FeedRow[]>([])
const sheetLoading = ref(false)
/** Drops a slower earlier fetch that lands after a newer member's. */
let sheetSeq = 0

/** The sheet's two buttons that close it on the way out. Both capture the id
 * FIRST: `sheetMember` is a computed off `sheetMemberId`, so reading it after
 * clearing the id reads null. Written inline as
 * `sheetMemberId = null; startAssign(sheetMember.id)`, that threw before
 * startAssign ever ran — the sheet shut and the map just sat there, which is
 * exactly what "tapping a person and hitting Assign does nothing" was
 * (2026-07-25). Don't put these back in the template. */
function assignFromSheet() {
  const id = sheetMemberId.value
  if (!id) return
  sheetMemberId.value = null
  startAssign(id)
}

function showMemberOnMap() {
  const id = sheetMemberId.value
  if (!id) return
  sheetMemberId.value = null
  selectMember(id)
}

async function openMemberSheet(memberId: string) {
  // Bring the map up NOW, while the page can still be scrolled — before the
  // sheet's scroll lock lands on the next tick (2026-07-26, user call: "when I
  // click on a name, it's already bringing me to the top anyways, and that's
  // fine. It just needs to stay there").
  //
  // This is the fix, and scrollMapIntoView is only the backstop. A sheet
  // mangles the page offset in engine-specific ways — clamped to 0 here, put
  // back where the tap was on the reporter's phone — so anything that waits
  // until Assign to move the page is correcting after the fact, which is a
  // visible pan whichever direction it goes. Move first and there is nothing
  // left to correct: the offset the lock captures already shows the map, so
  // restoring it is harmless and clamping it to 0 also shows the map.
  //
  // Instant, not smooth: an animation would still be running when the lock
  // lands, and the lock would capture some arbitrary midpoint of it.
  if (mapCardEl.value) scrollIntoSafeView(mapCardEl.value, 'auto')
  sheetMemberId.value = memberId
  // Frame OUR TURF, not their last stop (2026-07-25, user call): tapping a
  // person is the first move of handing them doors, so the map underneath the
  // sheet should already be the ground you'd divide — and holds still when it
  // already is, so the sheet doesn't jerk the map behind it — hit Assign and you're
  // set up. Where they physically are is a different question, and it has its
  // own button in the sheet ("Show on map").
  focusAssignPool()
  sheetFeed.value = []
  sheetLoading.value = true
  const seq = ++sheetSeq
  // Today only, like the cards: this page is one day's crew, and their run
  // today is the thing anyone's asking about. Their whole history is one tap
  // further on, at /member/:id.
  const { data } = await supabase
    .from('knock_logs')
    .select('id, outcome, occurred_at, household_id, person:persons(name), addresses(street, city)')
    .eq('canvasser_id', memberId)
    .gte('occurred_at', startOfLocalDayISO())
    .order('occurred_at', { ascending: false })
    .limit(60)
  if (seq !== sheetSeq) return
  type Row = {
    id: string
    outcome: KnockOutcome
    occurred_at: string
    household_id: string | null
    person: { name: string } | null
    addresses: { street: string; city: string } | null
  }
  sheetFeed.value = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    outcome: r.outcome,
    occurredAt: r.occurred_at,
    addressId: r.household_id,
    street: r.addresses?.street ?? '',
    city: r.addresses?.city ?? '',
    person: r.person?.name ?? null,
  }))
  sheetLoading.value = false
}

/** A feed row is a way back to the door: same handoff the map pins do. */
async function openFeedDoor(row: FeedRow) {
  if (!row.addressId) return
  sheetMemberId.value = null
  await openDoor(row.addressId)
}

function openMemberProfile(memberId: string) {
  sheetMemberId.value = null
  void router.push({ name: 'member', params: { id: memberId } })
}

// --- No-squad state: form or join today's crew right here ---

const composing = ref(false)
const squadName = ref('')
const picked = ref<ChatProfile[]>([])
const creating = ref(false)

function openComposer() {
  composing.value = true
  squadName.value = ''
  picked.value = []
}

async function createSquad() {
  const name = squadName.value.trim()
  if (creating.value || !name) return
  creating.value = true
  const squad = await squads.createSquad(
    name,
    picked.value.map((p) => p.id),
  )
  creating.value = false
  if (squad) {
    composing.value = false
    selectedSquadId.value = squad.id
  }
}

function openSquadChat() {
  if (mySquad.value?.chat_id) chat.openDrawer(mySquad.value.chat_id)
}

// On this page, the chat drawer IS the squad's chat (2026-07-24, user call):
// pulling the right-edge handle open here lands in the crew's room rather
// than the room list. The store field is the whole mechanism — the drawer
// honors it whenever it's opened without an explicit room — and it's cleared
// on unmount so every other screen still opens on the list.
watch(
  () => mySquad.value?.chat_id ?? null,
  (id) => {
    chat.preferredChatId = id
  },
  { immediate: true },
)

async function leaveSquad() {
  const squad = mySquad.value
  if (!squad) return
  await squads.leaveSquad(squad.id)
  selectedSquadId.value = null
}

// --- Display helpers ---

/** "412 WALNUT ST" → "412 Walnut St" — small text has no room to shout. */
function prettyStreet(street: string): string {
  return street.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function knockTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Sheet rows span days, so they carry the day as well as the clock. */
function feedStamp(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `Today ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`
}

function memberName(m: ChatProfile): string {
  return m.display_name || m.username
}

/** "Squad Leader" and friends — the same labels the roster shows. Canvasser
 * is the default and says nothing worth a chip. */
function memberRoleLabel(m: ChatProfile): string | null {
  if (!m.role || m.role === 'canvasser') return null
  return ROLE_LABELS[m.role]
}

function knockedCount(memberId: string): number {
  return knockedByMember.value.get(memberId)?.size ?? 0
}

// --- Map fullscreen. Ported verbatim from Scout/the turf cutter: Safari
// (incl. iOS) only ever exposes the webkit-prefixed API, so both directions
// need a fallback, and Google Maps has to be told its container resized once
// the browser finishes the transition — as does the door canvas, which sizes
// itself off the map div. ---

const isFullscreen = ref(false)
const mapWrapEl = ref<HTMLElement | null>(null)

type FullscreenableEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}
type FullscreenableDoc = Document & {
  webkitExitFullscreen?: () => Promise<void> | void
  webkitFullscreenElement?: Element | null
}

function toggleFullscreen() {
  const doc = document as FullscreenableDoc
  if (document.fullscreenElement ?? doc.webkitFullscreenElement) {
    if (document.exitFullscreen) void document.exitFullscreen()
    else doc.webkitExitFullscreen?.()
    return
  }
  const el = mapWrapEl.value as FullscreenableEl | null
  if (!el) return
  if (el.requestFullscreen) void el.requestFullscreen()
  else el.webkitRequestFullscreen?.()
}

function onFullscreenChange() {
  const doc = document as FullscreenableDoc
  isFullscreen.value = Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement)
  setTimeout(() => {
    if (!map) return
    google.maps.event.trigger(map, 'resize')
    doorLayer?.checkView()
    doorLayer?.requestRepaint()
    // The lasso surface is sized in pixels off the map div, so it has to be
    // re-measured too — sweeping is mostly a fullscreen activity.
    if (lassoActive.value) sizeLassoCanvas()
  }, 0)
}

// --- Lifecycle ---

onMounted(async () => {
  squads.subscribeToRosters()
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  await squads.loadToday()
  subscribeToKnocks()
})

// The map div only exists while you're IN a squad (the no-squad branch has
// no map), so init keys off the element appearing — not off mount. Firing
// again after leave/rejoin is fine: initMap re-inits only for a fresh div.
watch(mapEl, (el) => {
  if (el) void initMap()
}, { flush: 'post' })

// Drags inside the map are the map's, never the page's; a touch on a map
// that's scrolled half off screen (reading the member tiles) brings it back
// into view instead of panning a map you can only half see. Same guard on
// Scout and the turf cutter. Re-attached if the wrapper is ever replaced.
let scrollGuard: MapScrollGuard | null = null
watch(
  mapWrapEl,
  (el) => {
    scrollGuard?.dispose()
    scrollGuard = el
      ? attachMapScrollGuard(el, {
          scrollTarget: () => mapCardEl.value,
          isFullscreen: () => isFullscreen.value,
        })
      : null
  },
  { flush: 'post' },
)

onUnmounted(() => {
  squads.unsubscribeFromRosters()
  chat.preferredChatId = null
  scrollGuard?.dispose()
  scrollGuard = null
  if (knockFeed) void supabase.removeChannel(knockFeed)
  if (presenceFeed) void supabase.removeChannel(presenceFeed)
  presenceFeed = null
  clearInterval(presenceTimer)
  presenceTimer = undefined
  doorLayer?.dispose()
  doorLayer = null
  for (const marker of markersByMember.values()) marker.map = null
  markersByMember.clear()
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
})

// Load once the squad appears and reload whenever the squad or its roster
// changes (the store keeps the roster live via its squad_members
// subscription). Immediate: the store may already hold today's squads from
// an earlier visit this session.
watch(
  () => (mySquad.value ? `${mySquad.value.id}:${mySquad.value.members.length}` : ''),
  (key) => {
    if (key) void loadDashboard()
  },
  { immediate: true },
)
</script>

<template>
  <AppShell title="Squad">
    <!-- ============ No squad today ============ -->
    <div v-if="!squads.loading && !mySquad" class="stack">
      <p class="muted intro">
        No squad yet today.
      </p>
      <button class="btn btn-primary big-btn" data-help="squad-start" @click="openComposer">+ Start today's squad</button>
      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <p v-if="squads.squads.length" class="muted join-heading">…or join one that's out already:</p>
      <div v-for="(s, i) in squads.squads" :key="s.id" v-motion="fadeUp(Math.min(i, 8) * 45)" class="card join-card">
        <div class="join-info">
          <span class="join-name">👥 {{ s.name }}</span>
          <span class="muted join-members">
            {{ s.members.length }} member{{ s.members.length === 1 ? '' : 's' }} ·
            {{ s.members.map(memberName).join(', ') }}
          </span>
        </div>
        <button class="btn btn-sm btn-primary" @click="squads.joinSquad(s.id)">Join</button>
      </div>
    </div>

    <!-- ============ Your squad ============ -->
    <div v-else-if="mySquad" class="stack">
      <div class="squad-header">
        <div class="squad-title">
          <h2>👥 {{ mySquad.name }}</h2>
          <span class="muted">{{ mySquad.members.length }} member{{ mySquad.members.length === 1 ? '' : 's' }} today</span>
        </div>
        <div class="squad-actions">
          <!-- No squad switcher: one crew at a time (2026-07-25). Leave and
               join another if you're on the wrong one. -->
          <button v-if="mySquad.chat_id" class="btn btn-sm btn-primary" @click="openSquadChat">Chat</button>
          <button class="btn btn-sm btn-ghost" @click="leaveSquad">Leave</button>
        </div>
      </div>

      <!-- Map first (2026-07-25, user call): the ground the crew is standing
           on is what the page is for. The numbers read under it. -->
      <div ref="mapCardEl" class="card map-card">
        <div
          v-if="assigningMember"
          class="assign-bar"
          :style="{ '--assign-color': memberColor(assigningMember) }"
        >
          <span class="assign-dot" aria-hidden="true"></span>
          <!-- One line, and only the things that change: who, how many, and
               what the last sweep did (2026-07-25 — this was a paragraph of
               instructions, which is a lot of screen to read past every
               time). This is the ONLY Save on screen; the black bar that
               used to sit on the map is fullscreen-only now, where this one
               isn't visible. -->
          <p class="assign-text">
            <template v-if="assigningMemberId === auth.profile?.id && claimSelfOnly">
              Claiming for <strong>you</strong>
            </template>
            <template v-else>
              Assigning to <strong>{{ memberName(assigningMember) }}</strong>
            </template>
            · <strong class="assign-count">{{ assignSelected.size }}</strong> doors
            <span v-if="sweepFlash" class="assign-flash">· {{ sweepFlash }}</span>
            <span v-else-if="lassoActive" class="assign-flash">
              · {{ sweepMode === 'erase' ? 'Loop doors to take them back out' : 'Loop doors to add them' }}
            </span>
            <span v-else-if="streetTapActive" class="assign-flash">
              · {{ sweepMode === 'erase' ? 'Tap a door to drop its street' : 'Tap a door to take its street' }}
            </span>
          </p>
          <div class="assign-actions">
            <button class="btn btn-sm btn-primary" :disabled="assignSaving" @click="saveAssignment">
              {{ assignSaving ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn btn-sm btn-ghost" :disabled="assignSaving" @click="cancelAssign">
              Cancel
            </button>
          </div>
          <p v-if="assignError" class="error assign-error">{{ assignError }}</p>
        </div>
        <p v-if="mapsAuthError || mapFailed" class="error map-error">
          Couldn't load Google Maps. Check the connection and reload.
        </p>
        <div
          v-else
          ref="mapWrapEl"
          class="squad-map-wrap"
          :class="{ 'map-wrap-fullscreen': isFullscreen }"
          data-help="squad-map"
        >
          <div ref="mapEl" class="squad-map"></div>
          <!-- Freehand selection surface — only exists while the lasso is
               armed, and it swallows the map's own gestures while it does. -->
          <div
            v-if="lassoActive"
            class="lasso-layer"
            @pointerdown.prevent="onLassoDown"
            @pointermove.prevent="onLassoMove"
            @pointerup.prevent="onLassoUp"
            @pointercancel="onLassoCancel"
          >
            <canvas ref="lassoCanvasEl" class="lasso-canvas"></canvas>
          </div>
          <!-- FULLSCREEN ONLY (2026-07-25, user call — "two places to save
               it, and that's clunky"). The page's assign bar sits right
               above the map and is the one Save everywhere else; in
               fullscreen it isn't on screen at all, and sweeping is exactly
               what people do in fullscreen. So the two never show at once.
               Above the lasso surface, so it stays reachable while a tool is
               armed. -->
          <div
            v-if="assigningMember && isFullscreen"
            class="assign-mapbar"
            :style="{
              '--assign-color': memberColor(assigningMember),
              '--assign-ink': inkOn(memberColor(assigningMember)),
            }"
          >
            <span class="assign-mapbar-msg">
              <template v-if="sweepFlash">{{ sweepFlash }}</template>
              <template v-else-if="lassoActive">
                {{ sweepMode === 'erase' ? 'Loop doors to take them back out' : 'Loop doors to add them' }}
              </template>
              <template v-else-if="streetTapActive">
                {{ sweepMode === 'erase' ? 'Tap a door to drop its street' : 'Tap a door to take its street' }}
              </template>
              <template v-else>{{ memberName(assigningMember) }}</template>
            </span>
            <strong class="assign-mapbar-count">{{ assignSelected.size }}</strong>
            <button class="btn btn-sm btn-primary" :disabled="assignSaving" @click="saveAssignment">
              {{ assignSaving ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn btn-sm assign-mapbar-cancel" :disabled="assignSaving" @click="cancelAssign">
              ✕
            </button>
          </div>
          <!-- Flip every pin between a colored dot and its house number —
               the same control Scout and the turf cutter carry, top-left
               above the layer toggle. -->
          <div class="pin-mode-toggle" role="group" aria-label="Pin style">
            <button
              type="button"
              class="pin-mode-btn"
              :class="{ active: pinMode === 'dots' }"
              :aria-pressed="pinMode === 'dots'"
              aria-label="Show pins as dots"
              title="Dots"
              @click="setPinMode('dots')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="12" cy="12" r="6" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              class="pin-mode-btn"
              :class="{ active: pinMode === 'numbers' }"
              :aria-pressed="pinMode === 'numbers'"
              aria-label="Show pins as house numbers"
              title="House numbers"
              @click="setPinMode('numbers')"
            >
              123
            </button>
          </div>
          <!-- Fullscreen, top-right corner — same control as Scout and the
               cutter. On a phone the page chrome eats most of the map. -->
          <button
            type="button"
            class="map-fullscreen-btn"
            :aria-label="isFullscreen ? 'Exit fullscreen map' : 'View map fullscreen'"
            title="Fullscreen"
            @click="toggleFullscreen"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <template v-if="isFullscreen">
                <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </template>
              <template v-else>
                <path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </template>
            </svg>
          </button>
          <!-- Undo, left column under the layer buttons — the turf cutter's
               slot exactly (third row down), so the two maps' chrome reads
               the same. Last in the column on purpose: appearing never
               shifts another control. -->
          <button
            v-if="assigningMemberId && canUndoAssign"
            type="button"
            class="map-undo-btn"
            :disabled="assignSaving"
            aria-label="Undo the last change to this pile"
            title="Undo"
            @click="undoAssign"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M9 14 4 9l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <!-- Right column, second row — the cutter's exact slot for the same
               two tools (2026-07-25, user call: "identical to the way it is
               on the turf cutter"). While either is armed, Add/Erase says
               what it does. -->
          <div v-if="assigningMemberId" class="lasso-toggle">
            <button
              type="button"
              class="layer-btn"
              :class="{ active: lassoActive }"
              :aria-pressed="lassoActive"
              title="Draw a loop to take every door inside it"
              @click="toggleLasso"
            >
              ◯ Lasso
            </button>
            <button
              type="button"
              class="layer-btn"
              :class="{ active: streetTapActive }"
              :aria-pressed="streetTapActive"
              title="Tap a door to take its whole street"
              @click="toggleStreetTap"
            >
              ☝ Streets
            </button>
          </div>
          <!-- Add/Erase gets its OWN row under the tools rather than growing
               that one leftward — four buttons wide, the group reached
               across the map and sat on top of the layer buttons on the
               left (2026-07-25). -->
          <div v-if="assigningMemberId && (lassoActive || streetTapActive)" class="sweep-mode-toggle">
            <button
              type="button"
              class="layer-btn"
              :class="{ active: sweepMode === 'add' }"
              :aria-pressed="sweepMode === 'add'"
              title="Add the sweep to this member's doors"
              @click="sweepMode = 'add'"
            >
              Add
            </button>
            <button
              type="button"
              class="layer-btn lasso-erase"
              :class="{ active: sweepMode === 'erase' }"
              :aria-pressed="sweepMode === 'erase'"
              title="Take the sweep back out of this member's doors"
              @click="sweepMode = 'erase'"
            >
              Erase
            </button>
          </div>
          <!-- The same slot when nobody's pile is open: the way IN to
               assigning, on the map itself rather than only behind tapping a
               person. -->
          <button
            v-if="canAssign && !assigningMemberId"
            type="button"
            class="layer-btn map-assign-btn"
            data-help="squad-assign"
            :title="claimSelfOnly ? 'Pick the doors you\'re taking' : 'Pick doors for someone on the crew'"
            @click="startAssignFromMap"
          >
            ✎ {{ claimSelfOnly ? 'Claim doors' : 'Assign doors' }}
          </button>
          <!-- Turf layer — a FILTER, not a coloring: show only the crew's
               ground (and fly to it), show the whole campaign's cut with
               every turf in its own color, or (tap the active button again)
               every door we know on plain status pins. Who owns what is the
               separate "Our doors" switch below. -->
          <div class="layer-toggle" role="group" aria-label="Turf layer" data-help="squad-layers">
            <button
              type="button"
              class="layer-btn"
              :class="{ active: turfShade === 'mine' }"
              :aria-pressed="turfShade === 'mine'"
              title="Show only our squad's doors, and go there"
              @click="setTurfShade('mine')"
            >
              Our turf
            </button>
            <button
              type="button"
              class="layer-btn"
              :class="{ active: turfShade === 'all' }"
              :aria-pressed="turfShade === 'all'"
              :disabled="orgLoading"
              title="Show every turf in the campaign, each in its own color"
              @click="setTurfShade('all')"
            >
              {{ orgLoading ? 'Loading…' : 'All turf' }}
            </button>
          </div>
          <!-- Who has what: each door ringed in its owner's own color, their
               face in the middle where nobody has knocked yet today. Its own
               switch so it composes with the filter above — and assign mode
               shows it regardless. -->
          <button
            type="button"
            class="layer-btn owner-layer-btn"
            data-help="squad-owners"
            :class="{ active: ownerLayer || !!assigningMemberId }"
            :aria-pressed="ownerLayer || !!assigningMemberId"
            :disabled="!!assigningMemberId"
            :title="
              assigningMemberId
                ? 'On while you\'re picking doors'
                : 'Color each door by who it\'s assigned to'
            "
            @click="toggleOwnerLayer"
          >
            Our doors
          </button>
        </div>
      </div>

      <!-- Turf progress, under the map -->
      <div class="card progress-card" data-help="squad-progress">
        <template v-if="squadTurfs.length">
          <div class="progress-row">
            <strong>Our turf</strong>
            <span class="progress-count">
              <strong>{{ doorsKnocked }}</strong> of {{ doorsTotal }} doors
              <template v-if="progressScope === 'today'">knocked today</template>
              <template v-else>ever knocked</template>
              <span class="muted">({{ progressPct }}%)</span>
            </span>
          </div>
          <div class="progress-track" role="progressbar" :aria-valuenow="doorsKnocked" :aria-valuemin="0" :aria-valuemax="doorsTotal">
            <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
          </div>
          <!-- The turf is a day's work, so the bar is today's work. "All
               time" answers the other question — has any door never been
               reached at all. -->
          <div class="scope-toggle" role="group" aria-label="Count doors">
            <button
              type="button"
              class="scope-btn"
              :class="{ active: progressScope === 'today' }"
              :aria-pressed="progressScope === 'today'"
              @click="progressScope = 'today'"
            >
              Today
            </button>
            <button
              type="button"
              class="scope-btn"
              :class="{ active: progressScope === 'all' }"
              :aria-pressed="progressScope === 'all'"
              @click="progressScope = 'all'"
            >
              All time
            </button>
          </div>
          <div class="turf-chips">
            <button v-for="t in squadTurfs" :key="t.id" class="turf-chip" @click="focusTurf(t.id)">
              <span class="turf-dot" :style="{ background: t.color }"></span>{{ t.name }}
            </button>
          </div>

          <!-- Our doors: the same colors the map paints, counted out. The bar
               above says how far along the crew is; this says how it's
               going. Closed by default — it's a check-in, not the point of
               the page. -->
          <button
            type="button"
            class="rundown-toggle"
            :aria-expanded="rundownOpen"
            @click="rundownOpen = !rundownOpen"
          >
            <span class="rundown-caret" :class="{ open: rundownOpen }" aria-hidden="true">›</span>
            Our doors
          </button>
          <ul v-if="rundownOpen" class="rundown">
            <li v-for="r in doorRundown" :key="r.key" class="rundown-row">
              <span
                class="rundown-dot"
                :style="{ background: r.color, boxShadow: r.band ? `inset 0 0 0 3px ${r.band}` : undefined }"
                aria-hidden="true"
              ></span>
              <span class="rundown-label">{{ r.label }}</span>
              <span class="rundown-track" aria-hidden="true">
                <span class="rundown-fill" :style="{ width: rundownPct(r.count) + '%', background: r.color }"></span>
              </span>
              <span class="rundown-count">{{ r.count }}</span>
            </li>
          </ul>
        </template>
        <p v-else-if="!dashboardLoading" class="muted no-turf">
          No turf assigned to your squad yet today.
        </p>

        <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      </div>

      <!-- Member cards: ONE tap target each (2026-07-24, user call). Tapping
           the person opens their sheet, and the buttons — profile, call,
           assign, show on map — live there. A tile half a phone wide can't
           carry a button row and still show anything worth reading. -->
      <div class="member-grid" data-help="squad-members">
        <button
          v-for="(m, i) in orderedMembers"
          :key="m.id"
          v-motion="fadeUp(Math.min(i, 8) * 45)"
          type="button"
          class="member-card"
          :class="{ selected: selectedMemberId === m.id, assigning: assigningMemberId === m.id }"
          :style="{
            '--member-color': memberColor(m),
          }"
          :aria-label="`Open ${memberName(m)}`"
          @click="openMemberSheet(m.id)"
        >
          <span class="member-top">
            <span class="member-avatar" :style="!avatarUrl(m.avatar) ? { background: memberColor(m) } : {}">
              <img v-if="avatarUrl(m.avatar)" :src="avatarUrl(m.avatar)" alt="" />
              <template v-else>{{ memberName(m).slice(0, 1).toUpperCase() }}</template>
            </span>
            <span class="member-id">
              <span class="member-name">
                {{ memberName(m) }}
                <span v-if="m.id === auth.profile?.id" class="muted you-tag">(you)</span>
              </span>
              <span v-if="memberRoleLabel(m)" class="member-sub">
                <span class="role-chip">{{ memberRoleLabel(m) }}</span>
              </span>
            </span>
            <span v-if="squadTurfs.length" class="member-count" title="Turf doors knocked">
              {{ knockedCount(m.id) }}
            </span>
          </span>

          <!-- Their last few doors TODAY — the squad is one day long, so
               that's all a card ever shows. -->
          <span class="recent-block">
            <span v-if="recentByMember.get(m.id)?.length" class="recent-list">
              <span v-for="r in recentByMember.get(m.id)" :key="r.addressId" class="recent-item">
                <span class="recent-street">{{ prettyStreet(r.street) }}</span>
                <span class="recent-time muted">{{ knockTime(r.occurredAt) }}</span>
              </span>
            </span>
            <span v-else class="muted no-knocks">No doors yet today.</span>
          </span>

          <span v-if="assigningMemberId === m.id" class="picking-tag">Picking doors…</span>
        </button>

        <!-- Same size and shape as a person, because it's the same question:
             who's out with us. Managers can pull someone off another crew;
             everyone else adds people who aren't out yet. -->
        <button
          v-if="canManageRoster"
          type="button"
          class="member-card add-card"
          data-help="squad-add"
          @click="addMembersOpen = true"
        >
          <span class="add-mark" aria-hidden="true">+</span>
          <span class="add-label">Add someone</span>
        </button>
      </div>

      <!-- Sharing where you are, with this crew only. Off unless you switch
           it on, and it stops the moment the app isn't in front — the label
           says the tier, the map says the age. -->
      <div class="share-card" data-help="squad-share">
        <button
          type="button"
          class="share-btn"
          :class="{ on: sharing }"
          :aria-pressed="sharing"
          :disabled="shareBusy"
          @click="toggleSharing"
        >
          <span class="share-box" aria-hidden="true">{{ sharing ? '✓' : '' }}</span>
          <span>Share my location with the squad</span>
        </button>
        <div v-if="sharing" class="tier-row" role="group" aria-label="Update rate">
          <button
            v-for="(spec, key) in LOCATION_TIERS"
            :key="key"
            type="button"
            class="tier"
            :class="{ on: tier === key }"
            @click="setTier(key as LocationTier)"
          >
            {{ spec.label }}
          </button>
        </div>
        <p v-if="shareError" class="error share-err">{{ shareError }}</p>
        <p v-else-if="sharing" class="muted share-note">Only while this app is open.</p>
      </div>

      <!-- The day switch, last thing on the page (2026-07-24, user call):
           one button, one label, no explaining. Squad leaders, campaign
           managers, admins and whoever started the crew can flip it; it dies
           with the squad at midnight. -->
      <button
        v-if="canToggleClaim"
        type="button"
        class="claim-btn"
        data-help="squad-claim"
        :class="{ on: memberClaimOn }"
        :aria-pressed="memberClaimOn"
        :disabled="claimSaving"
        @click="toggleMemberClaim"
      >
        Squad members claim their own doors
      </button>
    </div>

    <p v-else class="muted">Loading your squad…</p>

    <!-- One member's whole run — the card's last-five, opened out. -->
    <BottomSheet
      v-model:open="sheetOpen"
      :aria-label="sheetMember ? `${memberName(sheetMember)}’s knocks` : 'Member'"
    >
      <template #header>
        <div v-if="sheetMember" class="sheet-head" :style="{ '--member-color': memberColor(sheetMember) }">
          <span
            class="member-avatar"
            :style="!avatarUrl(sheetMember.avatar) ? { background: memberColor(sheetMember) } : {}"
          >
            <img v-if="avatarUrl(sheetMember.avatar)" :src="avatarUrl(sheetMember.avatar)" alt="" />
            <template v-else>{{ memberName(sheetMember).slice(0, 1).toUpperCase() }}</template>
          </span>
          <span class="sheet-id">
            <strong>{{ memberName(sheetMember) }}</strong>
            <span class="muted sheet-sub">
              {{ memberRoleLabel(sheetMember) ?? 'Canvasser' }}
              <template v-if="squadTurfs.length"> · {{ knockedCount(sheetMember.id) }} of our doors</template>
            </span>
          </span>
        </div>
      </template>

      <div v-if="sheetMember" class="sheet-body">
        <div class="sheet-actions">
          <button
            v-if="canAssignTo(sheetMember.id)"
            class="btn btn-sm btn-primary"
            @click="assignFromSheet"
          >
            {{ assignVerb(sheetMember.id) }}
          </button>
          <button class="btn btn-sm ghost-btn" @click="openMemberProfile(sheetMember.id)">
            View profile
          </button>
          <button
            v-if="latestGeo(sheetMember.id)"
            class="btn btn-sm ghost-btn"
            @click="showMemberOnMap"
          >
            Show on map
          </button>
          <a
            v-if="sheetMember.phone && sheetMember.id !== auth.profile?.id"
            class="btn btn-sm ghost-btn"
            :href="telHref(sheetMember.phone)"
          >
            Call
          </a>
          <!-- The undo for adding someone. Your own way off the crew is the
               Leave button up top, so this never points at you. -->
          <button
            v-if="canManageRoster && sheetMember.id !== auth.profile?.id"
            class="btn btn-sm ghost-btn remove-btn"
            :disabled="removingMemberId === sheetMember.id"
            @click="removeFromSquad(sheetMember.id)"
          >
            {{ removingMemberId === sheetMember.id ? 'Removing…' : 'Remove from squad' }}
          </button>
        </div>

        <p v-if="sheetLoading" class="muted">Loading their knocks…</p>
        <p v-else-if="!sheetFeed.length" class="muted">No doors knocked today.</p>
        <ul v-else class="feed-list">
          <li v-for="row in sheetFeed" :key="row.id">
            <button
              type="button"
              class="feed-row"
              :disabled="!row.addressId"
              :style="outcomeRowTint(OUTCOME_HEX[row.outcome])"
              @click="openFeedDoor(row)"
            >
              <OutcomeSquare :fill="OUTCOME_HEX[row.outcome]" />
              <span class="feed-main">
                <span class="feed-street">{{ prettyStreet(row.street) || 'Door' }}</span>
                <span class="muted feed-meta">
                  {{ OUTCOME_SHORT[row.outcome] }}<template v-if="row.person"> · {{ row.person }}</template>
                </span>
              </span>
              <span class="muted feed-time">{{ feedStamp(row.occurredAt) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </BottomSheet>

    <!-- New squad sheet (no-squad state) -->
    <!-- Who are these doors for? Only reachable from the map's own "Assign
         doors" button — tapping a person still opens their sheet, and Assign
         is still in there too. -->
    <BottomSheet v-model:open="assignPickerOpen" title="Assign doors" aria-label="Pick who gets doors">
      <p class="muted pick-hint">Who are these doors for?</p>
      <ul class="pick-list">
        <li v-for="m in assignableMembers" :key="m.id">
          <button
            type="button"
            class="pick-row"
            :style="{ '--member-color': memberColor(m) }"
            @click="assignPickerOpen = false; startAssign(m.id)"
          >
            <span class="member-avatar" :style="!avatarUrl(m.avatar) ? { background: memberColor(m) } : {}">
              <img v-if="avatarUrl(m.avatar)" :src="avatarUrl(m.avatar)" alt="" />
              <template v-else>{{ memberName(m).slice(0, 1).toUpperCase() }}</template>
            </span>
            <span class="pick-id">
              <strong>
                {{ memberName(m) }}
                <span v-if="m.id === auth.profile?.id" class="muted you-tag">(you)</span>
              </strong>
              <span class="muted pick-sub">{{ memberRoleLabel(m) ?? 'Canvasser' }}</span>
            </span>
            <span class="pick-go" aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
    </BottomSheet>

    <!-- Adding people to this crew (leaders, the crew's creator, managers). -->
    <AddMembersSheet v-model:open="addMembersOpen" :squad="mySquad" :can-move="isManagerRole" />

    <BottomSheet v-model:open="composing" title="New squad" aria-label="New squad">
      <div class="field">
        <label for="squad-name">Squad name</label>
        <input id="squad-name" v-model="squadName" placeholder="e.g. Richwood crew" />
      </div>
      <UserPicker v-model="picked" />
      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <button
        class="btn btn-primary btn-block big-btn"
        :disabled="creating || !squadName.trim()"
        @click="createSquad"
      >
        {{ creating ? 'Creating…' : 'Create squad' }}
      </button>
    </BottomSheet>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.intro {
  margin: 0;
  font-size: 0.92rem;
}

.big-btn {
  min-height: 56px;
  font-size: 1.05rem;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0;
  font-size: 0.9rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

/* --- No-squad join list --- */

.join-heading {
  margin: 0.4rem 0 0;
  font-size: 0.92rem;
}

.join-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.join-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.join-name {
  font-weight: 700;
}

.join-members {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- Header --- */

.squad-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.squad-title h2 {
  margin: 0;
  font-size: 1.25rem;
}

.squad-title .muted {
  font-size: 0.85rem;
}

.squad-actions {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-shrink: 0;
}

.squad-switch {
  max-width: 150px;
}

/* --- Progress --- */

.progress-card {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.progress-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.progress-count {
  font-size: 0.95rem;
}

.progress-track {
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.4s ease;
}

.turf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.scope-toggle {
  align-self: flex-start;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}

.scope-btn {
  padding: 0.2rem 0.6rem;
  border: none;
  background: var(--surface);
  color: var(--muted, inherit);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.scope-btn.active {
  background: var(--accent);
  color: var(--accent-contrast);
}

.assign-flash {
  font-weight: 600;
  opacity: 0.85;
}

.rundown-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.15rem 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.rundown-caret {
  display: inline-block;
  transition: transform 0.15s ease;
}

.rundown-caret.open {
  transform: rotate(90deg);
}

.rundown {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.rundown-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.rundown-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.rundown-label {
  flex-shrink: 0;
  min-width: 8.5rem;
}

.rundown-track {
  flex: 1;
  min-width: 2rem;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.rundown-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
}

.rundown-count {
  flex-shrink: 0;
  min-width: 2.5rem;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.turf-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font: inherit;
  font-size: 0.82rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.turf-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.no-turf {
  margin: 0;
  font-size: 0.9rem;
}

/* --- Location sharing: the switch, its tiers, and an honest note. --- */

.share-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.share-btn {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 700;
  text-align: left;
  cursor: pointer;
}

.share-box {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 2px solid currentColor;
  border-radius: 4px;
  font-size: 0.85rem;
  line-height: 1;
}

.share-btn.on {
  color: var(--accent);
}

.share-btn.on .share-box {
  background: var(--accent);
  color: var(--accent-contrast);
}

.tier-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.tier {
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.tier.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  color: var(--accent);
}

.share-note,
.share-err {
  margin: 0;
  font-size: 0.78rem;
}

/* --- "Squad members claim their own doors": one button, bottom of the page.
   Pressed = on. No hint copy — the label is the whole explanation. --- */

.claim-btn {
  width: 100%;
  min-height: 44px;
  padding: 0.6rem 0.9rem;
  font: inherit;
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.claim-btn.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.claim-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* --- Map --- */

.map-card {
  padding: 0;
  overflow: hidden;
}

.squad-map-wrap {
  position: relative;
}

.squad-map {
  width: 100%;
  height: min(52vh, 420px);
  min-height: 260px;
}

.map-wrap-fullscreen {
  background: #000;
}

.map-wrap-fullscreen .squad-map {
  height: 100%;
  border-radius: 0;
  border: none;
}

/* Map chrome, identical to Scout and the turf cutter: LEFT column = pin
   style then layers; RIGHT = fullscreen. */
.pin-mode-toggle {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.pin-mode-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: calc(0.8rem * var(--ui-scale, 1));
  font-weight: 700;
  cursor: pointer;
}

.pin-mode-btn + .pin-mode-btn {
  border-left: 1px solid var(--border);
}

.pin-mode-btn.active {
  background: var(--accent);
  color: #fff;
}

.pin-mode-btn:not(.active):hover {
  background: var(--surface-2);
}

.map-fullscreen-btn {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.map-fullscreen-btn:hover {
  background: var(--surface-2);
}

.layer-toggle {
  position: absolute;
  top: calc(0.6rem + 36px + 0.5rem);
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.layer-btn {
  min-height: 36px;
  padding: 0 0.6rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: calc(0.78rem * var(--ui-scale, 1));
  font-weight: 700;
  cursor: pointer;
  /* Shrink, then ellipsize — never grow into the column opposite. */
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Nothing in the map chrome may collide: each column gets half the map
   minus its gutter. This is what the 4-wide sweep row broke — anchored
   right, it reached back across and sat on the layer buttons. */
.pin-mode-toggle,
.layer-toggle,
.owner-layer-btn,
.lasso-toggle,
.sweep-mode-toggle,
.map-assign-btn {
  max-width: calc(50% - 0.9rem);
}

/* Phone width is the tight case: two ~150px groups plus gutters is the
   whole screen. Tighter padding and a hair smaller type buys ~45px. */
/* …and inside the 430px desktop phone frame (style.css). */
@media (max-width: 520px), (min-width: 820px) {
  .layer-btn {
    padding: 0 0.4rem;
    font-size: calc(0.72rem * var(--ui-scale, 1));
  }
}

.layer-btn + .layer-btn {
  border-left: 1px solid var(--border);
}

.layer-btn.active {
  background: var(--accent);
  color: #fff;
}

.layer-btn:not(.active):hover {
  background: var(--surface-2);
}

.map-error {
  padding: 1rem;
}

/* Sweep tools, top-right under the fullscreen button — same chrome as the
   layer buttons, same spot the turf cutter puts them. */
/* Right column, second row — shared by the sweep tools and, when no pile is
   open, the button that opens one. Same coordinates and same segmented look
   as the turf cutter's .lasso-toggle, on purpose. */
.lasso-toggle,
.map-assign-btn {
  position: absolute;
  top: calc(0.6rem + 36px + 0.5rem);
  right: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

/* The label is this button's only child, so it has to be centered in the
   36px box — left to `stretch` it sat at the top with a blank strip under
   it (the group next door has real children and doesn't have the problem). */
.map-assign-btn {
  align-items: center;
  justify-content: center;
}

.lasso-erase.active {
  background: #d64545;
  color: #fff;
}

/* Right column, third row — Add/Erase sits UNDER the tools rather than
   beside them. Four buttons on one right-anchored row grew back across the
   map and covered the layer buttons on the left. */
.sweep-mode-toggle {
  position: absolute;
  top: calc(0.6rem + 2 * (36px + 0.5rem));
  right: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

/* Left column, third row — the ownership switch, under the turf filter it
   composes with. */
.owner-layer-btn {
  position: absolute;
  top: calc(0.6rem + 2 * (36px + 0.5rem));
  left: 0.6rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

/* Left column, FOURTH row — Undo lands under the ownership switch (the
   cutter's third-row slot, one down, since this map has one more layer
   button). Last in the column on purpose: appearing never shifts another
   control. */
.map-undo-btn {
  position: absolute;
  top: calc(0.6rem + 3 * (36px + 0.5rem));
  left: 0.6rem;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.map-undo-btn:hover:not(:disabled) {
  background: var(--surface-2, var(--surface));
}

.map-undo-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* The lasso capture surface sits over the whole map while armed — it takes
   the pointer, which is why the map is frozen underneath it. */
.lasso-layer {
  position: absolute;
  inset: 0;
  z-index: 5;
  touch-action: none;
  cursor: crosshair;
  overflow: hidden;
}

.lasso-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* Above the lasso surface (z-index 5) on purpose — Save has to stay
   reachable while a tool is armed. */
.assign-mapbar {
  position: absolute;
  left: 0.6rem;
  right: 0.6rem;
  bottom: 0.6rem;
  margin: 0 auto;
  max-width: 32rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.4rem 0.35rem 0.7rem;
  border-radius: 999px;
  background: rgba(17, 20, 30, 0.9);
  color: #fff;
  font-size: 0.78rem;
  font-weight: 600;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  z-index: 7;
}

.assign-mapbar-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assign-mapbar-count {
  flex-shrink: 0;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--assign-color, #fff);
  color: var(--assign-ink, #111);
  font-variant-numeric: tabular-nums;
}

.assign-mapbar .btn {
  flex-shrink: 0;
  min-height: 30px;
  padding: 0.2rem 0.6rem;
  font-size: 0.76rem;
}

.assign-mapbar-cancel {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: #fff;
}

/* --- Assign mode --- */

.assign-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border);
  border-left: 6px solid var(--assign-color);
  background: color-mix(in srgb, var(--assign-color) 8%, var(--surface));
}

.assign-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--assign-color);
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.4);
}

.assign-text {
  margin: 0;
  flex: 1;
  min-width: 12rem;
  font-size: 0.88rem;
}

.assign-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.assign-error {
  width: 100%;
}

.assign-count {
  white-space: nowrap;
}

/* Sheet buttons (the card has none of its own anymore). */
.ghost-btn {
  border: 1.5px solid var(--border);
  color: var(--text);
  background: transparent;
  font-weight: 700;
  text-decoration: none;
}

/* --- Member cards --- */

/* Two per row, always — the crew reads as a grid of squares people snap
   into, not a column of stacked strips (user call, 2026-07-24). Phones get
   exactly two; wide screens widen to four rather than growing the tiles into
   billboards. The aspect ratio is a FLOOR, not a fixed height: a long name or
   a five-door list is allowed to push the tile taller rather than clip. */
.member-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

/* No 4-up variant any more (2026-07-26): a window wide enough for it draws
   the app in a 430px phone column instead (style.css, the frame block), so
   the wide grid could only ever fire on a screen that no longer stretches. */

/* Square tiles. Grid items keep `min-height: auto`, so a long name or a full
   five-door list still pushes the tile taller instead of being clipped —
   aspect-ratio is the floor, not a cage. */
.member-card {
  aspect-ratio: 1 / 1;
}

.member-card {
  font: inherit;
  color: var(--text);
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.7rem;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--member-color) 7%, var(--surface));
  border: 2px solid color-mix(in srgb, var(--member-color) 45%, var(--border));
  border-left: 6px solid var(--member-color);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  /* The tile is a <button> now: browsers' UA styles center a button's flex
     children and clamp its wrapping, both wrong for a card. */
  align-items: stretch;
  white-space: normal;
}

.member-card:hover .member-name {
  text-decoration: underline;
}

/* A person-shaped hole in the grid: same tile, no accent, dashed so it reads
   as a slot rather than as somebody who's already here. */
.add-card {
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  background: transparent;
  border: 2px dashed var(--border);
  border-left: 2px dashed var(--border);
  color: var(--text-muted);
  font-weight: 700;
}

.add-card:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.add-mark {
  font-size: 1.8rem;
  line-height: 1;
}

.add-label {
  font-size: 0.9rem;
}

/* Taking someone off the crew is a real edit — flag it, don't hide it. */
.remove-btn {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}

/* The card being picked for right now says so where the button used to be. */
.picking-tag {
  margin-top: auto;
  font-size: 0.74rem;
  font-weight: 800;
  color: var(--member-color);
}

.member-card.selected {
  border-color: var(--member-color);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--member-color) 35%, transparent);
}

/* The whole tile is one button now (2026-07-24) — header and recent list are
   plain spans inside it, and every action lives in the sheet it opens. */
.member-top {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  width: 100%;
}

.member-id {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.member-sub {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.76rem;
  min-width: 0;
}

.member-sub .muted {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-chip {
  flex-shrink: 0;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-weight: 700;
  font-size: 0.7rem;
  background: color-mix(in srgb, var(--member-color) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--member-color) 50%, transparent);
}

.recent-block {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
  padding: 0.4rem 0.45rem;
  border: 1px dashed color-mix(in srgb, var(--member-color) 40%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}

.member-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2.5px solid var(--member-color);
  background: var(--surface);
  color: #fff;
  font-weight: 800;
  overflow: hidden;
}

.member-avatar img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 2px;
}

.member-name {
  font-weight: 700;
  font-size: 0.9rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.you-tag {
  font-weight: 500;
  font-size: 0.75rem;
}

.member-count {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 1.9em;
  text-align: center;
  font-weight: 800;
  font-size: 0.85rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: var(--member-color);
  color: #fff;
}

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.recent-item {
  display: flex;
  justify-content: space-between;
  gap: 0.4rem;
  font-size: 0.74rem;
  line-height: 1.35;
  min-width: 0;
}

.recent-street {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.no-knocks {
  margin: 0;
  font-size: 0.8rem;
}

/* --- Member sheet: the full run --- */

.sheet-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}

.sheet-id {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.sheet-sub {
  font-size: 0.8rem;
}

.sheet-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.sheet-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.pick-hint {
  margin: 0 0 0.6rem;
  font-size: 0.85rem;
}

.pick-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.pick-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid var(--border);
  border-left: 4px solid var(--member-color, var(--border));
  border-radius: 10px;
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pick-row:hover {
  border-color: var(--member-color, var(--border));
}

.pick-id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pick-sub {
  font-size: 0.78rem;
}

.pick-go {
  flex-shrink: 0;
  opacity: 0.5;
  font-size: 1.1rem;
}

.feed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

/* Square, and the outcome washed across the line (2026-07-26, user call):
 * this sheet is "what did they get through today", and the answer is the
 * shape of the colors down it. */
.feed-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  background: var(--row-tint, none);
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.4rem;
  cursor: pointer;
}

.feed-row:disabled {
  cursor: default;
}

.feed-row:not(:disabled):hover {
  background: var(--row-tint-hover, var(--surface-2));
}

.feed-main {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
  flex: 1;
}

.feed-street {
  font-weight: 600;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feed-meta {
  font-size: 0.78rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feed-time {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

</style>

<style>
/* Marker content lives outside this component's scope (Google injects it
 * into the map pane), so its styles are global. */
.member-marker {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}

.member-marker img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 2px;
  background: #fff;
}

.member-marker.selected {
  transform: scale(1.25);
}

/* Live position vs. last knocked door. The halo says a fresh ping is driving
   this pin; the fade says the phone has been away a while. Both matter,
   because on the web sharing only runs while the app is in front — a pin that
   looked identical either way would be the feature quietly lying. */
.member-marker.live {
  box-shadow:
    0 0 0 3px rgba(255, 255, 255, 0.9),
    0 0 0 6px rgba(47, 191, 113, 0.85),
    0 2px 8px rgba(0, 0, 0, 0.35);
}

.member-marker.live.stale {
  opacity: 0.55;
  box-shadow:
    0 0 0 3px rgba(255, 255, 255, 0.8),
    0 0 0 6px rgba(138, 144, 165, 0.8),
    0 2px 8px rgba(0, 0, 0, 0.3);
}
/* The assign-mode walk-anchor pulse used to be a CSS keyframe on marker
   content; it's drawn on the door canvas now (DoorPaintState.pulse). */
</style>
