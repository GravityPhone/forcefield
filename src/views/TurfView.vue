<script setup lang="ts">
// Turf cutter, SEARCH-FIRST (2026-07-24 rework): the map starts BLANK —
// just the basemap (plus optional turf-area shading). Lines derived from
// door geocodes never sat on the real roads, so nothing street-shaped is
// drawn at all. The flow: type a street name, tap a match (the map zooms to
// it and its doors appear as dots), then tap "Add to turf" on the match to
// take every door. A street already in the draft trims from its pill: the
// open pill editor paints that street's doors and each map tap drops or
// restores one house. The Lasso still circles a whole patch at once.
// Existing turfs live behind ONE dropdown — picking a turf zooms to it and
// shows a single compact management card (edit / delete / reassign), not a
// long list.
//
// Sweeps stack into a draft turf that gets a name and an assignee: a squad
// (the day crew sorts out who takes what) or a single canvasser. Saving
// stamps addresses.turf_id server-side via the set_turf_segments RPC, which
// is what Hunt reads to show "your turf".
//
// EVERYTHING before Save is client-side and synchronous: the full address
// table (~23k rows, ungeocoded included) loads into in-memory street
// indexes, streets and doors render on ONE canvas overlay
// (src/lib/doorCanvas.ts — no DOM markers, no pin cap), and every gesture
// mutates the draft purely in memory and repaints in a frame. The only
// network after load: Save (turf insert + set_turf_segments RPC), geocoding
// drips, and the post-save refetch.
//
// STARTUP IS MAP-FIRST (2026-07-23, "it's crazy how long it's taking to
// load"): the map appears immediately and flies to the user's location
// zoomed in; the address/turf data loads in the background (streets pop in
// when ready) and knock statuses — needed only for trim-mode door fills —
// don't load at all until trim mode first opens.
//
// Roles: campaign managers (and admins) cut anywhere. Squad leaders only
// cut SUB-turfs — cuts inside a turf assigned to them (directly or via
// their squad) that carve doors out of the parent, for splitting the crew's
// assignment. RLS + the RPC enforce this server-side; the scoping here just
// keeps the UI honest.
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Geolocation } from '@capacitor/geolocation'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import type { SelectOption } from '@/components/ui/AppSelect.vue'
import { loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  CityLimitsLayer,
  TurfAreasLayer,
  readMapPref,
  readTurfShadeMode,
  turfAreaFor,
  writeMapPref,
  writeTurfShadeMode,
} from '@/lib/mapLayers'
import type { DoorPoint } from '@/lib/mapLayers'
import { DoorCanvasLayer } from '@/lib/doorCanvas'
import type { DoorPaintState } from '@/lib/doorCanvas'
import { geocodeAndCache, geocodeMissing } from '@/lib/geocode'
import { localToday } from '@/lib/day'
import { OUTCOME_HEX, PIN_DEFAULT_HEX, doorStatusOutcome } from '@/lib/outcomes'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { houseNumber, streetNameOf } from '@/lib/streetWalk'
import { useAuthStore } from '@/stores/auth'
import { useSquadsStore } from '@/stores/squads'
import { PARITY_LABELS } from '@/types'
import type { AppRole, ChatProfile, HouseholdLatestKnock, KnockOutcome, Turf, TurfParity, TurfSegment } from '@/types'

// Same fallback as Hunt: Richwood, OH (the imported demo subset).
const FALLBACK_CENTER = { lat: 40.4273, lng: -83.2966 }

/** Slim address row — everything turf cutting needs, nothing Talk-specific. */
interface AddressLite {
  id: string
  street: string
  unit: string | null
  city: string
  zip: string | null
  lat: number | null
  lng: number | null
  turf_id: string | null
}

interface TurfWithMeta extends Turf {
  turf_segments: TurfSegment[]
  assignee: ChatProfile | null
  squad: { id: string; name: string; squad_date: string } | null
}

/** One row of a turf's dispatch history ("Jul 6 — Kool krew"). squad_name is
 * snapshotted server-side at assignment time (day-squad rows are deletable);
 * assignee names resolve live via the join. */
interface AssignmentLog {
  turf_id: string
  squad_id: string | null
  squad_name: string | null
  assignee_id: string | null
  assigned_on: string
  created_at: string
  assignee: { username: string; display_name: string | null } | null
}

/** A sweep in the draft tray. memberIds/doorCount come from the full address
 * table (ungeocoded doors included), so the door count is exact. */
interface DraftSegment {
  key: string
  street_name: string
  city: string | null
  range_start: number
  range_end: number
  parity: TurfParity
  memberIds: string[]
  doorCount: number
  /** Doors matching the range but already claimed by a different turf —
   * they stay where they are (first claim wins). */
  takenCount: number
}

// Distinct map hues; a new turf takes the first color no existing turf uses.
const PALETTE = [
  '#7c3aed', '#0ea5e9', '#f97316', '#10b981', '#ef4444',
  '#eab308', '#ec4899', '#14b8a6', '#6366f1', '#84cc16',
]

const auth = useAuthStore()
const squadsStore = useSquadsStore()

const mapEl = ref<HTMLElement | null>(null)
const pinsLoading = ref(false)
const loadError = ref('')
const saveError = ref('')
const saving = ref(false)

const turfs = ref<TurfWithMeta[]>([])
/** turf id -> its dispatch history, oldest first (trigger-written). */
const historyByTurf = ref<Map<string, AssignmentLog[]>>(new Map())
const people = ref<ChatProfile[]>([])
/** Latest outcome per door — dots wear the same status colors as Hunt, so
 * knocked/unknocked history reads the same while cutting. */
const statusByAddress = ref<Map<string, KnockOutcome>>(new Map())

// --- Zoom thresholds ---
/** Trim-mode doors show house-number pills from this zoom (dots below). */
const NUMBERS_MIN_ZOOM = 16
/** Below this zoom trim-mode doors are tiny dots and door taps don't land. */
const PINS_MIN_ZOOM = 15
/** How close (screen px) a tap must land to a door to count as tapping it. */
const TAP_RADIUS_PX = 22

// --- Draft turf state ---
const draftName = ref('')
const segments = ref<DraftSegment[]>([])
/** Which draft segment's inline editor is open (pill tap toggles it). The
 * open editor's street is also the map's TRIM target: its doors paint as
 * tappable dots. */
const expandedSegKey = ref<string | null>(null)
const expandedSeg = computed(() => segments.value.find((s) => s.key === expandedSegKey.value) ?? null)
/** The street being trimmed door-by-door — follows the open pill editor. */
const focusedStreet = computed(() =>
  expandedSeg.value
    ? { name: expandedSeg.value.street_name, city: expandedSeg.value.city }
    : null,
)
/** The street last picked from search — its doors paint so "which houses is
 * this?" has an answer on an otherwise blank map. */
const locatedStreet = ref<{ name: string; city: string | null } | null>(null)

function toggleSegEditor(key: string) {
  if (expandedSegKey.value === key) {
    expandedSegKey.value = null
    return
  }
  expandedSegKey.value = key
  ensureKnockStatuses()
  const seg = segments.value.find((s) => s.key === key)
  // Opening trim mode zooms to the street and pins down its unmapped doors
  // so there's something to tap.
  if (seg) void materializeStreetPins(seg.street_name, seg.city, true)
}
const editingTurfId = ref<string | null>(null)
/** Which of the lead's turfs a NEW sub-turf carves from (auto when one). */
const draftParentId = ref<string | null>(null)
// 'none' | 'squad:<id>' | 'user:<id>' — Reka's SelectItem forbids '' values.
const assignChoice = ref('none')

let map: google.maps.Map | null = null
let areasLayer: TurfAreasLayer | null = null
let cityLayer: CityLimitsLayer | null = null
let doorLayer: DoorCanvasLayer | null = null
/** Draft shading lives on its own Data layer so it can rebuild and clear
 * independently of the saved-turf areas. */
let draftData: google.maps.Data | null = null
let initStarted = false

// --- In-memory address data: the whole county, indexed by street ---
const addressById = new Map<string, AddressLite>()
/** `NAME|CITY` -> rows (same objects as addressById). */
const streetsByKey = new Map<string, AddressLite[]>()
/** `NAME` -> rows across all cities, for city-less segment lookups. */
const streetsByName = new Map<string, AddressLite[]>()
/** Prebuilt search list: one row per street+city with count and span. */
let streetSummaries: { street_name: string; city: string; count: number; lo: number; hi: number }[] = []

let segKeyCounter = 0
/** Set on teardown so a background geocode sweep stops writing to a
 * disposed map. */
let unmounted = false

const turfColorById = computed(() => new Map(turfs.value.map((t) => [t.id, t.color])))

function indexAddresses(rows: AddressLite[]) {
  addressById.clear()
  streetsByKey.clear()
  streetsByName.clear()
  const summaries = new Map<string, { street_name: string; city: string; count: number; lo: number; hi: number }>()
  for (const a of rows) {
    addressById.set(a.id, a)
    const name = streetNameOf(a.street)
    if (!name) continue
    const key = `${name}|${a.city.toUpperCase()}`
    const byKey = streetsByKey.get(key)
    if (byKey) byKey.push(a)
    else streetsByKey.set(key, [a])
    const byName = streetsByName.get(name)
    if (byName) byName.push(a)
    else streetsByName.set(name, [a])
    const n = houseNumber(a.street)
    const sum = summaries.get(key)
    if (!sum) summaries.set(key, { street_name: name, city: a.city, count: 1, lo: n, hi: n })
    else {
      sum.count++
      if (n < sum.lo) sum.lo = n
      if (n > sum.hi) sum.hi = n
    }
  }
  streetSummaries = [...summaries.values()]
}

