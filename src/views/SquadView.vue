<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { fadeUp } from '@/lib/motion'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  readPinMode,
  readTurfShadeMode,
  writePinMode,
  writeTurfShadeMode,
} from '@/lib/mapLayers'
import type { PinMode, TurfShadeMode } from '@/lib/mapLayers'
import { DoorCanvasLayer, PINS_MIN_ZOOM } from '@/lib/doorCanvas'
import type { CanvasDoor, DoorBadge, DoorPaintState } from '@/lib/doorCanvas'
import { rangeCovers, walkRanges } from '@/lib/doorPath'
import {
  OUTCOME_HEX,
  OUTCOME_LABELS,
  PIN_DEFAULT_HEX,
  doorPartlySigned,
  doorStatusOutcome,
} from '@/lib/outcomes'
import { avatarUrl } from '@/lib/avatars'
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

// --- Which squad is "mine" (you can be in several crews in one day) ---

const selectedSquadId = ref<string | null>(null)
// /squad?squad=<id> (the Squads page's "Open" button) picks that squad when
// you're in several; an id that isn't yours falls back to your first squad.
if (typeof route.query.squad === 'string') selectedSquadId.value = route.query.squad
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
const doorsKnocked = computed(() => knockedDoors.value.size)

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
    // Last doors each member touched — anywhere, not just in turf, so the
    // card always answers "where are they right now". Overfetch then dedupe
    // (re-knocking the same door shouldn't eat the whole list).
    ...memberIds.map((id) =>
      supabase
        .from('knock_logs')
        .select('occurred_at, addresses!inner(id, street, lat, lng)')
        .eq('canvasser_id', id)
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

  // Stored pref was "All turf": pull the campaign-wide set once, then repaint
  // with it. Guarded, so repeated applyMapData calls don't refetch.
  if (turfShade.value === 'all' && !orgDoorsLoaded) {
    void ensureOrgDoors().then(() => applyDoorPins())
  }
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
// ring. "Our turf" rings the crew's doors; "All turf" additionally paints
// every other turf's doors, each in its own turf's color; tapping the active
// button turns the rings off and leaves plain status pins. Its OWN pref key
// (defaulting to the crew's turf) because a plain squad-page load must never
// pay for the org-wide download, which "All turf" fetches on first use. ---

// 'doors' is Scout's fourth state and this map has no button for it; a value
// that somehow lands under this key reads as the crew's turf rather than
// leaving both buttons dark.
const storedShade = readTurfShadeMode('squad-turf-shading', 'mine')
const turfShade = ref<TurfShadeMode>(storedShade === 'doors' ? 'mine' : storedShade)
/** Every turf row, unfiltered — "All turf" paints from these. */
const allTurfList = ref<TurfLite[]>([])

interface OrgDoor {
  id: string
  street: string
  lat: number
  lng: number
  turf_id: string
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

async function ensureOrgDoors(): Promise<void> {
  if (orgDoorsLoaded) return
  if (!orgDoorsLoading) {
    orgLoading.value = true
    orgDoorsLoading = Promise.all([
      fetchAllRows<OrgDoor>((from, to) =>
        supabase
          .from('addresses')
          .select('id, street, lat, lng, turf_id')
          .not('turf_id', 'is', null)
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
        orgLoading.value = false
      })
  }
  await orgDoorsLoading
}

async function setTurfShade(mode: 'mine' | 'all') {
  turfShade.value = turfShade.value === mode ? 'off' : mode
  writeTurfShadeMode('squad-turf-shading', turfShade.value)
  if (turfShade.value === 'all') await ensureOrgDoors()
  applyDoorPins()
}

/** Turf color by id across the WHOLE campaign, not just the crew's turfs —
 * "All turf" rings other crews' doors in their own colors. */
const anyTurfColorById = computed(() => new Map(allTurfList.value.map((t) => [t.id, t.color])))

/** Avatar bitmaps for the today-knocker badge, by slug. Images decode async
 * — the canvas repaints when one lands; until then the door shows the
 * member's initial on their own color. */
const badgeImgCache = new Map<string, HTMLImageElement>()
function badgeImage(slug: string | null | undefined): HTMLImageElement | null {
  const url = avatarUrl(slug)
  if (!slug || !url) return null
  let img = badgeImgCache.get(slug)
  if (!img) {
    img = new Image()
    img.onload = () => doorLayer?.requestRepaint()
    img.src = url
    badgeImgCache.set(slug, img)
  }
  return img
}

/** Paint state for one turf door — the Squad reading of the shared
 * three-band model (halo / membership ring / status fill):
 *
 * fill  = the door's knock STATUS, the exact colors Scout and the cutter use
 *         (doorStatusOutcome: green only when everyone signed, yellow partly
 *         signed, red closed-no, blue untouched).
 * ring  = the owning turf's own color — ONLY while the turf layer is on.
 *         This is what replaced the shaded areas: a door can only ever be in
 *         one turf, so rings can't overlap the way the polygons did.
 * badge = the squadmate who knocked this door TODAY — their animal avatar
 *         rides in the middle of the pin, so the map tells the story of who
 *         covered what as the day unfolds.
 *
 * ASSIGN MODE overrides most of that: doors in the pile take the member's
 * color, the walk anchor breathes (tap another door and the whole walk
 * between comes with it), doors the viewer can't hand out fade back, and the
 * avatars sit out — door-picking needs the selection legible, not decorated. */
function paintForDoor(id: string): DoorPaintState | null {
  const door = turfDoors.value.get(id)
  // Another crew's door, painted only while "All turf" is on. It gets its
  // turf's ring and its status, but none of the crew's own decoration — no
  // today-avatar, and it can never join an assignment.
  const foreign = door ? null : orgDoorsById.value.get(id)
  if (!door && !foreign) return null
  const turfId = door ? door.turf_id : foreign!.turf_id
  const status = statusByDoor.value.get(id) ?? orgStatusByDoor.value.get(id)
  const outcome = doorStatusOutcome(status?.outcome, status?.signed_count, status?.person_count)
  // Partly signed draws GREEN with a YELLOW band rather than plain yellow —
  // "one of the three signed" is progress with work left, and shouldn't look
  // identical to a door where nobody has signed at all.
  const partly = doorPartlySigned(status?.outcome, status?.signed_count, status?.person_count)
  const fill = partly ? OUTCOME_HEX.signed : outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX
  const innerRing = partly ? OUTCOME_HEX.maybe : null
  // Rings are the turf layer. Off = plain status pins, nothing else to read.
  const turfColor =
    turfShade.value === 'off' ? null : (anyTurfColorById.value.get(turfId) ?? null)

  const assignee = assigningMember.value
  if (assignee) {
    if (!door) return { fill, innerRing, ring: turfColor, emphasis: false, alpha: 0.35 }
    const picked = assignSelected.value.has(id)
    return {
      fill: picked ? memberColor(assignee) : fill,
      innerRing: picked ? null : innerRing,
      ring: picked ? '#ffffff' : turfColor,
      emphasis: picked,
      pulse: picked && id === assignAnchorId.value,
      alpha: !picked && poolParentOf(door) === null ? 0.35 : 1,
    }
  }

  if (!door) return { fill, innerRing, ring: turfColor, emphasis: false }

  const knocker = todayKnockerByDoor.value.get(id)
  const member = knocker ? memberById.value.get(knocker.canvasserId) : undefined
  let badge: DoorBadge | null = null
  if (member) {
    badge = {
      initial: memberName(member).slice(0, 1).toUpperCase(),
      img: badgeImage(member.avatar),
      color: memberColor(member),
    }
  }
  return {
    fill,
    // Coexists with the badge: the avatar owns the pin's middle, so the
    // partly-signed yellow strokes the rim instead of filling a band.
    innerRing,
    ring: turfColor,
    // Today's covered doors are the map's live story — they draw bigger and
    // above their plain neighbors.
    emphasis: !!badge,
    badge,
  }
}

/** Push doors onto the canvas layer: always the crew's own turf, plus — in
 * "All turf" — every other turf's doors in the campaign. There's no pin cap
 * to worry about, so "show me the whole cut" is just more doors in the same
 * one repaint. Idempotent: safe whenever the map or the data lands first. */
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
  if (turfShade.value === 'all') {
    for (const d of orgDoorsById.value.values()) {
      if (turfDoors.value.has(d.id)) continue
      canvasDoor(d.id, d.street, d.lat, d.lng)
    }
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

function latestGeo(memberId: string): RecentDoor | null {
  for (const r of recentByMember.value.get(memberId) ?? []) {
    if (r.lat != null && r.lng != null) return r
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
    existing.position = { lat: spot.lat!, lng: spot.lng! }
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
      position: { lat: spot.lat!, lng: spot.lng! },
      title: member.display_name || member.username,
      content: el,
      gmpClickable: true,
      zIndex: 500,
    })
    marker.addListener('gmp-click', () => selectMember(member.id, false))
    markersByMember.set(member.id, marker)
  }
  const marker = markersByMember.get(member.id)!
  const el = marker.content as HTMLElement
  el.classList.toggle('selected', selectedMemberId.value === member.id)
  marker.zIndex = selectedMemberId.value === member.id ? 1000 : 500
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

/** Tap a member (card or marker): zoom the map to the last door they
 * knocked. From a card we also bring the map into view — that's the point. */
function selectMember(memberId: string, scroll = true) {
  selectedMemberId.value = memberId
  for (const m of mySquad.value?.members ?? []) updateMemberMarker(m)
  const spot = latestGeo(memberId)
  if (map && spot) {
    map.panTo({ lat: spot.lat!, lng: spot.lng! })
    map.setZoom(17)
  }
  if (scroll) mapCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
/** The last door selected by tap — the start of a two-tap walk sweep. */
const assignAnchorId = ref<string | null>(null)
const assignSaving = ref(false)
const assignError = ref('')

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
    orgDoorsById,
    orgStatusByDoor,
    assigningMemberId,
    assignSelected,
    assignAnchorId,
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
    mapCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  assignAnchorId.value = null
  disarmTools()
  sweepFlash.value = ''
  mapCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function cancelAssign() {
  assigningMemberId.value = null
  assignSelected.value = new Set()
  assignAnchorId.value = null
  assignError.value = ''
  disarmTools()
  sweepFlash.value = ''
}

/** Tap an unselected door: it joins the pile and becomes the walk anchor.
 * Tap ANOTHER unselected door while one is anchored: every door along the
 * walk between them joins too (same street = the range between; different
 * streets = up the first street to the corner, then along the second).
 * Tap a selected door: just that door leaves the pile. */
function toggleAssignDoor(addressId: string) {
  const door = turfDoors.value.get(addressId)
  if (!door || poolParentOf(door) === null) return
  const next = new Set(assignSelected.value)

  if (next.has(addressId)) {
    next.delete(addressId)
    assignAnchorId.value = null
    assignSelected.value = next
    return
  }

  const anchor = assignAnchorId.value ? turfDoors.value.get(assignAnchorId.value) : null
  if (anchor && next.has(anchor.id) && anchor.id !== addressId) {
    const ranges = walkRanges(anchor, door, turfDoors.value.values())
    for (const d of turfDoors.value.values()) {
      if (next.has(d.id) || poolParentOf(d) === null) continue
      if (ranges.some((r) => rangeCovers(r, d))) next.add(d.id)
    }
    next.add(addressId)
    assignAnchorId.value = null
    assignSelected.value = next
    return
  }

  next.add(addressId)
  assignAnchorId.value = addressId
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
      flashSweep('Nothing of theirs there — Erase takes doors back out of the pile.')
      return
    }
    assignSelected.value = next
    assignAnchorId.value = null
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
        ? `${what}: nothing to take — ${skipped} door${skipped === 1 ? '' : 's'} belong to turf you can't divide.`
        : `${what}: those doors are already in the pile.`,
    )
    return
  }
  assignSelected.value = next
  assignAnchorId.value = null
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
    assignAnchorId.value = null
    disarmTools()
    sweepFlash.value = ''
    await loadDashboard()
  } catch {
    assignError.value = "Couldn't save that assignment — try again."
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

async function openMemberSheet(memberId: string) {
  sheetMemberId.value = memberId
  sheetFeed.value = []
  sheetLoading.value = true
  const seq = ++sheetSeq
  const { data } = await supabase
    .from('knock_logs')
    .select('id, outcome, occurred_at, household_id, person:persons(name), addresses(street, city)')
    .eq('canvasser_id', memberId)
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

onUnmounted(() => {
  squads.unsubscribeFromRosters()
  if (knockFeed) void supabase.removeChannel(knockFeed)
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
        You're not in a squad yet today — start one, or join a crew that's already out.
      </p>
      <button class="btn btn-primary big-btn" @click="openComposer">+ Start today's squad</button>
      <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      <p v-if="squads.squads.length" class="muted join-heading">…or join one that's out already:</p>
      <div v-for="(s, i) in squads.squads" :key="s.id" v-motion="fadeUp(Math.min(i, 8) * 45)" class="card join-card">
        <div class="join-info">
          <span class="join-name">👥 {{ s.name }}</span>
          <span class="muted join-members">
            {{ s.members.length }} member{{ s.members.length === 1 ? '' : 's' }} —
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
          <select
            v-if="squads.mySquads.length > 1"
            class="squad-switch"
            :value="mySquad.id"
            aria-label="Switch squad"
            @change="selectedSquadId = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="s in squads.mySquads" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <button v-if="mySquad.chat_id" class="btn btn-sm btn-primary" @click="openSquadChat">Chat</button>
          <button class="btn btn-sm btn-ghost" @click="leaveSquad">Leave</button>
        </div>
      </div>

      <!-- Turf progress -->
      <div class="card progress-card">
        <template v-if="squadTurfs.length">
          <div class="progress-row">
            <strong>Our turf</strong>
            <span class="progress-count">
              <strong>{{ doorsKnocked }}</strong> of {{ doorsTotal }} doors knocked
              <span class="muted">({{ progressPct }}%)</span>
            </span>
          </div>
          <div class="progress-track" role="progressbar" :aria-valuenow="doorsKnocked" :aria-valuemin="0" :aria-valuemax="doorsTotal">
            <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
          </div>
          <div class="turf-chips">
            <button v-for="t in squadTurfs" :key="t.id" class="turf-chip" @click="focusTurf(t.id)">
              <span class="turf-dot" :style="{ background: t.color }"></span>{{ t.name }}
            </button>
          </div>
        </template>
        <p v-else-if="!dashboardLoading" class="muted no-turf">
          No turf assigned to your squad yet today — your campaign manager sends turf out to
          each day's crews. The map still follows everyone's knocks meanwhile.
        </p>

        <!-- The leader's day switch: keep the dividing, or let the crew grab
             their own stretch. Off by default, and gone at midnight with the
             squad. Everyone else just sees the state as a note. -->
        <div v-if="canToggleClaim" class="claim-row">
          <label class="claim-switch">
            <input
              type="checkbox"
              :checked="memberClaimOn"
              :disabled="claimSaving"
              @change="toggleMemberClaim"
            />
            <span class="claim-track" aria-hidden="true"><span class="claim-knob"></span></span>
            <span class="claim-label">
              <strong>Crew claims their own doors</strong>
              <span class="muted claim-hint">
                {{
                  memberClaimOn
                    ? 'On — anyone on this crew can cut their own share out of the turf.'
                    : 'Off — you hand out the doors. Turn it on when it’s chaotic out there.'
                }}
              </span>
            </span>
          </label>
        </div>
        <p v-else-if="memberClaimOn && canAssign" class="muted claim-note">
          Your squad leader turned on <strong>crew claiming</strong> — pick your own doors on
          your card below, then flip Scout to “My doors”.
        </p>
        <p v-if="squads.actionError" class="error">{{ squads.actionError }}</p>
      </div>

      <!-- Map -->
      <div ref="mapCardEl" class="card map-card">
        <div
          v-if="assigningMember"
          class="assign-bar"
          :style="{ '--assign-color': memberColor(assigningMember) }"
        >
          <span class="assign-dot" aria-hidden="true"></span>
          <p class="assign-text">
            <template v-if="assigningMemberId === auth.profile?.id && claimSelfOnly">
              Claiming doors for <strong>yourself</strong> —
            </template>
            <template v-else>
              Assigning doors to <strong>{{ memberName(assigningMember) }}</strong> —
            </template>
            <template v-if="lassoActive">
              drag a loop on the map and every door inside comes with it.
            </template>
            <template v-else-if="streetTapActive">
              tap a door and its whole street comes with it.
            </template>
            <template v-else>
              tap doors to add or remove them; tap one door, then another, to take the whole walk
              between them. Or use ◯ Lasso / ☝ Streets on the map to sweep a lot at once.
            </template>
            <strong class="assign-count">{{ assignSelected.size }}</strong> selected.
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
          Couldn't load Google Maps — check the connection and reload.
        </p>
        <div
          v-else
          ref="mapWrapEl"
          class="squad-map-wrap"
          :class="{ 'map-wrap-fullscreen': isFullscreen }"
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
          <!-- The whole assign flow lives ON the map, not only in the bar
               above it: sweeping is exactly what people do in fullscreen,
               where the page chrome — the count, and Save — isn't on screen
               at all. Sits above the lasso surface so it stays reachable
               while a tool is armed. -->
          <div
            v-if="assigningMember"
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
          <!-- Sweep tools, top-right under fullscreen — the turf cutter's
               pair, cut down to a door-id selection. Only while assigning:
               with no pile open there's nothing to sweep into. -->
          <div v-if="assigningMemberId" class="sweep-toggle">
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
            <template v-if="lassoActive || streetTapActive">
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
                class="layer-btn sweep-erase"
                :class="{ active: sweepMode === 'erase' }"
                :aria-pressed="sweepMode === 'erase'"
                title="Take the sweep back out of this member's doors"
                @click="sweepMode = 'erase'"
              >
                Erase
              </button>
            </template>
          </div>
          <!-- Turf layer, tri-state: ring the crew's doors in their turf
               colors, ring EVERY turf's doors (the whole campaign's cut), or
               (tap the active button again) plain status pins. No area
               shading — see the paintForDoor comment. -->
          <div class="layer-toggle" role="group" aria-label="Turf layer">
            <button
              type="button"
              class="layer-btn"
              :class="{ active: turfShade === 'mine' }"
              :aria-pressed="turfShade === 'mine'"
              title="Ring your squad's doors in their turf colors"
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
        </div>
      </div>

      <!-- Member cards. Three tap targets, each its own thing: the header
           zooms the map to that person, the recent list opens their full run,
           and the action row is the buttons. -->
      <div class="member-grid">
        <div
          v-for="(m, i) in orderedMembers"
          :key="m.id"
          v-motion="fadeUp(Math.min(i, 8) * 45)"
          class="member-card"
          :class="{ selected: selectedMemberId === m.id, assigning: assigningMemberId === m.id }"
          :style="{
            '--member-color': memberColor(m),
          }"
        >
          <button
            type="button"
            class="member-top"
            :aria-label="`Zoom the map to ${memberName(m)}`"
            @click="selectMember(m.id)"
          >
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
          </button>

          <!-- The last five, and the way to the rest of them. -->
          <button
            type="button"
            class="recent-block"
            :aria-label="`See ${memberName(m)}'s knocks`"
            @click="openMemberSheet(m.id)"
          >
            <ul v-if="recentByMember.get(m.id)?.length" class="recent-list">
              <li v-for="r in recentByMember.get(m.id)" :key="r.addressId">
                <span class="recent-street">{{ prettyStreet(r.street) }}</span>
                <span class="recent-time muted">{{ knockTime(r.occurredAt) }}</span>
              </li>
            </ul>
            <p v-else class="muted no-knocks">No doors knocked yet.</p>
            <span class="recent-more">
              {{ recentByMember.get(m.id)?.length ? 'See all their knocks' : 'Open their card' }} ›
            </span>
          </button>

          <div class="member-actions">
            <button class="btn btn-sm ghost-btn" @click="openMemberProfile(m.id)">Profile</button>
            <a
              v-if="m.phone && m.id !== auth.profile?.id"
              class="btn btn-sm ghost-btn"
              :href="telHref(m.phone)"
              :aria-label="`Call ${memberName(m)}`"
            >
              Call
            </a>
            <button
              v-if="canAssignTo(m.id)"
              class="btn btn-sm assign-btn"
              @click="startAssign(m.id)"
            >
              {{ assigningMemberId === m.id ? 'Picking…' : assignVerb(m.id) }}
            </button>
          </div>
        </div>
      </div>
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
          <button class="btn btn-sm btn-primary" @click="openMemberProfile(sheetMember.id)">
            View profile
          </button>
          <a
            v-if="sheetMember.phone && sheetMember.id !== auth.profile?.id"
            class="btn btn-sm ghost-btn"
            :href="telHref(sheetMember.phone)"
          >
            Call
          </a>
          <button
            v-if="canAssignTo(sheetMember.id)"
            class="btn btn-sm ghost-btn"
            @click="sheetMemberId = null; startAssign(sheetMember.id)"
          >
            {{ assignVerb(sheetMember.id) }}
          </button>
        </div>

        <p v-if="sheetLoading" class="muted">Loading their knocks…</p>
        <p v-else-if="!sheetFeed.length" class="muted">No knocks logged yet.</p>
        <ul v-else class="feed-list">
          <li v-for="row in sheetFeed" :key="row.id">
            <button
              type="button"
              class="feed-row"
              :disabled="!row.addressId"
              @click="openFeedDoor(row)"
            >
              <span class="feed-dot" :style="{ background: OUTCOME_HEX[row.outcome] }" aria-hidden="true"></span>
              <span class="feed-main">
                <span class="feed-street">{{ prettyStreet(row.street) || 'Door' }}</span>
                <span class="muted feed-meta">
                  {{ OUTCOME_LABELS[row.outcome] }}<template v-if="row.person"> · {{ row.person }}</template>
                </span>
              </span>
              <span class="muted feed-time">{{ feedStamp(row.occurredAt) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </BottomSheet>

    <!-- New squad sheet (no-squad state) -->
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

/* --- "Crew claims their own doors" switch --- */

.claim-row {
  border-top: 1px solid var(--border);
  padding-top: 0.55rem;
}

.claim-switch {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  cursor: pointer;
}

.claim-switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.claim-track {
  flex-shrink: 0;
  margin-top: 0.1rem;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 18%, transparent);
  border: 1px solid var(--border);
  transition: background 0.15s ease;
  display: flex;
  align-items: center;
  padding: 2px;
}

.claim-knob {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: transform 0.15s ease;
}

.claim-switch input:checked + .claim-track {
  background: var(--accent);
}

.claim-switch input:checked + .claim-track .claim-knob {
  transform: translateX(18px);
}

.claim-switch input:focus-visible + .claim-track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.claim-label {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-size: 0.9rem;
  min-width: 0;
}

.claim-hint {
  font-size: 0.82rem;
}

.claim-note {
  margin: 0;
  font-size: 0.86rem;
  border-top: 1px solid var(--border);
  padding-top: 0.55rem;
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
  font-size: 0.8rem;
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
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
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
.sweep-toggle {
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

.sweep-erase.active {
  background: #d64545;
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

.member-actions {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
  margin-top: auto;
}

.assign-btn,
.ghost-btn {
  border: 1.5px solid var(--member-color, var(--border));
  color: var(--member-color, var(--text));
  background: transparent;
  font-weight: 700;
  text-decoration: none;
}

.ghost-btn {
  border-color: var(--border);
  color: var(--text);
}

/* Tiles are half a phone wide — the buttons have to be too. */
.member-card .member-actions .btn {
  padding: 0.25rem 0.5rem;
  min-height: 30px;
  font-size: 0.74rem;
}

.assign-btn {
  margin-left: auto;
}

.member-card.assigning .assign-btn {
  background: var(--member-color);
  color: #fff;
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

@media (min-width: 900px) {
  .member-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

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
}

.member-card.selected {
  border-color: var(--member-color);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--member-color) 35%, transparent);
}

/* Header, recent list and actions are three separate targets — the header
   zooms the map, the list opens the member sheet. A whole-card click handler
   made every button a stop-propagation fight. */
.member-top {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 8px;
}

.member-top:hover .member-name,
.recent-block:hover .recent-more {
  text-decoration: underline;
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
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0.4rem 0.45rem;
  border: 1px dashed color-mix(in srgb, var(--member-color) 40%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}

.recent-block:hover {
  background: var(--surface);
}

.recent-more {
  font-size: 0.76rem;
  font-weight: 700;
  color: var(--member-color);
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
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.recent-list li {
  display: flex;
  justify-content: space-between;
  gap: 0.4rem;
  font-size: 0.74rem;
  line-height: 1.35;
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

.feed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.feed-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.15rem;
  cursor: pointer;
}

.feed-row:disabled {
  cursor: default;
}

.feed-row:not(:disabled):hover {
  background: var(--surface-2);
}

.feed-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
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
/* The assign-mode walk-anchor pulse used to be a CSS keyframe on marker
   content; it's drawn on the door canvas now (DoorPaintState.pulse). */
</style>