/** Every row on a street — from memory, never the network. City given =
 * that city only; null = any city (segments store null when unknown). */
function streetRows(streetName: string, city: string | null): AddressLite[] {
  if (city) return streetsByKey.get(`${streetName}|${city.toUpperCase()}`) ?? []
  return streetsByName.get(streetName) ?? []
}

// --- Role scoping ---
// Managers (and admins) get the full cutter; squad leaders — and, when their
// squad has no leader, plain members — get a scoped SUB-cutter; everyone else
// gets a read-only notice.

const isManager = computed(
  () => auth.profile?.role === 'campaign_manager' || auth.profile?.role === 'admin',
)
const isLead = computed(() => auth.profile?.role === 'team_lead')
/** Squads I'm on TODAY. Turf follows the day's dispatch: a sub-cutter's
 * scope is only turf pointed at a crew that's actually out today —
 * yesterday's squads don't count, the campaign manager re-dispatches each
 * morning. (The DB-side guards stay date-agnostic on purpose — squad_date is
 * a client-local day — so this filter is what keeps the UI honest.) */
const mySquadIds = ref<Set<string>>(new Set())
/** The subset of my squads with no team_lead/campaign_manager/admin member —
 * the only turf a plain canvasser may sub-cut (mirrors the DB's
 * can_member_subcut). */
const myLeaderlessSquadIds = ref<Set<string>>(new Set())

/** A canvasser standing in for an absent leader: some top-level turf is
 * assigned to a leaderless squad I'm on. */
const isMemberSubcutter = computed(
  () =>
    auth.profile?.role === 'canvasser' &&
    turfs.value.some(
      (t) => !t.parent_turf_id && t.squad_id !== null && myLeaderlessSquadIds.value.has(t.squad_id),
    ),
)
/** Anyone who cuts SUB-turfs scoped to their own turf (leads + leaderless
 * members), as opposed to the managers' full cutter. */
const isSubcutter = computed(() => isLead.value || isMemberSubcutter.value)
/** Who may cut at all — everyone else just sees the notice. */
const canCut = computed(() => isManager.value || isSubcutter.value)

/** Top-level turfs I may sub-cut inside: assigned to me or a squad I'm on (as
 * a lead), or to a leaderless squad I'm on (as a stand-in member). */
const myParentTurfs = computed(() =>
  turfs.value.filter((t) => {
    if (t.parent_turf_id) return false
    if (isLead.value) {
      return (
        t.assignee_id === auth.profile?.id ||
        (t.squad_id !== null && mySquadIds.value.has(t.squad_id))
      )
    }
    if (isMemberSubcutter.value) {
      return t.squad_id !== null && myLeaderlessSquadIds.value.has(t.squad_id)
    }
    return false
  }),
)

/** The pool the current draft claims doors from: the edited turf's parent,
 * or the lead's picked parent for a fresh cut. Null = top-level cut
 * claiming unassigned doors (campaign managers). */
const effectiveParentId = computed(() => {
  if (editingTurfId.value) {
    return turfs.value.find((t) => t.id === editingTurfId.value)?.parent_turf_id ?? null
  }
  return isSubcutter.value ? draftParentId.value : null
})

/** Keep the sub-cutter's parent pick valid as turfs load/refresh. */
function defaultDraftParent() {
  if (!isSubcutter.value) return
  if (draftParentId.value && myParentTurfs.value.some((t) => t.id === draftParentId.value)) return
  draftParentId.value = myParentTurfs.value[0]?.id ?? null
}

function canManage(t: TurfWithMeta): boolean {
  if (!isSubcutter.value) return true
  return t.parent_turf_id !== null && myParentTurfs.value.some((p) => p.id === t.parent_turf_id)
}

function parentName(t: { parent_turf_id: string | null }): string {
  return turfs.value.find((p) => p.id === t.parent_turf_id)?.name ?? 'its parent turf'
}

/** Leads see only their turf + its sub-turfs; managers see everything,
 * parents first with their sub-turfs tucked underneath. */
const listTurfs = computed(() => {
  const source = isSubcutter.value
    ? turfs.value.filter(
        (t) =>
          myParentTurfs.value.some((p) => p.id === t.id) ||
          (t.parent_turf_id !== null &&
            myParentTurfs.value.some((p) => p.id === t.parent_turf_id)),
      )
    : turfs.value
  const subsByParent = new Map<string, TurfWithMeta[]>()
  const tops: TurfWithMeta[] = []
  for (const t of source) {
    if (t.parent_turf_id) {
      const arr = subsByParent.get(t.parent_turf_id)
      if (arr) arr.push(t)
      else subsByParent.set(t.parent_turf_id, [t])
    } else {
      tops.push(t)
    }
  }
  const out: TurfWithMeta[] = []
  for (const t of tops) {
    out.push(t, ...(subsByParent.get(t.id) ?? []))
    subsByParent.delete(t.id)
  }
  for (const orphans of subsByParent.values()) out.push(...orphans)
  return out
})

// Layer toggles, persisted per device like Hunt's pin mode.
// The cutter has no mine/all split — its shading exists to show the whole
// existing cut while you carve. It shares Scout's tri-state pref, mapping
// its one Shade button to off ↔ all (Scout's 'mine' just counts as
// "shading on" here). Legacy `map-show-areas` boolean seeds the default.
const showAreas = ref(
  readTurfShadeMode('map-turf-shading', readMapPref('map-show-areas', true) ? 'all' : 'off') !==
    'off',
)
const showCity = ref(readMapPref('map-show-city', false))

function toggleAreas() {
  showAreas.value = !showAreas.value
  writeTurfShadeMode('map-turf-shading', showAreas.value ? 'all' : 'off')
  areasLayer?.setVisible(showAreas.value)
}

function toggleCity() {
  showCity.value = !showCity.value
  writeMapPref('map-show-city', showCity.value)
  void cityLayer?.setVisible(showCity.value)
}

const draftColor = computed(() => {
  if (editingTurfId.value) {
    return turfs.value.find((t) => t.id === editingTurfId.value)?.color ?? PALETTE[0]
  }
  const used = new Set(turfs.value.map((t) => t.color))
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[turfs.value.length % PALETTE.length]
})

const draftMemberIds = computed(() => {
  const all = new Set<string>()
  for (const s of segments.value) for (const id of s.memberIds) all.add(id)
  return all
})

const draftDoorCount = computed(() => draftMemberIds.value.size)
const draftTakenCount = computed(() => segments.value.reduce((n, s) => n + s.takenCount, 0))

// Transient feedback line ("Added WALNUT ST — 41 doors") that temporarily
// replaces the standing instructions in the sweep bar.
const flashMsg = ref('')
let flashTimer: ReturnType<typeof setTimeout> | undefined

function flash(msg: string) {
  flashMsg.value = msg
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashMsg.value = ''
  }, 3500)
}

const hint = computed(() => {
  if (flashMsg.value) return flashMsg.value
  if (lassoActive.value) {
    return 'Lasso armed — drag a loop and every door inside joins the turf. Tap Lasso again to go back to panning.'
  }
  if (focusedStreet.value) {
    return `Trimming ${focusedStreet.value.name} — tap its doors on the map to drop or restore each house. Tap open map (or the pill) when you're done.`
  }
  const base =
    'Type a street name below, tap a match to see it on the map, then "Add to turf" takes every door on it. Tap a pill to trim a street house by house, or circle a patch with Lasso.'
  return isSubcutter.value
    ? `${base} Only streets inside your assigned turf count toward a sub-turf.`
    : base
})

// --- Assignment options: today's squads + every canvasser. A turf may point
// at a past day's squad that loadToday won't return — keep it selectable so
// touching the dropdown doesn't silently drop the assignment. ---
function assignOptionsFor(t: TurfWithMeta | null): SelectOption[] {
  const opts: SelectOption[] = [{ value: 'none', label: 'Unassigned' }]
  const squadIds = new Set<string>()
  for (const s of squadsStore.squads) {
    squadIds.add(s.id)
    opts.push({ value: `squad:${s.id}`, label: `Squad — ${s.name}` })
  }
  if (t?.squad && !squadIds.has(t.squad.id)) {
    opts.push({
      value: `squad:${t.squad.id}`,
      label: `Squad — ${t.squad.name} (${prettyDay(t.squad.squad_date)})`,
    })
  }
  for (const p of people.value) {
    opts.push({ value: `user:${p.id}`, label: `Canvasser — ${p.display_name || p.username}` })
  }
  return opts
}

const assignOptions = computed<SelectOption[]>(() =>
  assignOptionsFor(turfs.value.find((x) => x.id === editingTurfId.value) ?? null),
)

function assignChoiceOf(t: TurfWithMeta): string {
  return t.squad_id ? `squad:${t.squad_id}` : t.assignee_id ? `user:${t.assignee_id}` : 'none'
}

// --- Dispatch status: turf is durable, squads last one day. A turf still
// pointed at a past day's squad is hidden from the Squad page and Hunt until
// it's re-pointed, so this list is where a manager sees (and clears) the
// morning's dispatch queue. ---

/** "2026-07-06" → "Jul 6". Parsed as local date parts — new Date('YYYY-MM-DD')
 * would read UTC midnight and drift the day in US timezones. */
function prettyDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Non-empty when the turf is still pointed at a past day's crew — the row's
 * warning text, which doubles as the explanation for why no squad sees it. */
function staleDispatchLabel(t: TurfWithMeta): string {
  if (t.parent_turf_id || !t.squad || t.squad.squad_date === localToday()) return ''
  return `Not out today — last crew was ${t.squad.name} (${prettyDay(t.squad.squad_date)}). Reassign it to send a squad back.`
}

function historyTarget(r: AssignmentLog): string {
  if (r.squad_name) return r.squad_name
  if (r.assignee) return r.assignee.display_name || r.assignee.username
  return 'unassigned'
}

/** "Jul 5 Terrarium 2 · Jul 6 Kool krew" — the turf's last few crews. Only
 * shown once there's more than the current assignment to tell. */
const HISTORY_SHOWN = 5
function crewHistory(t: TurfWithMeta): string {
  const rows = historyByTurf.value.get(t.id) ?? []
  if (rows.length < 2) return ''
  return rows
    .slice(-HISTORY_SHOWN)
    .map((r) => `${prettyDay(r.assigned_on)} ${historyTarget(r)}`)
    .join(' · ')
}

// Reassign straight from the turf list — no need to re-open the whole cut
// for a hand-off. Segments and stamped doors are untouched.
const listError = ref('')
async function reassignTurf(t: TurfWithMeta, choice: string) {
  if (choice === assignChoiceOf(t)) return
  listError.value = ''
  const [kind, id] = choice.split(':')
  const { error } = await supabase
    .from('turfs')
    .update({
      squad_id: kind === 'squad' ? id : null,
      assignee_id: kind === 'user' ? id : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', t.id)
  if (error) {
    listError.value = 'Could not reassign that turf — try again.'
    return
  }
  if (editingTurfId.value === t.id) assignChoice.value = choice
  await fetchTurfs()
}

function segmentLabel(s: { street_name: string; range_start: number; range_end: number; parity: TurfParity }): string {
  const side = s.parity === 'both' ? '' : ` · ${PARITY_LABELS[s.parity].toLowerCase()}`
  return `${s.street_name} ${s.range_start}–${s.range_end}${side}`
}

// --- Door canvas paint state ---
// The map stays blank except for the doors of the located street (picked
// from search) and the street being trimmed (open pill editor). Fill =
// knock status, ring = membership.

function doorOnStreet(a: AddressLite, s: { name: string; city: string | null }): boolean {
  if (streetNameOf(a.street) !== s.name) return false
  return !s.city || a.city.toUpperCase() === s.city.toUpperCase()
}

function paintForDoor(id: string): DoorPaintState | null {
  const f = focusedStreet.value
  const l = locatedStreet.value
  if (!f && !l) return null
  const a = addressById.get(id)
  if (!a) return null
  if (!(f && doorOnStreet(a, f)) && !(l && doorOnStreet(a, l))) return null
  const inDraft = draftMemberIds.value.has(id)
  // While editing, doors still stamped to the turf but swept OUT of the
  // draft show ringless — the map previews the save.
  const stamped =
    a.turf_id && !(editingTurfId.value && a.turf_id === editingTurfId.value)
      ? turfColorById.value.get(a.turf_id)
      : undefined
  const outcome = statusByAddress.value.get(id)
  return {
    fill: outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX,
    ring: inDraft ? draftColor.value : (stamped ?? null),
    inDraft,
  }
}

// Any paint-relevant state change repaints the one canvas (rAF-coalesced in
// the layer).
watch([draftMemberIds, statusByAddress, expandedSegKey, locatedStreet, turfColorById, editingTurfId], () =>
  doorLayer?.requestRepaint(),
)

function canvasDoorOf(a: AddressLite) {
  const n = houseNumber(a.street)
  return { id: a.id, lat: a.lat!, lng: a.lng!, house: n > 0 ? String(n) : '' }
}

function* locatedCanvasDoors() {
  for (const a of addressById.values()) {
    if (a.lat != null && a.lng != null) yield canvasDoorOf(a)
  }
}

// --- Data fetches ---

/** The WHOLE address table, ungeocoded rows included — street sweeps, door
 * counts, and search all run from memory so no gesture ever waits on the
 * network. ~23k slim rows ≈ a small map tile's worth of JSON. */
async function fetchAddresses(): Promise<AddressLite[]> {
  // 8 concurrent pages: ~23 pages of 1000 land in 3 round trips instead of 6.
  return fetchAllRows<AddressLite>(
    (from, to) =>
      supabase
        .from('addresses')
        .select('id, street, unit, city, zip, lat, lng, turf_id')
        .order('id')
        .range(from, to),
    1000,
    8,
  )
}

async function fetchTurfs() {
  const [turfRes, histRes] = await Promise.all([
    supabase
      .from('turfs')
      .select(
        '*, turf_segments(*), assignee:profiles!turfs_assignee_id_fkey(id, username, display_name), squad:squads!turfs_squad_id_fkey(id, name, squad_date)',
      )
      .order('created_at'),
    supabase
      .from('turf_assignments')
      .select(
        'turf_id, squad_id, squad_name, assignee_id, assigned_on, created_at, assignee:profiles!turf_assignments_assignee_id_fkey(username, display_name)',
      )
      .order('created_at'),
  ])
  turfs.value = (turfRes.data ?? []) as TurfWithMeta[]
  const hist = new Map<string, AssignmentLog[]>()
  for (const row of (histRes.data ?? []) as unknown as AssignmentLog[]) {
    const list = hist.get(row.turf_id)
    if (list) list.push(row)
    else hist.set(row.turf_id, [row])
  }
  historyByTurf.value = hist
}

/** Trim-mode door fills wear knock-status colors — ~15k rows the page never
 * needs at startup, so they load once, lazily, the first time trim mode
 * opens (the statusByAddress watch repaints when they land). */
let statusesRequested = false
function ensureKnockStatuses() {
  if (statusesRequested) return
  statusesRequested = true
  void fetchKnockStatuses()
}

/** Latest outcome per door, for the status-colored dot fills. Best-effort:
 * a failed fetch keeps whatever colors we already had. */
async function fetchKnockStatuses() {
  try {
    const rows = await fetchAllRows<HouseholdLatestKnock>((from, to) =>
      supabase.from('household_latest_knock').select('*').order('household_id').range(from, to),
    )
    // Effective status, not the raw latest outcome — green only when the
    // whole roster signed, yellow while partly signed (doorStatusOutcome),
    // so the cutter's fills match Scout exactly. No realtime feed here, so
    // computing once at fetch time is enough.
    statusByAddress.value = new Map(
      rows.map((r) => [
        r.household_id,
        doorStatusOutcome(r.outcome, r.signed_count, r.person_count) ?? r.outcome,
      ]),
    )
  } catch {
    /* keep previous statuses */
  }
}

/** Which of my squads have no team_lead/campaign_manager/admin member — the
 * only ones a plain canvasser may sub-cut inside. Kept in step with the DB's
 * can_member_subcut so the UI offers exactly what the RPC will accept. */
async function computeLeaderlessSquads() {
  if (!mySquadIds.value.size) {
    myLeaderlessSquadIds.value = new Set()
    return
  }
  const { data } = await supabase
    .from('squad_members')
    .select('squad_id, profiles!inner(role)')
    .in('squad_id', [...mySquadIds.value])
  const ranked = new Set<string>()
  for (const r of (data ?? []) as unknown as { squad_id: string; profiles: { role: AppRole } }[]) {
    if (r.profiles.role !== 'canvasser') ranked.add(r.squad_id)
  }
  myLeaderlessSquadIds.value = new Set(
    [...mySquadIds.value].filter((id) => !ranked.has(id)),
  )
}

// Map-first startup: only the Maps SDK blocks showing the map. Everything
// else — the county address table, turfs, squads, people — streams in behind
// it while the user is already looking at (and panning) their neighborhood.
async function initialize() {
  pinsLoading.value = true
  try {
    await loadMaps()
  } catch {
    loadError.value = 'Could not load the map. Check your connection.'
    initStarted = false
    pinsLoading.value = false
    return
  }
  if (!mapEl.value) {
    pinsLoading.value = false
    return
  }

  map = new google.maps.Map(mapEl.value, {
    center: FALLBACK_CENTER,
    zoom: 15,
    mapId: GOOGLE_MAPS_MAP_ID,
    renderingType: MAP_RENDERING_TYPE,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
    // 'click' fires on each tap of a double-tap too — letting dblclick zoom
    // would take a street AND zoom on accidental double-taps. Pinch and the
    // +/- controls still zoom.
    disableDoubleClickZoom: true,
  })
  map.addListener('click', (e: google.maps.MapMouseEvent) => onMapClick(e))

  doorLayer = new DoorCanvasLayer(map, {
    minPinZoom: PINS_MIN_ZOOM,
    numbersMinZoom: NUMBERS_MIN_ZOOM,
    paintFor: paintForDoor,
  })
  // Settled pan/zoom: repaint only if the view outgrew the painted canvas
  // (or the zoom landed somewhere new — mid-animation the canvas just
  // stretches via its CSS transform).
  map.addListener('idle', () => doorLayer?.checkView())

  areasLayer = new TurfAreasLayer(map)
  areasLayer.setVisible(showAreas.value)
  cityLayer = new CityLimitsLayer(map)
  if (showCity.value) void cityLayer.setVisible(true)
  draftData = new google.maps.Data({ map })
  draftData.setStyle((f) => ({
    fillColor: (f.getProperty('color') as string) || '#7c3aed',
    fillOpacity: 0.2,
    strokeOpacity: 0,
    clickable: false,
    zIndex: 0,
  }))

  // Fly to where the user is standing — cutting usually starts on the
  // ground — while the street data streams in behind the map.
  void zoomToMe()
  void loadCutterData()
}

/** How far from the campaign's ground the user can be and still get flown
 * to their own location — demo visitors across the country stay on the
 * fallback view instead of landing on an empty map. */
const NEAR_CAMPAIGN_METERS = 60000

/** Rough planar distance — plenty at county scale. */
function roughMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.hypot(x, y) * 6371000
}

/** Center tight on the user's real location (same Capacitor call as Scout's
 * locate button — browser fallback included). Denied/unavailable/far away =
 * stay on the fallback town view. Never blocks anything. */
async function zoomToMe() {
  try {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
    if (unmounted || !map) return
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude }
    if (roughMeters(here, FALLBACK_CENTER) > NEAR_CAMPAIGN_METERS) return
    map.panTo(here)
    map.setZoom(17)
  } catch {
    /* no permission or no fix — the fallback view is fine */
  }
}

/** Background data load: the county address table into the street indexes,
 * plus turfs/squads/people for coloring, scoping, and the assign pickers.
 * The map is already up and interactive while this runs. */
async function loadCutterData() {
  try {
    const [rows] = await Promise.all([
      fetchAddresses(),
      fetchTurfs(),
      squadsStore.loadToday(),
      supabase
        .from('profiles')
        .select('id, username, display_name')
        .order('username')
        .then((res) => {
          people.value = (res.data ?? []) as ChatProfile[]
        }),
      supabase
        .from('squad_members')
        .select('squad_id, squads!inner(squad_date)')
        .eq('user_id', auth.profile?.id ?? '')
        .eq('squads.squad_date', localToday())
        .then((res) => {
          mySquadIds.value = new Set((res.data ?? []).map((r) => r.squad_id as string))
        }),
    ])
    await computeLeaderlessSquads()
    if (unmounted) return
    defaultDraftParent()
    indexAddresses(rows)
    doorLayer?.setDoors(locatedCanvasDoors())
    buildSavedAreas()
  } catch {
    loadError.value = 'Could not load the street data. Check your connection and reload.'
  } finally {
    pinsLoading.value = false
  }
}

/** Shade every saved turf (except the one being edited — its shape is being
 * redrawn live as the draft). */
function buildSavedAreas() {
  if (!areasLayer) return
  const doorsByTurf = new Map<string, DoorPoint[]>()
  for (const a of addressById.values()) {
    if (!a.turf_id || a.lat == null || a.lng == null) continue
    if (editingTurfId.value && a.turf_id === editingTurfId.value) continue
    const list = doorsByTurf.get(a.turf_id)
    const door = { lat: a.lat, lng: a.lng, street: a.street }
    if (list) list.push(door)
    else doorsByTurf.set(a.turf_id, [door])
  }
  areasLayer.setTurfs(
    turfs.value
      .filter((t) => doorsByTurf.has(t.id))
      .map((t) => ({ id: t.id, color: t.color, doors: doorsByTurf.get(t.id)! })),
  )
}

/** Re-pull addresses + turfs after a save/delete (turf_id stamps changed
 * server-side) and repaint. Statuses only re-pull if trim mode ever loaded
 * them. */
async function reloadAll() {
  const [rows] = await Promise.all([
    fetchAddresses(),
    fetchTurfs(),
    ...(statusesRequested ? [fetchKnockStatuses()] : []),
  ])
  indexAddresses(rows)
  doorLayer?.setDoors(locatedCanvasDoors())
  defaultDraftParent()
  buildSavedAreas()
}

/** After a turf is cut, geocode every door in it that has no coordinates yet
 * (they can't paint on the canvas until located). Runs in the background one
 * door at a time — the Geocoder rate-limits on bursts — dropping each dot as
 * it resolves and refining the shaded area at the end. Every result caches
 * to the DB, so this is a one-time cost per door: the whole turf ends up
 * pinned everywhere it's shown (Squad, Hunt). */
async function geocodeTurfDoors(turfId: string) {
  const { data } = await supabase
    .from('addresses')
    .select('id, street, unit, city, zip, lat, lng, turf_id')
    .eq('turf_id', turfId)
    .is('lat', null)
  const missing = (data ?? []) as AddressLite[]
  if (!missing.length) return
  await geocodeMissing(
    missing,
    (id, loc) => {
      const a = addressById.get(id)
      if (a) {
        a.lat = loc.lat
        a.lng = loc.lng
        doorLayer?.upsertDoor(canvasDoorOf(a))
        doorLayer?.requestRepaint()
      }
    },
    () => unmounted,
  )
  if (!unmounted) buildSavedAreas()
}

// --- Draft shading: one angular area for the whole draft, rebuilt in the
// next frame after any change (rAF-coalesced — gestures never wait on it).

let shadeQueued = false
function scheduleDraftShade() {
  if (shadeQueued) return
  shadeQueued = true
  requestAnimationFrame(() => {
    shadeQueued = false
    rebuildDraftShade()
  })
}

function rebuildDraftShade() {
  if (!draftData) return
  draftData.forEach((f) => draftData!.remove(f))
  const doors: DoorPoint[] = []
  for (const id of draftMemberIds.value) {
    const a = addressById.get(id)
    if (a && a.lat != null && a.lng != null) doors.push({ lat: a.lat, lng: a.lng, street: a.street })
  }
  const shape = turfAreaFor(doors)
  if (shape) {
    draftData.addGeoJson({
      type: 'Feature',
      geometry: shape.geometry,
      properties: { color: draftColor.value },
    })
  }
}

// --- Tapping (all synchronous — the draft lives entirely in memory) ---
// The map takes no street-picking taps anymore (adding is the search flow's
// "Add to turf" button). Taps only matter in trim mode: tap the focused
// street's doors to drop/restore each house; tap open map to exit trim.

function onMapClick(e: google.maps.MapMouseEvent) {
  if (!e.latLng || !map || !focusedStreet.value) return
  if ((map.getZoom() ?? 14) < PINS_MIN_ZOOM) return
  const id = doorLayer?.doorAt(e.latLng, TAP_RADIUS_PX)
  if (id) toggleTrimDoor(id)
  else expandedSegKey.value = null
}

/** Trim-mode door tap: drop the house from the draft, or restore it. The
 * street's segments are rebuilt as honest runs (split only around house
 * numbers that actually exist) so toggling never leaves phantom ranges. */
function toggleTrimDoor(addressId: string) {
  const a = addressById.get(addressId)
  const f = focusedStreet.value
  if (!a || !f) return
  // Painted doors can also belong to the search-located street — trimming
  // only ever edits the focused one.
  if (!doorOnStreet(a, f)) return
  const name = streetNameOf(a.street)
  const city = f.city ?? a.city
  const n = houseNumber(a.street)
  if (!draftMemberIds.value.has(addressId)) {
    // Restoring — but only doors this draft could actually claim.
    const parentId = effectiveParentId.value
    const claimable =
      (editingTurfId.value !== null && a.turf_id === editingTurfId.value) ||
      (parentId !== null ? a.turf_id === parentId : !a.turf_id && !isSubcutter.value)
    if (!claimable) {
      flash(`${a.street} already belongs to another turf.`)
      return
    }
  }
  const segs = matchingSegments(name, city)
  const nums = new Set<number>()
  for (const row of streetRows(name, city)) {
    if (segs.some((s) => matchesSegment(row, s))) nums.add(houseNumber(row.street))
  }
  snapshotDraft()
  if (nums.has(n)) nums.delete(n)
  else nums.add(n)
  for (const s of segs) removeSegment(s)
  if (nums.size) addStreetRuns(name, city, nums)
  // Segments were rebuilt with fresh keys — re-point trim mode at the
  // street's first surviving segment (or end it if the street's gone).
  const after = matchingSegments(name, city)
  expandedSegKey.value = after[0]?.key ?? null
  if (!after.length) flash(`${name} removed from the draft.`)
}

function matchesSegment(a: AddressLite, seg: Pick<DraftSegment, 'range_start' | 'range_end' | 'parity'>): boolean {
  const n = houseNumber(a.street)
  if (n < seg.range_start || n > seg.range_end) return false
  return seg.parity === 'both' || (n % 2 === 0) === (seg.parity === 'even')
}

/** (Re)derive a segment's members from the street index, refresh its
 * highlighter stroke, and queue the shading rebuild. Pure memory — instant. */
function computeSegment(seg: DraftSegment) {
  const rows = streetRows(seg.street_name, seg.city)
  const members = rows.filter((a) => matchesSegment(a, seg))
  // Claimable mirrors set_turf_segments(): doors already in this turf, plus
  // the pool it draws from — the parent's doors for a sub-turf, unassigned
  // doors for a top-level cut. Everything else counts as "taken".
  const parentId = effectiveParentId.value
  const free = members.filter(
    (a) =>
      (editingTurfId.value !== null && a.turf_id === editingTurfId.value) ||
      (parentId !== null ? a.turf_id === parentId : !a.turf_id && !isSubcutter.value),
  )
  seg.memberIds = free.map((a) => a.id)
  seg.doorCount = free.length
  seg.takenCount = members.length - free.length
  scheduleDraftShade()
}

function addSegment(
  streetName: string,
  city: string | null,
  lo: number,
  hi: number,
  parity: TurfParity,
) {
  // A sweep that overlaps an existing draft segment on the same street folds
  // into it (the ranges union) — the same doors must never sit in a turf's
  // segment list twice.
  const existing = segments.value.find(
    (s) =>
      s.street_name === streetName &&
      (!s.city || !city || s.city.toUpperCase() === city.toUpperCase()) &&
      s.parity === parity &&
      lo <= s.range_end &&
      hi >= s.range_start,
  )
  if (existing) {
    existing.range_start = Math.min(existing.range_start, lo)
    existing.range_end = Math.max(existing.range_end, hi)
    computeSegment(existing)
    return
  }
  // reactive(): computeSegment fills memberIds/doorCount in AFTER the push,
  // and those writes must invalidate draftMemberIds/draftDoorCount.
  const seg: DraftSegment = reactive({
    key: `seg-${++segKeyCounter}`,
    street_name: streetName,
    city,
    range_start: lo,
    range_end: hi,
    parity,
    memberIds: [],
    doorCount: 0,
    takenCount: 0,
  })
  segments.value.push(seg)
  computeSegment(seg)
}

function removeSegment(seg: DraftSegment) {
  segments.value = segments.value.filter((s) => s.key !== seg.key)
  if (expandedSegKey.value === seg.key) expandedSegKey.value = null
  scheduleDraftShade()
}

/** Take a range OUT of the draft: segments covering it shrink (or split in
 * two around the hole); pieces left with no doors at all just disappear. */
function subtractRange(streetName: string, city: string | null, lo: number, hi: number) {
  const affected = segments.value.filter(
    (s) =>
      s.street_name === streetName &&
      (!s.city || !city || s.city.toUpperCase() === city.toUpperCase()) &&
      lo <= s.range_end &&
      hi >= s.range_start,
  )
  for (const seg of affected) {
    const pieces: { lo: number; hi: number }[] = []
    if (seg.range_start < lo) pieces.push({ lo: seg.range_start, hi: lo - 1 })
    if (seg.range_end > hi) pieces.push({ lo: hi + 1, hi: seg.range_end })
    removeSegment(seg)
    const rows = pieces.length ? streetRows(seg.street_name, seg.city) : []
    for (const p of pieces) {
      const hasDoors = rows.some((a) => {
        const n = houseNumber(a.street)
        return n >= p.lo && n <= p.hi
      })
      if (hasDoors) addSegment(seg.street_name, seg.city, p.lo, p.hi, seg.parity)
    }
  }
}

// --- Undo ---
// Every gesture that changes the draft's street list (sweep, erase, street
// toggle, hold, lasso, tray ✕, Clear) files a snapshot first; Undo rebuilds
// the draft from the latest one. Range/side tweaks in the pill editor are
// hand-reversible, so they don't clutter the stack.

type SegSnapshot = Pick<DraftSegment, 'street_name' | 'city' | 'range_start' | 'range_end' | 'parity'>
const undoStack = ref<SegSnapshot[][]>([])
const UNDO_CAP = 25
const canUndo = computed(() => undoStack.value.length > 0)

function snapshotDraft() {
  undoStack.value.push(
    segments.value.map((s) => ({
      street_name: s.street_name,
      city: s.city,
      range_start: s.range_start,
      range_end: s.range_end,
      parity: s.parity,
    })),
  )
  if (undoStack.value.length > UNDO_CAP) undoStack.value.shift()
}

/** Clear the draft shading from the map (the segment list itself is the
 * caller's business). */
function wipeDraftDrawing() {
  draftData?.forEach((f) => draftData!.remove(f))
}

function undoDraft() {
  const snap = undoStack.value.pop()
  if (!snap) return
  wipeDraftDrawing()
  segments.value = []
  expandedSegKey.value = null
  for (const s of snap) {
    const seg: DraftSegment = reactive({
      key: `seg-${++segKeyCounter}`,
      ...s,
      memberIds: [],
      doorCount: 0,
      takenCount: 0,
    })
    segments.value.push(seg)
    computeSegment(seg)
  }
}

function removeSegmentWithUndo(seg: DraftSegment) {
  snapshotDraft()
  removeSegment(seg)
}

/** Fully abandon an edit — unlike Start Over, this leaves edit mode
 * entirely, so nothing about this session is worth keeping in Undo. */
function cancelEdit() {
  clearDraft()
  undoStack.value = []
}

/** Re-cut from scratch WITHOUT losing the name/assignee already picked (or,
 * mid-edit, without leaving edit mode) — just the swept streets go away. */
function startOverDraft() {
  if (segments.value.length) snapshotDraft()
  segments.value = []
  wipeDraftDrawing()
  expandedSegKey.value = null
  saveError.value = ''
  defaultDraftParent()
  buildSavedAreas()
}

function onSegmentRangeChange(seg: DraftSegment) {
  if (seg.range_end < seg.range_start) {
    ;[seg.range_start, seg.range_end] = [seg.range_end, seg.range_start]
  }
  computeSegment(seg)
}

function onSegmentParityChange(seg: DraftSegment, parity: string) {
  seg.parity = parity as TurfParity
  computeSegment(seg)
}

function clearDraft() {
  segments.value = []
  wipeDraftDrawing()
  expandedSegKey.value = null
  editingTurfId.value = null
  draftName.value = ''
  assignChoice.value = 'none'
  saveError.value = ''
  defaultDraftParent()
  // Restore the saved shading of whatever turf was being edited.
  buildSavedAreas()
}

// A different parent = a different claim pool: recompute every sweep so door
// counts and shading track the pick.
watch(draftParentId, () => {
  for (const seg of segments.value) computeSegment(seg)
})

// --- Whole-street taking ---

/** Draft segments already covering this street (in the same city, when
 * known) — the tap handler consults this so a street can never land in the
 * draft twice. */
function matchingSegments(streetName: string, city: string | null) {
  return segments.value.filter(
    (s) =>
      s.street_name === streetName &&
      (!s.city || !city || s.city.toUpperCase() === city.toUpperCase()),
  )
}

/** Take an entire street (its full house-number span) as one draft segment,
 * then pin down its unmapped doors. */
function sweepWholeStreet(streetName: string, city: string | null) {
  const rows = streetRows(streetName, city)
  if (!rows.length) {
    flash(`No doors found on ${streetName}.`)
    return
  }
  const nums = rows.map((r) => houseNumber(r.street))
  snapshotDraft()
  addSegment(streetName, city, Math.min(...nums), Math.max(...nums), 'both')
  flash(`Added ${streetName} — ${rows.length} doors. Trim it from its pill below, or Undo.`)
  void materializeStreetPins(streetName, city, false)
}

/** Streets pulled in by search (or a double-tap near a sparsely-pinned
 * street) can hold doors that were never geocoded, so the sweep would float
 * over empty map. Geocode a capped batch of them, drop their dots, refresh
 * the segment's stroke, and optionally zoom the map to the street. */
const GEOCODE_BATCH_CAP = 25

async function materializeStreetPins(streetName: string, city: string | null, zoomTo: boolean) {
  const rows = streetRows(streetName, city)
  const fitToStreet = () => {
    if (!map) return
    const bounds = new google.maps.LatLngBounds()
    for (const a of rows) {
      if (a.lat != null && a.lng != null) bounds.extend({ lat: a.lat, lng: a.lng })
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, 72)
  }
  // Zoom to what's already pinned right away — don't make the user wait for
  // geocoding to see where the street is.
  if (zoomTo) fitToStreet()

  const missing = rows.filter((a) => a.lat == null || a.lng == null).slice(0, GEOCODE_BATCH_CAP)
  let added = 0
  for (const a of missing) {
    if (unmounted) return
    const loc = await geocodeAndCache(a)
    if (loc) {
      a.lat = loc.lat
      a.lng = loc.lng
      doorLayer?.upsertDoor(canvasDoorOf(a))
      doorLayer?.requestRepaint()
      added++
    }
  }
  if (added) {
    for (const seg of matchingSegments(streetName, city)) computeSegment(seg)
    if (zoomTo) fitToStreet()
  }
}

// --- Street search: type a name, tap a match, and the map zooms to that
// street — then one tap on its line takes the whole thing. Matches come from
// the in-memory index (no query, no debounce), with door counts and number
// spans. ---

const streetQuery = ref('')
const streetMatches = ref<{ street_name: string; city: string; count: number; lo: number; hi: number }[]>([])

function onStreetInput(value: string) {
  streetQuery.value = value
  const q = value.trim().toUpperCase()
  if (q.length < 2) {
    streetMatches.value = []
    locatedStreet.value = null
    return
  }
  streetMatches.value = streetSummaries
    .filter((s) => s.street_name.includes(q))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
}

/** Is this match the one currently located (its doors on the map, its row
 * wearing the Add button)? */
function isLocated(m: { street_name: string; city: string }): boolean {
  const l = locatedStreet.value
  return !!l && l.name === m.street_name && (l.city ?? '').toUpperCase() === m.city.toUpperCase()
}

function streetInDraft(m: { street_name: string; city: string }): boolean {
  return matchingSegments(m.street_name, m.city).length > 0
}

/** Tapping a search result LOCATES the street: zooms the map to it and
 * paints its doors (geocoding a capped batch of unmapped ones). Taking it
 * is the explicit "Add to turf" button that appears on the located row. */
function locateStreet(m: { street_name: string; city: string }) {
  locatedStreet.value = { name: m.street_name, city: m.city }
  mapEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  void materializeStreetPins(m.street_name, m.city, true)
}

/** The located row's "Add to turf": every door on the street joins the
 * draft (the turf being edited, or the new one being built). */
function addLocatedStreet(m: { street_name: string; city: string }) {
  sweepWholeStreet(m.street_name, m.city)
}

// --- Lasso: VAN-style region selection. Arm it, drag a loop, and every door
// inside joins the draft as street segments (split around doors you didn't
// circle). The map freezes while armed so the drag draws instead of pans;
// everything is hit-tested in memory, so the capture is instant. ---

const lassoActive = ref(false)
const lassoCanvasEl = ref<HTMLCanvasElement | null>(null)
let lassoPath: { x: number; y: number }[] = []
let lassoDrawing = false

function toggleLasso() {
  lassoActive.value = !lassoActive.value
  map?.setOptions({ gestureHandling: lassoActive.value ? 'none' : 'greedy' })
  lassoPath = []
  lassoDrawing = false
  if (lassoActive.value) {
    void nextTick(() => sizeLassoCanvas())
  }
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
  ctx.strokeStyle = draftColor.value
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

function onLassoUp() {
  if (!lassoDrawing) return
  lassoDrawing = false
  const path = lassoPath
  lassoPath = []
  const c = lassoCanvasEl.value
  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
  if (path.length < 3) return
  const ids = doorLayer?.doorsInPolygon(path) ?? []
  const doors = ids
    .map((id) => addressById.get(id))
    .filter((a): a is AddressLite => !!a)
  if (!doors.length) {
    flash('No doors inside that loop — zoom in or circle closer around the dots.')
    return
  }
  snapshotDraft()
  const { doorCount, streetCount } = addDoorsAsSegments(doors)
  if (!doorCount) {
    undoStack.value.pop()
    flash('Could not read streets for those doors — try circling closer around the lines.')
    return
  }
  flash(
    `Lasso: swept ${doorCount} door${doorCount === 1 ? '' : 's'} across ${streetCount} street${streetCount === 1 ? '' : 's'}.`,
  )
}

function onLassoCancel() {
  lassoDrawing = false
  lassoPath = []
  const c = lassoCanvasEl.value
  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
}

/** Rebuild one street's draft segments from an explicit set of included
 * house numbers. Runs split only around numbers that actually EXIST on the
 * street but weren't included, and a single-side selection (all-even or
 * all-odd while the other side exists) becomes a parity segment. Shared by
 * the lasso and trim-mode door toggling. Returns how many runs landed. */
function addStreetRuns(name: string, city: string | null, nums: Set<number>): number {
  const rows = streetRows(name, city)
  const allNums = [...new Set(rows.map((r) => houseNumber(r.street)))].sort((a, b) => a - b)
  const selEven = [...nums].some((n) => n % 2 === 0)
  const selOdd = [...nums].some((n) => n % 2 !== 0)
  const lane: TurfParity = selEven && selOdd ? 'both' : selEven ? 'even' : 'odd'
  const laneNums =
    lane === 'both' ? allNums : allNums.filter((n) => (n % 2 === 0) === (lane === 'even'))
  // If the street only HAS one side, 'both' describes the cut better.
  const segParity: TurfParity = lane !== 'both' && laneNums.length !== allNums.length ? lane : 'both'
  const runs: [number, number][] = []
  let lo: number | null = null
  let hi = 0
  for (const n of laneNums) {
    if (nums.has(n)) {
      if (lo == null) lo = n
      hi = n
    } else if (lo != null) {
      runs.push([lo, hi])
      lo = null
    }
  }
  if (lo != null) runs.push([lo, hi])
  for (const [rLo, rHi] of runs) addSegment(name, city, rLo, rHi, segParity)
  return runs.length
}

/** Turn a geometric door selection into street segments — the lasso takes
 * what you circled, not each street's whole number range. */
function addDoorsAsSegments(doors: AddressLite[]): { doorCount: number; streetCount: number } {
  const groups = new Map<string, { name: string; city: string; nums: Set<number> }>()
  let doorCount = 0
  for (const a of doors) {
    const name = streetNameOf(a.street)
    if (!name) continue
    doorCount++
    const key = `${name}|${a.city.toUpperCase()}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { name, city: a.city, nums: new Set() }))
    g.nums.add(houseNumber(a.street))
  }
  let streetCount = 0
  for (const g of groups.values()) {
    if (addStreetRuns(g.name, g.city, g.nums)) streetCount++
  }
  return { doorCount, streetCount }
}

// --- Save / edit / delete ---

async function saveTurf() {
  saveError.value = ''
  if (!segments.value.length) {
    saveError.value = 'Sweep at least one street range first.'
    return
  }
  // Naming is optional — a turf is usually just "whoever it's assigned to's
  // turf", so default to exactly that.
  let name = draftName.value.trim()
  if (!name) {
    const opt = assignOptions.value.find((o) => o.value === assignChoice.value)
    const who = assignChoice.value !== 'none' && opt ? opt.label.split(' — ')[1] : ''
    name = who ? `${who}'s turf` : `Turf ${turfs.value.length + 1}`
  }
  if (isSubcutter.value && !editingTurfId.value && !draftParentId.value) {
    saveError.value = 'No turf is assigned to you yet — your campaign manager assigns turf first.'
    return
  }
  saving.value = true
  try {
    const [kind, id] = assignChoice.value.split(':')
    const assignment = {
      squad_id: kind === 'squad' ? id : null,
      assignee_id: kind === 'user' ? id : null,
    }
    let turfId = editingTurfId.value
    if (turfId) {
      const { error } = await supabase
        .from('turfs')
        .update({ name, ...assignment, updated_at: new Date().toISOString() })
        .eq('id', turfId)
      if (error) throw error
    } else {
      const { data, error } = await supabase
        .from('turfs')
        .insert({
          name,
          color: draftColor.value,
          ...assignment,
          parent_turf_id: isSubcutter.value ? draftParentId.value : null,
          created_by: auth.profile?.id,
        })
        .select('id')
        .single()
      if (error || !data) throw error ?? new Error('insert failed')
      turfId = data.id as string
    }
    const { error: rpcError } = await supabase.rpc('set_turf_segments', {
      target_turf_id: turfId,
      segments: segments.value.map((s) => ({
        street_name: s.street_name,
        city: s.city,
        range_start: s.range_start,
        range_end: s.range_end,
        parity: s.parity,
      })),
    })
    if (rpcError) throw rpcError
    clearDraft()
    undoStack.value = []
    await reloadAll()
    // Fill in dots for every door now in this turf, in the background —
    // never blocks the save.
    void geocodeTurfDoors(turfId)
  } catch {
    saveError.value = 'Could not save the turf — try again.'
  } finally {
    saving.value = false
  }
}

// --- Turf picker: the old always-rendered turf list is ONE dropdown now
// (2026-07-24, "we don't need to see all of the turfs at the bottom").
// Picking a turf zooms the map to it and opens a single management card. ---

const selectedTurfId = ref<string | null>(null)
const selectedTurf = computed(
  () => listTurfs.value.find((t) => t.id === selectedTurfId.value) ?? null,
)
const turfPickOptions = computed<SelectOption[]>(() => [
  { value: 'none', label: 'Look at a turf…' },
  ...listTurfs.value.map((t) => ({
    value: t.id,
    label: `${t.parent_turf_id ? '↳ ' : ''}${t.name}`,
  })),
])

function onPickTurf(value: string) {
  selectedTurfId.value = value === 'none' ? null : value
  if (selectedTurfId.value) focusTurf(selectedTurfId.value)
}

function editTurf(t: TurfWithMeta) {
  clearDraft()
  undoStack.value = []
  editingTurfId.value = t.id
  draftName.value = t.name
  assignChoice.value = assignChoiceOf(t)
  // Hide this turf's saved shading — the draft redraws it live.
  buildSavedAreas()
  for (const s of t.turf_segments) {
    addSegment(s.street_name, s.city, s.range_start, s.range_end, s.parity)
  }
  focusTurf(t.id)
  focusDraft()
}

async function deleteTurf(t: TurfWithMeta) {
  const consequence = t.parent_turf_id
    ? `Its doors return to "${parentName(t)}".`
    : 'Its doors become unassigned.'
  if (!window.confirm(`Delete ${t.parent_turf_id ? 'sub-turf' : 'turf'} "${t.name}"? ${consequence}`)) return
  if (editingTurfId.value === t.id) clearDraft()
  await supabase.from('turfs').delete().eq('id', t.id)
  if (selectedTurfId.value === t.id) selectedTurfId.value = null
  await reloadAll()
}

function focusTurf(turfId: string) {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  for (const a of addressById.values()) {
    if (a.turf_id === turfId && a.lat != null && a.lng != null) {
      bounds.extend({ lat: a.lat, lng: a.lng })
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
  else if (pinsLoading.value) flash('Still loading street data — try that again in a moment.')
}

const draftCardEl = ref<HTMLElement | null>(null)

function focusDraft() {
  draftCardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

onMounted(() => {
  if (!initStarted) {
    initStarted = true
    void initialize()
  }
})

onUnmounted(() => {
  unmounted = true
  doorLayer?.dispose()
  areasLayer?.dispose()
  cityLayer?.dispose()
  draftData?.setMap(null)
})
</script>

<template>
  <AppShell title="Turf">
    <!-- Plain members with no stand-in role see a read-only notice, not the
         cutter. Managers and sub-cutters (leads / leaderless members) get the
         tool. RLS enforces the same rule server-side regardless. -->
    <div v-if="!canCut" class="stack">
      <div class="card">
        <h3>Turf</h3>
        <p class="muted empty-note">
          Dividing up turf is a campaign manager's or squad leader's job — or, when your squad has
          no leader today, anyone on the squad can split it up. You're all set: head to
          <router-link to="/canvass">Canvass</router-link> to knock your turf.
        </p>
      </div>
    </div>
    <div v-else class="stack">
      <!-- Status bar: taps are contextual (fresh street = take it, drafted
           street = trim it) — this bar just carries the instructions and
           per-gesture feedback. -->
      <div class="sweep-bar" :style="{ '--draft-color': draftColor }">
        <span class="sweep-dot" aria-hidden="true"></span>
        <p class="sweep-hint">{{ hint }}</p>
      </div>

      <!-- Find a street by name: tap a match to zoom to it and see its
           doors; the located row grows the explicit "Add to turf" button. -->
      <input
        :value="streetQuery"
        class="street-search"
        type="search"
        placeholder="Type a street name to start"
        aria-label="Search streets"
        @input="onStreetInput(($event.target as HTMLInputElement).value)"
      />
      <div v-if="streetMatches.length" class="street-matches">
        <div
          v-for="m in streetMatches"
          :key="m.street_name + m.city"
          class="street-match"
          :class="{ located: isLocated(m) }"
        >
          <button class="street-match-main" @click="locateStreet(m)">
            <span class="street-match-name">{{ m.street_name }}</span>
            <span class="muted">{{ m.city }} · {{ m.count }} doors · {{ m.lo }}–{{ m.hi }}</span>
          </button>
          <span v-if="isLocated(m) && streetInDraft(m)" class="muted street-match-in">
            In this turf ✓
          </span>
          <button
            v-else-if="isLocated(m)"
            class="btn btn-sm btn-primary street-match-add"
            @click="addLocatedStreet(m)"
          >
            Add to turf
          </button>
        </div>
      </div>

      <div class="map-wrap">
        <div ref="mapEl" class="map"></div>
        <!-- Freehand selection surface — only exists while Lasso is armed. -->
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
        <div v-if="pinsLoading" class="pins-loading" role="status" aria-live="polite">
          <span class="pins-loading-spinner" aria-hidden="true"></span>
          Loading streets…
        </div>
        <!-- Map layers: turf area shading and city/village limits. -->
        <div class="layer-toggle" role="group" aria-label="Map layers">
          <button
            type="button"
            class="layer-btn"
            :class="{ active: showAreas }"
            :aria-pressed="showAreas"
            title="Shade each saved turf's area in its color"
            @click="toggleAreas"
          >
            Shade
          </button>
          <button
            type="button"
            class="layer-btn"
            :class="{ active: showCity }"
            :aria-pressed="showCity"
            title="Show city and village limits"
            @click="toggleCity"
          >
            City
          </button>
        </div>
        <!-- Lasso toggle, top-right: freezes the map and turns drags into a
             selection loop. -->
        <div class="lasso-toggle">
          <button
            type="button"
            class="layer-btn"
            :class="{ active: lassoActive }"
            :aria-pressed="lassoActive"
            title="Draw a loop to sweep every door inside it"
            @click="toggleLasso"
          >
            ◯ Lasso
          </button>
        </div>
      </div>
      <p v-if="loadError" class="muted map-error">{{ loadError }}</p>
      <p v-if="mapsAuthError" class="muted map-error">
        Google rejected the Maps API key — usually quota, billing, or a referrer restriction on
        the key. The exact reason is logged in the browser console.
      </p>

      <!-- Draft tray: the turf being cut. -->
      <div ref="draftCardEl" class="card draft-card" :style="{ '--draft-color': draftColor }">
        <!-- A lead with no assigned turf has no ground to cut on. -->
        <template v-if="isSubcutter && !myParentTurfs.length">
          <h3 class="draft-title">
            <span class="draft-swatch" aria-hidden="true"></span>
            Sub-turfs
          </h3>
          <p class="muted empty-note">
            No turf is assigned to you (or a squad you're on) yet — your campaign manager cuts
            and assigns turf. Once you have some, you can split it into sub-turfs here and hand
            those to your canvassers.
          </p>
        </template>
        <template v-else>
        <h3 class="draft-title">
          <span class="draft-swatch" aria-hidden="true"></span>
          {{ editingTurfId ? (isSubcutter ? 'Editing sub-turf' : 'Editing turf') : isSubcutter ? 'New sub-turf' : 'New turf' }}
          <span v-if="draftDoorCount" class="draft-count">{{ draftDoorCount }} doors</span>
        </h3>

        <!-- Which turf the sub-turf carves from (auto when there's one). -->
        <AppSelect
          v-if="isSubcutter && !editingTurfId && myParentTurfs.length > 1"
          class="parent-pick"
          small
          :options="myParentTurfs.map((t) => ({ value: t.id, label: `Inside — ${t.name}` }))"
          :model-value="draftParentId ?? ''"
          aria-label="Cut inside which of your turfs"
          @update:model-value="draftParentId = $event"
        />
        <p v-else-if="isSubcutter" class="muted parent-note">
          Cutting inside
          <strong>{{
            editingTurfId
              ? parentName({ parent_turf_id: effectiveParentId })
              : (myParentTurfs[0]?.name ?? 'your turf')
          }}</strong>
        </p>

        <template v-if="segments.length">
          <!-- One pill per swept stretch — tap it to fine-tune, ✕ to drop it. -->
          <div class="seg-pills">
            <div
              v-for="seg in segments"
              :key="seg.key"
              class="seg-pill"
              :class="{ open: expandedSegKey === seg.key, empty: !seg.doorCount }"
            >
              <button class="seg-pill-main" @click="toggleSegEditor(seg.key)">
                <span class="seg-pill-street">{{ seg.street_name }}</span>
                <span class="seg-pill-range">
                  {{ seg.range_start }}–{{ seg.range_end }}<template v-if="seg.parity !== 'both'"> · {{ seg.parity }}</template>
                </span>
                <span class="seg-pill-count">{{ seg.doorCount }}</span>
              </button>
              <button
                class="seg-pill-x"
                :aria-label="`Remove ${seg.street_name} ${seg.range_start}–${seg.range_end}`"
                @click="removeSegmentWithUndo(seg)"
              >
                ✕
              </button>
            </div>
          </div>
          <div v-if="expandedSeg" class="seg-editor">
            <div class="seg-editor-title">
              <strong>{{ expandedSeg.street_name }}</strong>
              <span class="muted">{{ expandedSeg.city ?? 'any city' }}</span>
            </div>
            <div class="seg-editor-controls">
              <input
                type="number"
                class="seg-num"
                :value="expandedSeg.range_start"
                min="0"
                aria-label="Range start"
                @change="expandedSeg.range_start = Number(($event.target as HTMLInputElement).value); onSegmentRangeChange(expandedSeg)"
              />
              <span class="muted">–</span>
              <input
                type="number"
                class="seg-num"
                :value="expandedSeg.range_end"
                min="0"
                aria-label="Range end"
                @change="expandedSeg.range_end = Number(($event.target as HTMLInputElement).value); onSegmentRangeChange(expandedSeg)"
              />
              <AppSelect
                class="seg-parity"
                small
                :options="[
                  { value: 'both', label: 'Both sides' },
                  { value: 'even', label: 'Even side' },
                  { value: 'odd', label: 'Odd side' },
                ]"
                :model-value="expandedSeg.parity"
                aria-label="Which side of the street"
                @update:model-value="onSegmentParityChange(expandedSeg, $event)"
              />
              <span class="seg-doors" :class="{ 'seg-doors-empty': !expandedSeg.doorCount }">
                {{ expandedSeg.doorCount }} doors
              </span>
            </div>
            <p class="muted seg-taken">
              Tap this street's doors on the map to drop or restore individual houses.
            </p>
            <p v-if="expandedSeg.takenCount" class="muted seg-taken">
              {{ expandedSeg.takenCount }} of these doors already belong to another turf and stay there.
            </p>
          </div>
        </template>
        <p v-else class="muted empty-note">
          Nothing here yet — type a street name above, tap the match, then "Add to turf". Or
          circle a patch with Lasso.
        </p>

        <div class="draft-form">
          <input
            v-model="draftName"
            class="draft-name"
            type="text"
            maxlength="80"
            placeholder="Turf name (optional — defaults to the assignee)"
            aria-label="Turf name (optional)"
          />
          <AppSelect v-model="assignChoice" :options="assignOptions" aria-label="Assign this turf to" />
          <div class="draft-actions">
            <button class="btn btn-primary" :disabled="saving" @click="saveTurf">
              {{ saving ? 'Saving…' : editingTurfId ? 'Save changes' : 'Create turf' }}
            </button>
            <button v-if="canUndo" class="btn btn-ghost" :disabled="saving" @click="undoDraft">
              Undo
            </button>
            <button v-if="segments.length" class="btn btn-ghost" :disabled="saving" @click="startOverDraft">
              Start over
            </button>
            <button v-if="editingTurfId" class="btn btn-ghost" :disabled="saving" @click="cancelEdit">
              Cancel edit
            </button>
          </div>
          <p v-if="draftTakenCount" class="muted">
            {{ draftTakenCount }} swept doors
            {{ isSubcutter ? 'are outside your turf or already in another cut' : 'stay with their current turf (first claim wins)' }}.
          </p>
          <p v-if="saveError" class="error">{{ saveError }}</p>
        </div>
        </template>
      </div>

      <!-- Existing turfs: one dropdown instead of a long list. Picking a
           turf zooms the map to it and opens its management card. -->
      <div class="card">
        <h3>{{ isSubcutter ? 'Your turf' : 'Turfs' }}</h3>
        <p v-if="!listTurfs.length" class="muted empty-note">
          {{
            isSubcutter
              ? 'Nothing here yet — turf your campaign manager assigns to you shows up here.'
              : 'No turf cut yet. Squads without turf just pick their own streets.'
          }}
        </p>
        <template v-else>
          <AppSelect
            class="turf-pick"
            :options="turfPickOptions"
            :model-value="selectedTurfId ?? 'none'"
            aria-label="Zoom to a turf"
            @update:model-value="onPickTurf"
          />
          <div v-if="selectedTurf" class="turf-row">
            <div class="turf-row-top">
              <button class="turf-row-main" @click="focusTurf(selectedTurf.id)">
                <span class="turf-swatch" :style="{ background: selectedTurf.color }" aria-hidden="true"></span>
                <span class="turf-row-text">
                  <span class="turf-name">
                    {{ selectedTurf.name }}
                    <span v-if="selectedTurf.parent_turf_id" class="muted turf-sub-tag">↳ inside {{ parentName(selectedTurf) }}</span>
                  </span>
                  <span class="muted turf-segments">
                    {{ selectedTurf.turf_segments.map(segmentLabel).join(' · ') || 'No street ranges' }}
                  </span>
                  <span v-if="staleDispatchLabel(selectedTurf)" class="turf-stale">
                    ⚠ {{ staleDispatchLabel(selectedTurf) }}
                  </span>
                  <span v-if="crewHistory(selectedTurf)" class="muted turf-history">
                    Crews: {{ crewHistory(selectedTurf) }}
                  </span>
                </span>
              </button>
              <div v-if="canManage(selectedTurf)" class="turf-row-actions">
                <button class="btn btn-ghost btn-sm" @click="editTurf(selectedTurf)">Edit</button>
                <button class="btn btn-ghost btn-sm turf-delete" @click="deleteTurf(selectedTurf)">Delete</button>
              </div>
            </div>
            <AppSelect
              v-if="canManage(selectedTurf)"
              class="turf-row-assign"
              small
              :options="assignOptionsFor(selectedTurf)"
              :model-value="assignChoiceOf(selectedTurf)"
              :aria-label="`Reassign ${selectedTurf.name}`"
              @update:model-value="reassignTurf(selectedTurf, $event)"
            />
          </div>
        </template>
        <p v-if="listError" class="error">{{ listError }}</p>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* --- Sweep bar --- */

.sweep-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--border);
  border-left: 6px solid var(--draft-color);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--draft-color) 6%, var(--surface));
}

.sweep-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--draft-color);
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.4);
}

.sweep-hint {
  margin: 0;
  flex: 1;
  font-size: 0.88rem;
}

/* --- Map --- */

.map-wrap {
  position: relative;
}

.map {
  height: min(50svh, 480px);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-2);
}

/* The lasso capture surface sits over the whole map while armed. */
.lasso-layer {
  position: absolute;
  inset: 0;
  z-index: 5;
  touch-action: none;
  cursor: crosshair;
  border-radius: var(--radius);
  overflow: hidden;
}

.lasso-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.pins-loading {
  position: absolute;
  top: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.6rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  z-index: 6;
}

/* Segmented layers control, top-left on the map. */
.layer-toggle {
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

/* Lasso toggle, top-right — same chrome as the layer buttons. */
.lasso-toggle {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.layer-btn {
  min-height: 36px;
  padding: 0 0.7rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
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

.pins-loading-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: turf-spin 0.7s linear infinite;
}

.map-error {
  margin: 0;
  font-size: 0.88rem;
}

/* --- Street search --- */

.street-search {
  width: 100%;
  min-height: 48px;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.street-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.street-matches {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* Match rows: tap the name to locate; the located row grows the Add
 * button. */
.street-match {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.35rem 0.5rem 0.35rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.street-match.located {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.street-match-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
  flex: 1;
  min-width: 0;
  min-height: 40px;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  padding: 0;
}

.street-match-main:hover .street-match-name {
  text-decoration: underline;
}

.street-match-add {
  flex-shrink: 0;
}

.street-match-in {
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 600;
}

.street-match-name {
  font-weight: 600;
}

/* --- Draft tray --- */

.draft-card {
  border-left: 6px solid var(--draft-color);
}

.draft-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.draft-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--draft-color);
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.35);
}

.draft-count {
  margin-left: auto;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--draft-color);
}

/* --- Draft pills: one compact chip per swept stretch --- */

.seg-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.6rem;
}

.seg-pill {
  display: inline-flex;
  align-items: center;
  border: 1.5px solid color-mix(in srgb, var(--draft-color) 55%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--draft-color) 10%, var(--surface));
  overflow: hidden;
}

.seg-pill.open {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--draft-color) 40%, transparent);
}

.seg-pill.empty {
  border-color: var(--danger);
}

.seg-pill-main {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 40px;
  padding: 0 0.15rem 0 0.7rem;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.seg-pill-street {
  font-weight: 700;
  font-size: 0.85rem;
  white-space: nowrap;
}

.seg-pill-range {
  font-size: 0.8rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.seg-pill-count {
  min-width: 1.7em;
  padding: 0.12rem 0.4rem;
  border-radius: 999px;
  background: var(--draft-color);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 800;
  text-align: center;
}

.seg-pill.empty .seg-pill-count {
  background: var(--danger);
}

.seg-pill-x {
  min-height: 40px;
  padding: 0 0.6rem 0 0.35rem;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.seg-pill-x:hover {
  color: var(--danger);
}

/* Inline editor for whichever pill is open. */
.seg-editor {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.55rem 0.65rem;
  margin-bottom: 0.6rem;
  border: 1px solid var(--border);
  border-left: 4px solid var(--draft-color);
  border-radius: var(--radius);
  background: var(--surface);
}

.seg-editor-title {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.seg-editor-title .muted {
  font-size: 0.82rem;
}

.seg-editor-controls {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.seg-num {
  width: 5.2rem;
  min-height: 40px;
  padding: 0.3rem 0.5rem;
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.seg-num:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.seg-parity {
  width: auto;
  min-width: 8.5rem;
}

.seg-doors {
  font-size: 0.85rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.seg-doors-empty {
  color: var(--danger);
}

.seg-taken {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
}

.draft-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.draft-name {
  width: 100%;
  min-height: 48px;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.draft-name:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.draft-actions {
  display: flex;
  gap: 0.5rem;
}

.empty-note {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
}

/* --- Turf picker + management card --- */

.turf-pick {
  margin-bottom: 0.6rem;
}

.turf-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0.5rem 0.65rem;
}

.turf-row-top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.turf-row-assign {
  align-self: flex-start;
  /* Line the dropdown up under the turf name, past the color swatch. */
  margin-left: calc(16px + 0.6rem);
}

.turf-row-main {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
}

.turf-swatch {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.35);
}

.turf-row-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.turf-name {
  font-weight: 700;
}

.turf-sub-tag {
  font-weight: 500;
  font-size: 0.78rem;
}

.parent-pick {
  align-self: flex-start;
}

.parent-note {
  margin: 0;
  font-size: 0.85rem;
}

.turf-segments {
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Dispatch flag: fixed amber (like the outcome hexes) so "waiting on you"
 * reads as a warning in every color scheme, day or night. */
.turf-stale {
  font-size: 0.78rem;
  font-weight: 600;
  color: #d97706;
  white-space: normal;
}

.turf-history {
  font-size: 0.75rem;
  white-space: normal;
}

.turf-row-actions {
  display: flex;
  flex-shrink: 0;
  gap: 0.25rem;
}

.turf-delete {
  color: var(--danger);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 0.9rem;
}

@keyframes turf-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
