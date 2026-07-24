<script setup lang="ts">
// Turf cutter, SEARCH-FIRST (2026-07-24 rework): the map starts BLANK —
// just the basemap; there is NO area shading here at all (2026-07-24 night,
// user call — the door symbols carry all the meaning). The flow: type a
// street name, tap a match (the map zooms to it and its doors appear as
// dots), then tap "Add to turf" on the match to take every door. Drafted
// streets live in a compact TABLE: one thin text row per street; tapping a
// row opens the range/side editor below the table AND focuses TRIM mode —
// that street's doors paint and each map tap drops or restores one house.
// The Lasso still circles a whole patch at once.
//
// TURF IS FOR TODAY (2026-07-24 night, user call): the cutter only works
// with turfs cut TODAY (local day of created_at). When a previous day's
// turfs still hold doors, a prompt offers "Copy to today" (fresh rows, same
// streets/assignee — day squads never carry) or "Clear" (their doors
// release; the old rows stay behind, door-less, as history). Doors owned by
// another turf never silently join a capture — they're skipped with a
// flash, which offers a "Take them too" steal when the cutter may re-cut
// the owner (managers for top-level turfs, sub-cutters for siblings).
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
import { CityLimitsLayer, readMapPref, writeMapPref } from '@/lib/mapLayers'
import { DoorCanvasLayer } from '@/lib/doorCanvas'
import type { DoorPaintState } from '@/lib/doorCanvas'
import {
  geocodeAndCache,
  geocodeMissing,
  normalizeStreetName,
  streetAtPoint,
  stripLeadingDirectional,
} from '@/lib/geocode'
import type { StreetAtPoint } from '@/lib/geocode'
import { avatarUrl } from '@/lib/avatars'
import { localToday } from '@/lib/day'
import { OUTCOME_HEX, OUTCOME_LABELS, doorStatusOutcome } from '@/lib/outcomes'
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
  /** Doors matching the range but claimed by a different (unstolen) turf —
   * skipped, never painted or saved; surfaced only in the row editor when a
   * hand-widened range sweeps over them. */
  takenCount: number
}

// Distinct hues for saved turfs (Scout's shading + UI chrome — the cutter
// itself no longer shades anything). NO red: on the cutter's pins red means
// exactly one thing, "closed door", and the old fallback landing on red was
// read as an error. A new turf takes the least-used hue.
const PALETTE = [
  '#7c3aed', '#0ea5e9', '#f97316', '#10b981',
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
/** Effective latest status per door (doorStatusOutcome applied at fetch). */
const statusByAddress = ref<Map<string, KnockOutcome>>(new Map())
/** Doors where SOMEBODY signed but not everybody — these render as a green
 * fill with a yellow ring (project-wide partly-signed rule), distinct from
 * a genuine latest-outcome 'maybe'. */
const partlySignedDoors = ref<Set<string>>(new Set())

// --- Zoom thresholds ---
/** Trim-mode doors show house-number pills from this zoom (dots below). */
const NUMBERS_MIN_ZOOM = 16
/** Below this zoom trim-mode doors are tiny dots and door taps don't land. */
const PINS_MIN_ZOOM = 15
/** Other turfs' "taken" symbols (Turf layer on) start showing this much
 * farther OUT than regular door pins — 2026-07-24 later still, user call:
 * seeing whose ground is whose is useful at a wider view than trimming
 * individual doors is. Still gated behind the toggle, still tiny dots below
 * PINS_MIN_ZOOM (doorCanvas's own tiny-vs-full split is unchanged). */
const TAKEN_MIN_ZOOM = PINS_MIN_ZOOM - 2
/** How close (screen px) a tap must land to a door to count as tapping it. */
const TAP_RADIUS_PX = 22
/** How close (screen px) the lasso LINE must pass to a door to brush it —
 * touching a dot with the stroke selects it, no enclosure needed. */
const LASSO_BRUSH_PX = 16

// --- Draft turf state ---
const draftName = ref('')
const segments = ref<DraftSegment[]>([])
/** Which draft segment (table row) is open/focused. The open row's street
 * is also the map's TRIM target: its doors paint as tappable dots. */
const expandedSegKey = ref<string | null>(null)
const expandedSeg = computed(() => segments.value.find((s) => s.key === expandedSegKey.value) ?? null)
/** The street being trimmed door-by-door — follows the open table row. */
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
  // Trim mode owns the map taps — the armed tools and the history bubble
  // step aside.
  streetTapActive.value = false
  doorInfo.value = null
  const seg = segments.value.find((s) => s.key === key)
  // Opening trim mode zooms to the street and pins down its unmapped doors
  // so there's something to tap.
  if (seg) void materializeStreetPins(seg.street_name, seg.city, true, true)
}

// --- Streets table display: one row per STREET, not per segment ---
// A street can hold several DraftSegments (trimming a hole in the middle
// splits a run in two) — the segments themselves are still what drives
// claiming/trim mode/Undo, unchanged. This just groups them for the table
// (2026-07-24 later still, user call: "we only have one line per street"),
// listing every chunk's range side by side, left to right, on that line.
interface StreetGroup {
  key: string
  street_name: string
  city: string | null
  segs: DraftSegment[]
  doorCount: number
  takenCount: number
}
const streetGroups = computed<StreetGroup[]>(() => {
  const byKey = new Map<string, StreetGroup>()
  const order: string[] = []
  for (const seg of segments.value) {
    const key = `${seg.street_name}|${(seg.city ?? '').toUpperCase()}`
    let g = byKey.get(key)
    if (!g) {
      g = { key, street_name: seg.street_name, city: seg.city, segs: [], doorCount: 0, takenCount: 0 }
      byKey.set(key, g)
      order.push(key)
    }
    g.segs.push(seg)
    g.doorCount += seg.doorCount
    g.takenCount += seg.takenCount
  }
  for (const g of byKey.values()) g.segs.sort((a, b) => a.range_start - b.range_start)
  return order.map((k) => byKey.get(k)!)
})

/** "100–150" or "100–150 · even" — one chunk's range chip text. */
function rangeLabel(s: Pick<DraftSegment, 'range_start' | 'range_end' | 'parity'>): string {
  const side = s.parity === 'both' ? '' : ` · ${PARITY_LABELS[s.parity].toLowerCase()}`
  return `${s.range_start}–${s.range_end}${side}`
}

function isGroupOpen(g: StreetGroup): boolean {
  return g.segs.some((s) => s.key === expandedSegKey.value)
}

/** Row tap: close if any chunk of this street is open, else open its FIRST
 * chunk (multi-chunk streets stay reachable per-chunk via the individual
 * range chips, which call toggleSegEditor directly). */
function toggleGroupEditor(g: StreetGroup) {
  if (isGroupOpen(g)) {
    expandedSegKey.value = null
    return
  }
  toggleSegEditor(g.segs[0].key)
}

function removeGroupWithUndo(g: StreetGroup) {
  snapshotDraft()
  for (const seg of g.segs) removeSegment(seg)
}

const editingTurfId = ref<string | null>(null)
/** Which of the lead's turfs a NEW sub-turf carves from (auto when one). */
const draftParentId = ref<string | null>(null)
// 'none' | 'squad:<id>' | 'user:<id>' — Reka's SelectItem forbids '' values.
const assignChoice = ref('none')

let map: google.maps.Map | null = null
let cityLayer: CityLimitsLayer | null = null
let doorLayer: DoorCanvasLayer | null = null
let initStarted = false

// --- In-memory address data: the whole county, indexed by street ---
const addressById = new Map<string, AddressLite>()
/** `NAME|CITY` -> rows (same objects as addressById). */
const streetsByKey = new Map<string, AddressLite[]>()
/** `NAME` -> rows across all cities, for city-less segment lookups. */
const streetsByName = new Map<string, AddressLite[]>()
/** Prebuilt search list: one row per street+city with count and span. */
let streetSummaries: { street_name: string; city: string; count: number; lo: number; hi: number }[] = []
/** Normalized name -> streets bearing it, for matching reverse-geocoded
 * route names ("South Clinton Street") to voter-file streets ("S CLINTON ST"). */
const streetsByNorm = new Map<string, { name: string; city: string }[]>()

let segKeyCounter = 0
/** Set on teardown so a background geocode sweep stops writing to a
 * disposed map. */
let unmounted = false

const turfById = computed(() => new Map(turfs.value.map((t) => [t.id, t])))

// --- Turf is for TODAY (2026-07-24 night) ---
// The cutter's whole working set — the dropdown, sub-cut scoping, editing,
// door claiming — is turfs cut TODAY (local day of created_at, same
// device-local day rule as squads). Past days' turfs are inert history: the
// stale prompt below either copies them into fresh today-rows or releases
// their doors, and until that choice their doors just read as taken.

/** Local day a turf was cut, as YYYY-MM-DD (created_at is a timestamptz —
 * derive the day in device-local time like every other day-scoped thing). */
function turfDay(t: { created_at: string }): string {
  const d = new Date(t.created_at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function isTodayTurf(t: { created_at: string }): boolean {
  return turfDay(t) === localToday()
}

const todayTurfs = computed(() => turfs.value.filter(isTodayTurf))

/** Past-day turfs that still hold doors (plus parents of doored sub-turfs —
 * a copy has to route sub doors through the parent). Non-empty = the
 * copy-or-clear prompt shows. Recomputed after every address/turf load. */
const staleTurfs = ref<TurfWithMeta[]>([])
const staleBusy = ref(false)

function refreshStaleTurfs() {
  const doored = new Set<string>()
  for (const a of addressById.values()) if (a.turf_id) doored.add(a.turf_id)
  const past = turfs.value.filter((t) => !isTodayTurf(t))
  staleTurfs.value = past.filter(
    (t) =>
      doored.has(t.id) ||
      past.some((s) => s.parent_turf_id === t.id && doored.has(s.id)),
  )
}

/** "Jul 23" (or "Jul 22 – Jul 23") — which day(s) the stale turfs are from. */
const staleDaysLabel = computed(() => {
  const days = [...new Set(staleTurfs.value.map(turfDay))].sort()
  if (!days.length) return ''
  const first = prettyDay(days[0])
  const last = prettyDay(days[days.length - 1])
  return first === last ? first : `${first} – ${last}`
})

function indexAddresses(rows: AddressLite[]) {
  addressById.clear()
  streetsByKey.clear()
  streetsByName.clear()
  streetsByNorm.clear()
  const summaries = new Map<string, { street_name: string; city: string; count: number; lo: number; hi: number }>()
  for (const a of rows) {
    addressById.set(a.id, a)
    const name = streetNameOf(a.street)
    if (!name) continue
    const key = `${name}|${a.city.toUpperCase()}`
    const byKey = streetsByKey.get(key)
    if (byKey) byKey.push(a)
    else {
      streetsByKey.set(key, [a])
      const norm = normalizeStreetName(name)
      const entries = streetsByNorm.get(norm)
      if (entries) entries.push({ name, city: a.city })
      else streetsByNorm.set(norm, [{ name, city: a.city }])
    }
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
    todayTurfs.value.some(
      (t) => !t.parent_turf_id && t.squad_id !== null && myLeaderlessSquadIds.value.has(t.squad_id),
    ),
)
/** Anyone who cuts SUB-turfs scoped to their own turf (leads + leaderless
 * members), as opposed to the managers' full cutter. */
const isSubcutter = computed(() => isLead.value || isMemberSubcutter.value)
/** Who may cut at all — everyone else just sees the notice. */
const canCut = computed(() => isManager.value || isSubcutter.value)

/** Top-level turfs I may sub-cut inside: assigned to me or a squad I'm on (as
 * a lead), or to a leaderless squad I'm on (as a stand-in member). Today's
 * turfs only — yesterday's ground isn't cuttable anymore. */
const myParentTurfs = computed(() =>
  todayTurfs.value.filter((t) => {
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

/** Leads see only their turf + its sub-turfs; managers see everything cut
 * TODAY, parents first with their sub-turfs tucked underneath. */
const listTurfs = computed(() => {
  const source = isSubcutter.value
    ? todayTurfs.value.filter(
        (t) =>
          myParentTurfs.value.some((p) => p.id === t.id) ||
          (t.parent_turf_id !== null &&
            myParentTurfs.value.some((p) => p.id === t.parent_turf_id)),
      )
    : todayTurfs.value
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
// The cutter's "Turf" button gates exactly ONE thing now: the door-level
// "taken" symbols for other turfs' doors (there is no area shading in the
// cutter at all — 2026-07-24 night, user call). OFF BY DEFAULT on its own
// per-device key: a fresh cutter opens clean, showing plain Scout-style
// status dots; flip Turf on to see whose ground is whose, door by door.
// Deliberately NOT Scout's shared tri-state pref — Scout shading on must
// not drag the cutter's taken symbols on with it.
const showTakenDoors = ref(readMapPref('cutter-turf-layer', false))
const showCity = ref(readMapPref('map-show-city', false))

function toggleTakenDoors() {
  showTakenDoors.value = !showTakenDoors.value
  writeMapPref('cutter-turf-layer', showTakenDoors.value)
}

// Dots vs. house-number pills — same control as Scout's pin-style toggle,
// re-added to the cutter (2026-07-24 later still, user call). Own
// localStorage key, same pattern Hunt uses (not the boolean readMapPref
// helper — this is a 3-way-shaped string pref). Defaults to 'numbers' —
// unlike Hunt, the cutter always showed numbers automatically once zoomed
// in before this toggle existed, so 'numbers' is the behavior-preserving
// default; 'dots' still falls back automatically below NUMBERS_MIN_ZOOM.
type PinMode = 'dots' | 'numbers'
function readStoredPinMode(): PinMode {
  try {
    return localStorage.getItem('turf-pin-mode') === 'dots' ? 'dots' : 'numbers'
  } catch {
    return 'numbers'
  }
}
const pinMode = ref<PinMode>(readStoredPinMode())

function setPinMode(mode: PinMode) {
  if (pinMode.value === mode) return
  pinMode.value = mode
  try {
    localStorage.setItem('turf-pin-mode', mode)
  } catch {
    /* private-mode / storage disabled — the toggle still works this session */
  }
  doorLayer?.requestRepaint()
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
  // Least-used hue among today's turfs — never an index-fallback that can
  // surprise (the old one landed on red once the sim data filled the
  // palette).
  const counts = new Map(PALETTE.map((c) => [c, 0]))
  for (const t of todayTurfs.value) {
    const n = counts.get(t.color)
    if (n !== undefined) counts.set(t.color, n + 1)
  }
  let best = PALETTE[0]
  let bestN = Infinity
  for (const c of PALETTE) {
    const n = counts.get(c)!
    if (n < bestN) {
      bestN = n
      best = c
    }
  }
  return best
})

const draftMemberIds = computed(() => {
  const all = new Set<string>()
  for (const s of segments.value) for (const id of s.memberIds) all.add(id)
  return all
})

const draftDoorCount = computed(() => draftMemberIds.value.size)
const draftTakenCount = computed(() => segments.value.reduce((n, s) => n + s.takenCount, 0))

/** Doors the user chose to STEAL from another turf ("Take them too" on the
 * skip flash). They count as claimable in every draft computation; at save
 * time the owning turf is re-cut around them first, so the draft's RPC can
 * actually claim them. Snapshotted/restored with Undo. */
const stealIds = ref(new Set<string>())

// Transient feedback line ("Added WALNUT ST — 41 doors") that temporarily
// replaces the standing instructions in the sweep bar, optionally carrying
// one action button ("Take them too").
const flashMsg = ref('')
const flashAction = ref<{ label: string; run: () => void } | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined

function flash(msg: string, action: { label: string; run: () => void } | null = null) {
  flashMsg.value = msg
  flashAction.value = action
  clearTimeout(flashTimer)
  // Messages with a decision on them hang around longer.
  flashTimer = setTimeout(
    () => {
      flashMsg.value = ''
      flashAction.value = null
    },
    action ? 8000 : 3500,
  )
}

function runFlashAction() {
  const a = flashAction.value
  flashMsg.value = ''
  flashAction.value = null
  clearTimeout(flashTimer)
  a?.run()
}

const hint = computed(() => {
  if (flashMsg.value) return flashMsg.value
  if (lassoActive.value) {
    return selectMode.value === 'erase'
      ? 'Lasso armed to ERASE — drag a loop and every turf door inside comes back out. Tap Lasso again to go back to panning.'
      : 'Lasso armed — drag a loop and every door inside joins the turf. Tap Lasso again to go back to panning.'
  }
  if (streetTapActive.value) {
    return selectMode.value === 'erase'
      ? 'Street tap armed to ERASE — tap any street on the map and it comes out of the turf. Tap Streets again when done.'
      : 'Street tap armed — tap any street right on the map, dots or no dots, and every door on it joins the turf. Tap Streets again when done.'
  }
  if (focusedStreet.value) {
    return `Trimming ${focusedStreet.value.name} — tap its doors on the map to drop or restore each house. Tap open map (or its row) when you're done.`
  }
  const base =
    'Type a street name below and tap a match to see it on the map. Add takes the house range you set (the whole street unless you narrow it). Tap a street in the list below to trim house by house, or circle a patch with Lasso.'
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
// The map stays blank except for: every door in the DRAFT (they accumulate
// as streets are added, so the turf builds up visibly), the located street
// (picked from search), the street being trimmed (the open table row), and
// — with the Turf layer on at pin zoom — every door another turf owns.
//
// Cutter-local pin palette (2026-07-24, replaced the per-turf rainbow): a
// dot answers ONE question — how does this door stand? Green = everyone
// signed, green with a yellow ring = partly signed (project-wide rule),
// red = closed (didn't sign / skip / hostile), white = anything else
// (untouched, not-home, maybe). Turf membership is not a color anymore:
// every draft door wears ONE uniform dark ring ("this door is going into
// the turf I'm editing"), and doors another turf owns draw as the hollow
// red "taken" symbol carrying the owner-assignee's avatar/initial. The
// hexes reuse outcomes.ts literals — never change those there.
const FILL_SIGNED = OUTCOME_HEX.signed
const FILL_CLOSED = OUTCOME_HEX.didnt_sign
const RING_PARTLY = OUTCOME_HEX.maybe
const FILL_OPEN = '#ffffff'
const OPEN_OUTLINE = '#8a90a5'
const OPEN_INK = '#1d2433'
const DRAFT_RING = '#1d2433'

/** Avatar bitmaps for the taken-door badge, by slug. Images decode async —
 * the layer repaints when one lands; until then the canvas shows the
 * initial. */
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

function doorOnStreet(a: AddressLite, s: { name: string; city: string | null }): boolean {
  if (streetNameOf(a.street) !== s.name) return false
  return !s.city || a.city.toUpperCase() === s.city.toUpperCase()
}

function paintForDoor(id: string): DoorPaintState | null {
  const a = addressById.get(id)
  if (!a) return null
  const inDraft = draftMemberIds.value.has(id)
  const ownedElsewhere =
    !!a.turf_id && !(editingTurfId.value && a.turf_id === editingTurfId.value)
  if (!inDraft) {
    const f = focusedStreet.value
    const l = locatedStreet.value
    const onShownStreet = (f && doorOnStreet(a, f)) || (l && doorOnStreet(a, l))
    // Turf layer on + zoomed to at least TAKEN_MIN_ZOOM: every door another
    // turf owns paints as a taken symbol, so someone else's ground reads
    // door-level just by having the toggle on — from farther out than
    // regular pins need. Toggle off = draft members and the shown street
    // only.
    const shownAsTaken =
      ownedElsewhere && showTakenDoors.value && (map?.getZoom() ?? 0) >= TAKEN_MIN_ZOOM
    if (!onShownStreet && !shownAsTaken) return null
  }
  // Draft members can still carry another turf's stamp (a sub-cut claims
  // from its parent pool, a steal from its victim until save) — membership
  // wins over the taken symbol. And the symbol ONLY exists while the Turf
  // layer is on: with it off, every painted door wears its Scout-style
  // status color, full stop.
  if (ownedElsewhere && !inDraft && showTakenDoors.value) {
    const who = turfById.value.get(a.turf_id!)?.assignee ?? null
    return {
      fill: FILL_OPEN,
      ring: null,
      inDraft: false,
      taken: {
        initial: who ? (who.display_name || who.username).charAt(0).toUpperCase() : '',
        img: who ? badgeImage(who.avatar) : null,
      },
    }
  }
  const eff = statusByAddress.value.get(id)
  let fill = FILL_OPEN
  let innerRing: string | null = null
  if (eff === 'signed') fill = FILL_SIGNED
  else if (partlySignedDoors.value.has(id)) {
    fill = FILL_SIGNED
    innerRing = RING_PARTLY
  } else if (eff === 'didnt_sign' || eff === 'skip' || eff === 'hostile') fill = FILL_CLOSED
  return {
    fill,
    ring: inDraft ? DRAFT_RING : null,
    innerRing,
    outline: fill === FILL_OPEN ? OPEN_OUTLINE : null,
    ink: fill === FILL_OPEN ? OPEN_INK : '#fff',
    inDraft,
  }
}

// Any paint-relevant state change repaints the one canvas (rAF-coalesced in
// the layer). showTakenDoors governs the door-level taken symbols; zoom
// crossings repaint via the layer's own idle check.
watch(
  [draftMemberIds, statusByAddress, partlySignedDoors, expandedSegKey, locatedStreet, turfs, editingTurfId, showTakenDoors, pinMode],
  () => doorLayer?.requestRepaint(),
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
        '*, turf_segments(*), assignee:profiles!turfs_assignee_id_fkey(id, username, display_name, avatar), squad:squads!turfs_squad_id_fkey(id, name, squad_date)',
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
    // Effective status, not the raw latest outcome (doorStatusOutcome —
    // green only when the whole roster signed). Partly-signed doors are
    // tracked separately: doorStatusOutcome folds them into 'maybe', but
    // the cutter paints them green-with-yellow-ring while a genuine latest
    // 'maybe' stays white. No realtime feed here, so computing once at
    // fetch time is enough.
    const status = new Map<string, KnockOutcome>()
    const partly = new Set<string>()
    for (const r of rows) {
      const eff = doorStatusOutcome(r.outcome, r.signed_count, r.person_count) ?? r.outcome
      status.set(r.household_id, eff)
      if (eff === 'maybe' && (r.signed_count ?? 0) > 0) partly.add(r.household_id)
    }
    statusByAddress.value = status
    partlySignedDoors.value = partly
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
    pinMode: () => pinMode.value,
    paintFor: paintForDoor,
  })
  // Settled pan/zoom: repaint only if the view outgrew the painted canvas
  // (or the zoom landed somewhere new — mid-animation the canvas just
  // stretches via its CSS transform).
  map.addListener('idle', () => doorLayer?.checkView())

  cityLayer = new CityLimitsLayer(map)
  if (showCity.value) void cityLayer.setVisible(true)

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
    refreshStaleTurfs()
  } catch {
    loadError.value = 'Could not load the street data. Check your connection and reload.'
  } finally {
    pinsLoading.value = false
  }
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
  refreshStaleTurfs()
  doorLayer?.requestRepaint()
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
}

// --- Tapping (all synchronous — the draft lives entirely in memory) ---
// Tap routing, in priority order: armed street-tap tool → trim mode's door
// toggles → a painted dot opens its compact house history → empty map
// closes whatever's open.

function onMapClick(e: google.maps.MapMouseEvent) {
  if (!e.latLng || !map) return
  if (streetTapActive.value) {
    void handleStreetTap(e.latLng)
    return
  }
  const zoomedIn = (map.getZoom() ?? 14) >= PINS_MIN_ZOOM
  if (focusedStreet.value) {
    if (!zoomedIn) return
    const id = doorLayer?.doorAt(e.latLng, TAP_RADIUS_PX)
    if (id) toggleTrimDoor(id)
    else expandedSegKey.value = null
    return
  }
  const id = zoomedIn ? doorLayer?.doorAt(e.latLng, TAP_RADIUS_PX) : null
  if (id) void showDoorInfo(id)
  else doorInfo.value = null
}

// --- Compact house history: tap a painted dot (no tool armed) and the
// door's last few knocks pop up over the map. ---

interface DoorKnock {
  outcome: KnockOutcome
  occurred_at: string
  person: { name: string } | null
  canvasser: { username: string; display_name: string | null } | null
}

/** A registered voter at the door, with whether they've EVER signed —
 * distinct-signed-residents, the same rule the yellow/green door colors use
 * (doorStatusOutcome), so the bubble explains the paint: two names, one
 * check = that's why the door is yellow, not green. */
interface DoorPerson {
  id: string
  name: string
  signed: boolean
}

const doorInfo = ref<{
  address: AddressLite
  loading: boolean
  knocks: DoorKnock[]
  roster: DoorPerson[]
} | null>(null)
let doorInfoSeq = 0

async function showDoorInfo(addressId: string) {
  const a = addressById.get(addressId)
  if (!a) return
  const seq = ++doorInfoSeq
  doorInfo.value = { address: a, loading: true, knocks: [], roster: [] }
  const [knocksRes, personsRes, signedRes] = await Promise.all([
    supabase
      .from('knock_logs')
      .select('outcome, occurred_at, person:persons(name), canvasser:profiles(username, display_name)')
      .eq('household_id', addressId)
      .order('occurred_at', { ascending: false })
      .limit(6),
    supabase.from('persons').select('id, name').eq('household_id', addressId).order('name'),
    supabase
      .from('knock_logs')
      .select('person_id')
      .eq('household_id', addressId)
      .eq('outcome', 'signed')
      .not('person_id', 'is', null),
  ])
  if (doorInfoSeq !== seq || unmounted) return
  const signedIds = new Set((signedRes.data ?? []).map((r) => r.person_id as string))
  doorInfo.value = {
    address: a,
    loading: false,
    knocks: (knocksRes.data ?? []) as unknown as DoorKnock[],
    roster: ((personsRes.data ?? []) as { id: string; name: string }[]).map((p) => ({
      ...p,
      signed: signedIds.has(p.id),
    })),
  }
}

function knockWhen(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function knockWho(k: DoorKnock): string {
  const by = k.canvasser ? k.canvasser.display_name || k.canvasser.username : ''
  if (k.person?.name && by) return `${k.person.name} · by ${by}`
  return k.person?.name || (by ? `by ${by}` : '')
}

/** The turf that owns the bubbled door, when it's not the one being edited —
 * the bubble names it and offers the deliberate "Edit this turf" hop. */
const doorOwner = computed(() => {
  const tid = doorInfo.value?.address.turf_id
  if (!tid || editingTurfId.value === tid) return null
  return turfById.value.get(tid) ?? null
})

function ownerAssignment(t: TurfWithMeta): string {
  if (t.squad) return `squad ${t.squad.name}`
  if (t.assignee) return `assigned to ${t.assignee.display_name || t.assignee.username}`
  return 'unassigned'
}

/** Deliberate switch into editing the tapped door's turf — never a silent
 * tap-to-switch, and a non-empty draft asks before it's discarded. */
function editOwnerTurf(t: TurfWithMeta) {
  if (
    segments.value.length &&
    editingTurfId.value !== t.id &&
    !window.confirm(`Discard the current draft and edit "${t.name}" instead?`)
  ) {
    return
  }
  doorInfo.value = null
  editTurf(t)
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
  if (!draftMemberIds.value.has(addressId) && !claimableDoor(a)) {
    // Restoring a door another turf owns: never silently — flash it, and
    // offer the steal when this cutter may re-cut the owner.
    const owner = a.turf_id ? turfById.value.get(a.turf_id) : undefined
    flash(
      `${a.street} belongs to ${owner ? `"${owner.name}"` : 'another turf'}.`,
      owner && canStealFrom(owner)
        ? {
            label: 'Take it',
            run: () => {
              stealIds.value.add(addressId)
              toggleTrimDoor(addressId)
            },
          }
        : null,
    )
    return
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

/** Can this draft claim this door? Mirrors set_turf_segments(): doors
 * already in the edited turf, plus the pool it draws from — the parent's
 * doors for a sub-turf, unassigned doors for a top-level cut — plus any
 * door the user explicitly chose to steal. Everything else is "taken". */
function claimableDoor(a: AddressLite): boolean {
  if (stealIds.value.has(a.id)) return true
  const parentId = effectiveParentId.value
  return (
    (editingTurfId.value !== null && a.turf_id === editingTurfId.value) ||
    (parentId !== null ? a.turf_id === parentId : !a.turf_id && !isSubcutter.value)
  )
}

/** May the current cutter steal doors from this turf? Managers can re-cut
 * any top-level turf; sub-cutters only a SIBLING sub-turf (its released
 * doors return to the shared parent pool, where this draft can claim them —
 * anywhere else they'd land out of reach). */
function canStealFrom(victim: TurfWithMeta | undefined): boolean {
  if (!victim || !isTodayTurf(victim)) return false
  if (isManager.value) return victim.parent_turf_id === null
  return victim.parent_turf_id !== null && victim.parent_turf_id === effectiveParentId.value
}

/** (Re)derive a segment's members from the street index. Pure memory —
 * instant. Taken doors are counted but never join. */
function computeSegment(seg: DraftSegment) {
  const rows = streetRows(seg.street_name, seg.city)
  const members = rows.filter((a) => matchesSegment(a, seg))
  const free = members.filter(claimableDoor)
  seg.memberIds = free.map((a) => a.id)
  seg.doorCount = free.length
  seg.takenCount = members.length - free.length
}

function addSegment(
  streetName: string,
  city: string | null,
  lo: number,
  hi: number,
  parity: TurfParity,
) {
  // Draft doors paint with knock-status fills — make sure those are on the
  // way the moment anything joins a draft (one-shot).
  ensureKnockStatuses()
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
/** Undo restores the street list AND which doors were marked stolen — a
 * "Take them too" is one gesture, so one Undo takes it back whole. */
interface DraftSnapshot {
  segs: SegSnapshot[]
  steals: string[]
}
const undoStack = ref<DraftSnapshot[]>([])
const UNDO_CAP = 25
const canUndo = computed(() => undoStack.value.length > 0)

function snapshotDraft() {
  undoStack.value.push({
    segs: segments.value.map((s) => ({
      street_name: s.street_name,
      city: s.city,
      range_start: s.range_start,
      range_end: s.range_end,
      parity: s.parity,
    })),
    steals: [...stealIds.value],
  })
  if (undoStack.value.length > UNDO_CAP) undoStack.value.shift()
}

function undoDraft() {
  const snap = undoStack.value.pop()
  if (!snap) return
  segments.value = []
  expandedSegKey.value = null
  stealIds.value = new Set(snap.steals)
  for (const s of snap.segs) {
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
  stealIds.value = new Set()
  expandedSegKey.value = null
  saveError.value = ''
  defaultDraftParent()
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
  stealIds.value = new Set()
  expandedSegKey.value = null
  editingTurfId.value = null
  draftName.value = ''
  assignChoice.value = 'none'
  saveError.value = ''
  defaultDraftParent()
}

// A different parent = a different claim pool: recompute every sweep so door
// counts and shading track the pick.
watch(draftParentId, () => {
  for (const seg of segments.value) computeSegment(seg)
})

// --- Street taking ---

/** Draft segments already covering this street (in the same city, when
 * known) — consulted so a street can never land in the draft twice. */
function matchingSegments(streetName: string, city: string | null) {
  return segments.value.filter(
    (s) =>
      s.street_name === streetName &&
      (!s.city || !city || s.city.toUpperCase() === city.toUpperCase()),
  )
}

/** Streets can hold doors that were never geocoded, so their dots would sit
 * on empty map. Geocode the missing ones (dropping each dot as it resolves)
 * and optionally zoom to the street. `allMissing` = geocode the whole
 * street, used whenever the street is in the DRAFT — a saved turf geocodes
 * all its doors anyway (geocodeTurfDoors), so this only moves the same
 * one-time cost earlier; a mere search-locate stays capped. */
const GEOCODE_BATCH_CAP = 25

async function materializeStreetPins(
  streetName: string,
  city: string | null,
  zoomTo: boolean,
  allMissing = false,
) {
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

  const missing = rows
    .filter((a) => a.lat == null || a.lng == null)
    .slice(0, allMissing ? rows.length : GEOCODE_BATCH_CAP)
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
 * wearing the Add controls)? */
function isLocated(m: { street_name: string; city: string }): boolean {
  const l = locatedStreet.value
  return !!l && l.name === m.street_name && (l.city ?? '').toUpperCase() === m.city.toUpperCase()
}

/** Every door on the street already covered by the draft? The located row
 * shows a ✓ instead of the Add controls. */
function fullyInDraft(m: { street_name: string; city: string }): boolean {
  const segs = matchingSegments(m.street_name, m.city)
  if (!segs.length) return false
  const rows = streetRows(m.street_name, m.city)
  return rows.length > 0 && rows.every((a) => segs.some((s) => matchesSegment(a, s)))
}

// The located row's editable house-number range — prefilled with the whole
// street, narrow it to take just a portion ("fill in the house numbers").
const locatedFrom = ref(0)
const locatedTo = ref(0)

/** Doors the entered range would take (live count on the Add button). */
const locatedRangeCount = computed(() => {
  const l = locatedStreet.value
  if (!l) return 0
  const lo = Math.min(locatedFrom.value, locatedTo.value)
  const hi = Math.max(locatedFrom.value, locatedTo.value)
  return streetRows(l.name, l.city).filter((a) => {
    const n = houseNumber(a.street)
    return n >= lo && n <= hi
  }).length
})

/** Tapping a search result LOCATES the street: zooms the map to it and
 * paints its doors (geocoding a capped batch of unmapped ones). Taking it
 * is the explicit Add button that appears on the located row. */
function locateStreet(m: { street_name: string; city: string; lo: number; hi: number }) {
  locatedStreet.value = { name: m.street_name, city: m.city }
  locatedFrom.value = m.lo
  locatedTo.value = m.hi
  mapEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  void materializeStreetPins(m.street_name, m.city, true)
}

// --- Skipped-door stealing ---
// A capture NEVER silently includes doors another turf owns: they're
// skipped, the flash says so, and — when this cutter may re-cut the owner
// (canStealFrom) — the flash carries a "Take them too" button. Stealing
// marks the doors in stealIds (drafts treat them as claimable); the owning
// turf is only actually re-cut around them at save time.

/** The flash action for a batch of skipped doors, or null when none of
 * their owners can be stolen from. */
function stealActionFor(doors: AddressLite[]): { label: string; run: () => void } | null {
  const stealable = doors.filter((a) =>
    canStealFrom(a.turf_id ? turfById.value.get(a.turf_id) : undefined),
  )
  if (!stealable.length) return null
  return {
    label:
      stealable.length === doors.length
        ? 'Take them too'
        : `Take ${stealable.length} of them`,
    run: () => stealDoors(stealable),
  }
}

function stealDoors(doors: AddressLite[]) {
  snapshotDraft()
  for (const d of doors) stealIds.value.add(d.id)
  // Doors already inside a draft range just recompute in; the rest (a lasso
  // capture that never built a segment for them) join as honest runs.
  const uncovered = doors.filter((d) => {
    const name = streetNameOf(d.street)
    return !name || !matchingSegments(name, d.city).some((s) => matchesSegment(d, s))
  })
  for (const seg of segments.value) computeSegment(seg)
  if (uncovered.length) addDoorsAsSegments(uncovered)
  const n = doors.length
  flash(`Took ${n} door${n === 1 ? '' : 's'} — the other turf gives them up when you save.`)
}

/** Post-add flash for a street: honest got/skipped counts, with the steal
 * offer when doors were skipped. */
function flashAddResult(streetName: string, city: string | null, prefix: string) {
  const segsNow = matchingSegments(streetName, city)
  const got = segsNow.reduce((n, s) => n + s.doorCount, 0)
  const taken = segsNow.reduce((n, s) => n + s.takenCount, 0)
  if (!taken) {
    flash(`${prefix} — ${got} door${got === 1 ? '' : 's'}.`)
    return
  }
  const takenDoors = streetRows(streetName, city).filter(
    (a) => segsNow.some((s) => matchesSegment(a, s)) && !claimableDoor(a),
  )
  flash(
    `${prefix} — ${got} door${got === 1 ? '' : 's'} · ${taken} skipped (another turf's).`,
    stealActionFor(takenDoors),
  )
}

/** The located row's Add: the entered house-number range joins the draft
 * (defaults to the whole street; overlapping ranges fold together). */
function addLocatedStreet(m: { street_name: string; city: string }) {
  const lo = Math.min(locatedFrom.value, locatedTo.value)
  const hi = Math.max(locatedFrom.value, locatedTo.value)
  if (!locatedRangeCount.value) {
    flash(`No doors on ${m.street_name} between ${lo} and ${hi}.`)
    return
  }
  snapshotDraft()
  addSegment(m.street_name, m.city, lo, hi, 'both')
  flashAddResult(m.street_name, m.city, `Added ${m.street_name} ${lo}–${hi}`)
  void materializeStreetPins(m.street_name, m.city, false, true)
}

// --- Lasso: VAN-style region selection. Arm it, drag a loop, and every door
// inside joins the draft as street segments (split around doors you didn't
// circle). The map freezes while armed so the drag draws instead of pans;
// everything is hit-tested in memory, so the capture is instant. ---

const lassoActive = ref(false)
/** Shared Add/Erase mode for the armed tools (lasso + street tap): add puts
 * doors into the draft, erase takes them back out. The toggle only shows
 * while a tool is armed. */
const selectMode = ref<'add' | 'erase'>('add')
const lassoCanvasEl = ref<HTMLCanvasElement | null>(null)
let lassoPath: { x: number; y: number }[] = []
let lassoDrawing = false

function toggleLasso() {
  lassoActive.value = !lassoActive.value
  selectMode.value = 'add'
  streetTapActive.value = false
  doorInfo.value = null
  map?.setOptions({ gestureHandling: lassoActive.value ? 'none' : 'greedy' })
  lassoPath = []
  lassoDrawing = false
  if (lassoActive.value) {
    void nextTick(() => sizeLassoCanvas())
  }
}

// --- Armed street tap: tap the road itself on the basemap — no dots or
// overlay needed — and that street's every door joins the draft (or leaves
// it, in erase mode). The houses pop in as dots after the tap. ---

const streetTapActive = ref(false)
/** Fallback vote: how far (meters) a tap may sit from a mapped door for
 * that door's street to get a vote. */
const STREET_SNAP_METERS = 150
/** Fallback vote: a winner whose nearest mapped door is farther than this
 * needs a second confirming tap before it's added. */
const STREET_CONFIRM_METERS = 100

/** Fallback-vote guess awaiting its confirming second tap. */
let pendingTapStreet: { name: string; city: string } | null = null

function toggleStreetTap() {
  streetTapActive.value = !streetTapActive.value
  selectMode.value = 'add'
  doorInfo.value = null
  pendingTapStreet = null
  if (streetTapActive.value) {
    // One tool at a time — disarm the lasso and unfreeze the map.
    if (lassoActive.value) {
      lassoActive.value = false
      map?.setOptions({ gestureHandling: 'greedy' })
      lassoPath = []
      lassoDrawing = false
    }
    expandedSegKey.value = null
  }
}

/** Match reverse-geocoded route names to a voter-file street. Exact
 * normalized match first, then directional-stripped; ties break by Google's
 * locality, then by whichever candidate has mapped doors nearest the tap.
 * Ambiguity with no distance signal returns null — never guess N vs S. */
function matchIndexedStreet(rev: StreetAtPoint, lat: number, lng: number): { name: string; city: string } | null {
  let candidates: { name: string; city: string }[] = []
  for (const n of rev.names) candidates.push(...(streetsByNorm.get(n) ?? []))
  if (!candidates.length) {
    const stripped = rev.names.map(stripLeadingDirectional)
    for (const [norm, entries] of streetsByNorm) {
      if (stripped.includes(stripLeadingDirectional(norm))) candidates.push(...entries)
    }
  }
  const seen = new Set<string>()
  candidates = candidates.filter((c) => {
    const k = `${c.name}|${c.city.toUpperCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (!candidates.length) return null
  if (candidates.length === 1) return candidates[0]
  const inCity = rev.city
    ? candidates.filter((c) => c.city.toUpperCase() === rev.city!.toUpperCase())
    : []
  const pool = inCity.length ? inCity : candidates
  if (pool.length === 1) return pool[0]
  let best: { name: string; city: string } | null = null
  let bestD = Infinity
  for (const c of pool) {
    for (const a of streetRows(c.name, c.city)) {
      if (a.lat == null || a.lng == null) continue
      const d = roughMeters({ lat, lng }, { lat: a.lat, lng: a.lng })
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
  }
  return best
}

/** Fallback when reverse geocoding gets nothing usable: mapped doors within
 * STREET_SNAP_METERS vote for their street, weighted by closeness. */
function voteNearbyStreet(lat: number, lng: number): { name: string; city: string; nearest: number } | null {
  const acc = new Map<string, { name: string; city: string; w: number; nearest: number }>()
  for (const a of addressById.values()) {
    if (a.lat == null || a.lng == null) continue
    const d = roughMeters({ lat, lng }, { lat: a.lat, lng: a.lng })
    if (d > STREET_SNAP_METERS) continue
    const name = streetNameOf(a.street)
    if (!name) continue
    const key = `${name}|${a.city.toUpperCase()}`
    const v = acc.get(key) ?? { name, city: a.city, w: 0, nearest: Infinity }
    v.w += 1 / (d + 10)
    if (d < v.nearest) v.nearest = d
    acc.set(key, v)
  }
  let best: { name: string; city: string; nearest: number } | null = null
  let bestW = 0
  for (const v of acc.values()) {
    if (v.w > bestW) {
      bestW = v.w
      best = { name: v.name, city: v.city, nearest: v.nearest }
    }
  }
  return best
}

/** Resolve an armed-tool tap to a street. Primary: reverse-geocode the tap —
 * works on streets with zero mapped doors, which is exactly where the old
 * nearest-mapped-door guess added whole wrong streets (tap S CLINTON, get
 * E BOMFORD). Fallback: closeness-weighted vote among nearby mapped doors,
 * with a confirm-tap guard when even the winner's doors are far away. */
async function resolveTapStreet(lat: number, lng: number): Promise<{ name: string; city: string } | null> {
  const rev = await streetAtPoint(lat, lng)
  if (rev) {
    const hit = matchIndexedStreet(rev, lat, lng)
    if (hit) {
      pendingTapStreet = null
      return hit
    }
  }
  const vote = voteNearbyStreet(lat, lng)
  if (!vote) {
    flash(
      rev?.names.length
        ? `No voter doors on ${rev.names[0]}.`
        : 'No known street near that tap — try right on the road.',
    )
    return null
  }
  if (vote.nearest > STREET_CONFIRM_METERS) {
    const same =
      pendingTapStreet &&
      pendingTapStreet.name === vote.name &&
      pendingTapStreet.city.toUpperCase() === vote.city.toUpperCase()
    if (!same) {
      pendingTapStreet = { name: vote.name, city: vote.city }
      flash(`That looks like ${vote.name} — tap again to confirm.`)
      return null
    }
  }
  pendingTapStreet = null
  return vote
}

/** One tap at a time: a second tap while the first still resolves is
 * dropped, not queued (double-fires from impatient taps read as bugs). */
let streetTapBusy = false

async function handleStreetTap(latLng: google.maps.LatLng) {
  if (streetTapBusy) return
  streetTapBusy = true
  try {
    const resolved = await resolveTapStreet(latLng.lat(), latLng.lng())
    if (!resolved || unmounted) return
    applyStreetTap(resolved.name, resolved.city)
  } finally {
    streetTapBusy = false
  }
}

function applyStreetTap(name: string, city: string) {
  if (selectMode.value === 'erase') {
    const segs = matchingSegments(name, city)
    if (!segs.length) {
      flash(`${name} isn't in this turf.`)
      return
    }
    snapshotDraft()
    for (const s of segs) removeSegment(s)
    flash(`Removed ${name} from the turf.`)
    return
  }
  if (fullyInDraft({ street_name: name, city })) {
    flash(`${name} is already in this turf — switch to Erase to take it out.`)
    return
  }
  const rows = streetRows(name, city)
  const nums = rows.map((r) => houseNumber(r.street))
  snapshotDraft()
  addSegment(name, city, Math.min(...nums), Math.max(...nums), 'both')
  flashAddResult(name, city, `Added ${name}`)
  void materializeStreetPins(name, city, false, true)
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
  // Erase loops draw in the shared "this is a no" red so the intent reads
  // before the finger lifts.
  ctx.strokeStyle = selectMode.value === 'erase' ? '#d64545' : draftColor.value
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
  // The loop encloses doors, and the line itself brushes them — touching a
  // dot with the stroke counts, so a quick scribble over a few pins works.
  const ids = doorLayer?.doorsInPolygon(path, LASSO_BRUSH_PX) ?? []
  const doors = ids
    .map((id) => addressById.get(id))
    .filter((a): a is AddressLite => !!a)
  if (selectMode.value === 'erase') {
    const drafted = doors.filter((a) => draftMemberIds.value.has(a.id))
    if (!drafted.length) {
      flash(
        segments.value.length
          ? 'No draft doors in that loop — circle dots wearing the draft ring.'
          : 'Nothing to erase yet — Erase takes doors out of the turf being built. Add streets first, or open a turf and tap Edit.',
      )
      return
    }
    snapshotDraft()
    const { doorCount, streetCount } = removeDoorsFromDraft(drafted)
    // If the erased street was only painted because it's the search-located
    // one, its leftover dots would keep painting and read as "erase did
    // nothing" — drop the locate focus so removed doors actually vanish.
    const l = locatedStreet.value
    if (l && drafted.some((a) => doorOnStreet(a, l))) locatedStreet.value = null
    flash(
      `Lasso: removed ${doorCount} door${doorCount === 1 ? '' : 's'} across ${streetCount} street${streetCount === 1 ? '' : 's'}.`,
    )
    return
  }
  if (!doors.length) {
    flash(
      'No mapped doors in that loop — houses only get dots once their street is added or searched. Use the ☝ tool or search first.',
    )
    return
  }
  // Doors another turf owns never silently join a capture — they're
  // skipped, and the flash offers the steal when it's allowed.
  const free = doors.filter(claimableDoor)
  const taken = doors.filter((a) => !claimableDoor(a))
  if (!free.length) {
    flash(
      `Every door in that loop belongs to another turf (${taken.length} skipped).`,
      stealActionFor(taken),
    )
    return
  }
  snapshotDraft()
  const { doorCount, streetCount } = addDoorsAsSegments(free)
  if (!doorCount) {
    undoStack.value.pop()
    flash('Could not read streets for those doors — try a tighter loop.')
    return
  }
  flash(
    taken.length
      ? `Lasso: swept ${doorCount} door${doorCount === 1 ? '' : 's'} across ${streetCount} street${streetCount === 1 ? '' : 's'} · ${taken.length} skipped (another turf's).`
      : `Lasso: swept ${doorCount} door${doorCount === 1 ? '' : 's'} across ${streetCount} street${streetCount === 1 ? '' : 's'}.`,
    taken.length ? stealActionFor(taken) : null,
  )
  // Populate the dots: the captured streets usually hold doors that were
  // never geocoded (the lasso can only see mapped ones), so without this
  // the sweep sits half-blank.
  const streets: { name: string; city: string }[] = []
  const seen = new Set<string>()
  for (const a of free) {
    const name = streetNameOf(a.street)
    if (!name) continue
    const key = `${name}|${a.city.toUpperCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    streets.push({ name, city: a.city })
  }
  void geocodeCapturedStreets(streets)
}

/** After a lasso add, pin down the capture: geocode every door the new
 * segments COVER that still has no coordinates (validated results only),
 * dropping each dot as it lands. Focused on the covered ranges — not whole
 * streets — and with no street cap: the loop is the user's declared area of
 * interest (2026-07-24; the old 6-street whole-street drip left big
 * captures half-blank and geocoded houses nobody swept). */
async function geocodeCapturedStreets(streets: { name: string; city: string }[]) {
  const missing: AddressLite[] = []
  for (const s of streets) {
    const segs = matchingSegments(s.name, s.city)
    if (!segs.length) continue
    for (const row of streetRows(s.name, s.city)) {
      if (row.lat == null && segs.some((g) => matchesSegment(row, g))) missing.push(row)
    }
  }
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
  if (unmounted) return
  for (const s of streets) {
    for (const seg of matchingSegments(s.name, s.city)) computeSegment(seg)
  }
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
 * the lasso and trim-mode door toggling. Returns how many runs landed.
 *
 * `visible` (the add-lasso passes the street's GEOCODED numbers): only a
 * visible number the user left out splits a run — a door with no dot on the
 * map can't be "not circled", so invisible numbers between captured
 * neighbors ride along instead of punching phantom holes. */
function addStreetRuns(name: string, city: string | null, nums: Set<number>, visible?: Set<number>): number {
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
    } else if (lo != null && (!visible || visible.has(n))) {
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
    // Only doors with dots could be circled — invisible (ungeocoded) numbers
    // between captured neighbors must not split the runs.
    const visible = new Set<number>()
    for (const row of streetRows(g.name, g.city)) {
      if (row.lat != null && row.lng != null) visible.add(houseNumber(row.street))
    }
    if (addStreetRuns(g.name, g.city, g.nums, visible)) streetCount++
  }
  return { doorCount, streetCount }
}

/** Take a door selection OUT of the draft (the erase lasso), street by
 * street — each touched street's segments rebuild as honest runs of what
 * remains, so ranges shrink or split around the removed hole. */
function removeDoorsFromDraft(doors: AddressLite[]): { doorCount: number; streetCount: number } {
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
    const segs = matchingSegments(g.name, g.city)
    if (!segs.length) continue
    const remaining = new Set<number>()
    for (const row of streetRows(g.name, g.city)) {
      const n = houseNumber(row.street)
      if (!g.nums.has(n) && segs.some((s) => matchesSegment(row, s))) remaining.add(n)
    }
    for (const s of segs) removeSegment(s)
    if (remaining.size) addStreetRuns(g.name, g.city, remaining)
    streetCount++
  }
  return { doorCount, streetCount }
}

// --- Save / edit / delete ---

/** Segment payload for set_turf_segments. */
interface SegmentPayload {
  street_name: string
  city: string | null
  range_start: number
  range_end: number
  parity: TurfParity
}

/** A victim turf's segments with the stolen doors carved out: honest runs
 * over the house numbers it keeps, split at EVERY street number it doesn't
 * keep — stolen or never-owned — so a rebuilt range can never annex an
 * in-between door the victim didn't hold (ranges claim from the open pool
 * on re-cut). The server's honest-rewrite trims further anyway. */
function victimSegmentsMinus(victimId: string, stolen: Set<string>): SegmentPayload[] {
  const byStreet = new Map<string, { name: string; city: string; keep: Set<number> }>()
  for (const a of addressById.values()) {
    if (a.turf_id !== victimId) continue
    const name = streetNameOf(a.street)
    if (!name) continue
    const key = `${name}|${a.city.toUpperCase()}`
    let g = byStreet.get(key)
    if (!g) byStreet.set(key, (g = { name, city: a.city, keep: new Set() }))
    if (!stolen.has(a.id)) g.keep.add(houseNumber(a.street))
  }
  const out: SegmentPayload[] = []
  for (const g of byStreet.values()) {
    const laneNums = [
      ...new Set(streetRows(g.name, g.city).map((r) => houseNumber(r.street))),
    ].sort((a, b) => a - b)
    let lo: number | null = null
    let hi = 0
    for (const n of laneNums) {
      if (g.keep.has(n)) {
        if (lo == null) lo = n
        hi = n
      } else if (lo != null) {
        out.push({ street_name: g.name, city: g.city, range_start: lo, range_end: hi, parity: 'both' })
        lo = null
      }
    }
    if (lo != null) {
      out.push({ street_name: g.name, city: g.city, range_start: lo, range_end: hi, parity: 'both' })
    }
  }
  return out
}

/** Before the draft claims: re-cut every victim turf around the doors the
 * user chose to steal, so those doors land in this draft's claim pool
 * (unassigned for a top-level cut, the parent for a sub-cut). */
async function releaseStolenDoors() {
  const byVictim = new Map<string, Set<string>>()
  for (const id of stealIds.value) {
    const a = addressById.get(id)
    if (!a?.turf_id) continue // already free — nothing to release
    if (editingTurfId.value && a.turf_id === editingTurfId.value) continue
    if (a.turf_id === effectiveParentId.value) continue // parent pool: claimable as-is
    const set = byVictim.get(a.turf_id)
    if (set) set.add(id)
    else byVictim.set(a.turf_id, new Set([id]))
  }
  for (const [victimId, ids] of byVictim) {
    const { error } = await supabase.rpc('set_turf_segments', {
      target_turf_id: victimId,
      segments: victimSegmentsMinus(victimId, ids),
    })
    if (error) throw error
  }
}

// --- Copy-or-clear: a previous day's turfs still holding doors ---
// Turf is for today. When yesterday's turfs still hold doors, the manager
// picks: copy them into fresh today-rows (same streets/color/assignee — a
// day-squad dispatch never carries), or clear them (doors release; the old
// rows stay behind door-less, as history). Sub-turfs never copy — they were
// the old crew's internal split — their doors ride along with the parent.

async function clearStaleTurfs() {
  staleBusy.value = true
  try {
    const subs = staleTurfs.value.filter((t) => t.parent_turf_id)
    const tops = staleTurfs.value.filter((t) => !t.parent_turf_id)
    // Subs first: emptying a sub returns doors to its parent, and the
    // parent's emptying then releases them for good.
    for (const t of [...subs, ...tops]) {
      const { error } = await supabase.rpc('set_turf_segments', {
        target_turf_id: t.id,
        segments: [],
      })
      if (error) throw error
    }
    await reloadAll()
    flash('Cleared — every door is up for grabs today.')
  } catch {
    flash('Could not clear the old turf — try again.')
  } finally {
    staleBusy.value = false
  }
}

async function copyStaleTurfs() {
  staleBusy.value = true
  try {
    // Fold day-crew sub-splits back into their parents first.
    for (const sub of staleTurfs.value.filter((t) => t.parent_turf_id)) {
      const { error } = await supabase.rpc('set_turf_segments', {
        target_turf_id: sub.id,
        segments: [],
      })
      if (error) throw error
    }
    for (const t of staleTurfs.value.filter((t) => !t.parent_turf_id)) {
      const segs: SegmentPayload[] = t.turf_segments.map((s) => ({
        street_name: s.street_name,
        city: s.city,
        range_start: s.range_start,
        range_end: s.range_end,
        parity: s.parity,
      }))
      const { data, error } = await supabase
        .from('turfs')
        .insert({
          name: t.name,
          color: t.color,
          assignee_id: t.assignee_id,
          squad_id: null,
          parent_turf_id: null,
          created_by: auth.profile?.id,
        })
        .select('id')
        .single()
      if (error || !data) throw error ?? new Error('insert failed')
      // Release the old rows' doors, then claim them under the fresh turf.
      const { error: freeErr } = await supabase.rpc('set_turf_segments', {
        target_turf_id: t.id,
        segments: [],
      })
      if (freeErr) throw freeErr
      const { error: claimErr } = await supabase.rpc('set_turf_segments', {
        target_turf_id: data.id as string,
        segments: segs,
      })
      if (claimErr) throw claimErr
    }
    await reloadAll()
    flash('Copied to today — same turf, fresh day.')
  } catch {
    flash('Could not copy the old turf — reload and try again.')
  } finally {
    staleBusy.value = false
  }
}

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
    name = who ? `${who}'s turf` : `Turf ${todayTurfs.value.length + 1}`
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
    // Stolen doors: carve them out of their owners first, so the claim
    // below actually gets them.
    await releaseStolenDoors()
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
  for (const s of t.turf_segments) {
    addSegment(s.street_name, s.city, s.range_start, s.range_end, s.parity)
  }
  focusTurf(t.id)
  focusDraft()
  // The whole turf should be pinned while it's being edited — geocode its
  // still-unmapped doors in the background (same pass a save runs).
  void geocodeTurfDoors(t.id)
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
  cityLayer?.dispose()
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
        <!-- One optional action on the flash — e.g. "Take them too" after a
             capture skipped another turf's doors. -->
        <button v-if="flashAction" class="btn btn-sm btn-primary sweep-action" @click="runFlashAction">
          {{ flashAction.label }}
        </button>
      </div>

      <!-- Turf is for today: a previous day's turfs still holding doors get
           resolved here — copied into fresh today-rows, or cleared so every
           door is up for grabs. -->
      <div v-if="isManager && staleTurfs.length" class="card stale-card">
        <p class="stale-text">
          <strong>{{ staleTurfs.filter((t) => !t.parent_turf_id).length }}
            turf{{ staleTurfs.filter((t) => !t.parent_turf_id).length === 1 ? '' : 's' }}</strong>
          from {{ staleDaysLabel }} still hold{{ staleTurfs.length === 1 ? 's' : '' }} doors.
          Copy {{ staleTurfs.length === 1 ? 'it' : 'them' }} to today, or clear the ground and
          cut fresh.
        </p>
        <div class="stale-actions">
          <button class="btn btn-primary btn-sm" :disabled="staleBusy" @click="copyStaleTurfs">
            {{ staleBusy ? 'Working…' : 'Copy to today' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="staleBusy" @click="clearStaleTurfs">
            Clear them
          </button>
        </div>
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
          <!-- Located row: edit the house-number range (prefilled = whole
               street) and Add takes exactly that stretch. -->
          <div v-if="isLocated(m)" class="street-match-actions">
            <span v-if="fullyInDraft(m)" class="muted street-match-in">All in this turf ✓</span>
            <template v-else>
              <input
                v-model.number="locatedFrom"
                type="number"
                class="seg-num range-num"
                min="0"
                aria-label="From house number"
              />
              <span class="muted">–</span>
              <input
                v-model.number="locatedTo"
                type="number"
                class="seg-num range-num"
                min="0"
                aria-label="To house number"
              />
              <button
                class="btn btn-sm btn-primary street-match-add"
                :disabled="!locatedRangeCount"
                @click="addLocatedStreet(m)"
              >
                Add {{ locatedRangeCount }} door{{ locatedRangeCount === 1 ? '' : 's' }}
              </button>
            </template>
          </div>
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
        <!-- Flip every pin between a colored dot and its house number, same
             control as Scout. Top-left, above the layer toggle. -->
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
        <!-- Map layers: other turfs' doors (taken symbols) and city limits.
             Stacked directly beneath the pin-style toggle. -->
        <div class="layer-toggle" role="group" aria-label="Map layers">
          <button
            type="button"
            class="layer-btn"
            :class="{ active: showTakenDoors }"
            :aria-pressed="showTakenDoors"
            title="Mark doors that belong to other turfs"
            @click="toggleTakenDoors"
          >
            Turf
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
        <!-- Selection tools, top-right: Lasso (freezes the map, drag a
             loop) and Streets (tap the road itself to take a whole
             street). While either is armed, Add/Erase picks what it does. -->
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
          <button
            type="button"
            class="layer-btn"
            :class="{ active: streetTapActive }"
            :aria-pressed="streetTapActive"
            title="Tap a street on the map to take (or remove) every door on it"
            @click="toggleStreetTap"
          >
            ☝ Streets
          </button>
          <template v-if="lassoActive || streetTapActive">
            <button
              type="button"
              class="layer-btn"
              :class="{ active: selectMode === 'add' }"
              :aria-pressed="selectMode === 'add'"
              title="Add the selection to the turf"
              @click="selectMode = 'add'"
            >
              Add
            </button>
            <button
              type="button"
              class="layer-btn lasso-erase"
              :class="{ active: selectMode === 'erase' }"
              :aria-pressed="selectMode === 'erase'"
              title="Remove the selection from the turf"
              @click="selectMode = 'erase'"
            >
              Erase
            </button>
          </template>
        </div>
        <!-- Compact house history: tap a dot (no tool armed) to see the
             door's last knocks. -->
        <div v-if="doorInfo" class="door-card">
          <div class="door-card-head">
            <strong class="door-card-street">{{ doorInfo.address.street }}</strong>
            <span class="muted">{{ doorInfo.address.city }}</span>
            <button class="door-card-x" aria-label="Close house history" @click="doorInfo = null">✕</button>
          </div>
          <!-- Which turf owns this door + the deliberate hop into editing
               it — a taken symbol on the map should always explain itself. -->
          <div v-if="doorOwner" class="door-card-owner">
            <span class="door-card-owner-text">
              In <strong>{{ doorOwner.name }}</strong>
              <span class="muted"> — {{ ownerAssignment(doorOwner) }}</span>
            </span>
            <button
              v-if="canManage(doorOwner) && isTodayTurf(doorOwner)"
              class="btn btn-ghost btn-sm door-card-owner-edit"
              @click="editOwnerTurf(doorOwner)"
            >
              Edit this turf
            </button>
          </div>
          <!-- Who's registered here, ✓ = has signed — two names with one
               check is exactly why a door paints yellow instead of green. -->
          <div v-if="!doorInfo.loading && doorInfo.roster.length" class="door-card-roster">
            <span
              v-for="p in doorInfo.roster"
              :key="p.id"
              class="door-card-person"
              :class="{ signed: p.signed }"
            >{{ p.name }}<span v-if="p.signed" aria-hidden="true"> ✓</span></span>
          </div>
          <p v-if="doorInfo.loading" class="muted door-card-note">Loading history…</p>
          <p v-else-if="!doorInfo.knocks.length" class="muted door-card-note">Never knocked.</p>
          <ul v-else class="door-card-list">
            <li v-for="(k, i) in doorInfo.knocks" :key="i" class="door-card-row">
              <span class="door-card-dot" :style="{ background: OUTCOME_HEX[k.outcome] }" aria-hidden="true"></span>
              <span class="door-card-outcome">{{ OUTCOME_LABELS[k.outcome] }}</span>
              <span v-if="knockWho(k)" class="muted door-card-who">{{ knockWho(k) }}</span>
              <span class="muted door-card-when">{{ knockWhen(k.occurred_at) }}</span>
            </li>
          </ul>
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
          <!-- Streets table: ONE row per street. Multiple chunks on the same
               street (a trimmed hole splits a run) list their ranges side by
               side, left to right, as individually tappable chips. Tapping
               the row (or a chip) opens the editor below AND focuses TRIM
               mode on that street (its doors paint; each map tap
               drops/restores a house). -->
          <div class="seg-table" role="table" aria-label="Streets in this turf">
            <div class="seg-thead" role="row">
              <span role="columnheader">Street</span>
              <span role="columnheader">Numbers</span>
              <span role="columnheader" class="seg-col-num">Doors</span>
              <span role="columnheader" aria-label="Remove"></span>
            </div>
            <div
              v-for="group in streetGroups"
              :key="group.key"
              class="seg-row"
              :class="{ open: isGroupOpen(group), empty: !group.doorCount }"
              role="row"
              @click="toggleGroupEditor(group)"
            >
              <span class="seg-street-name" role="cell">{{ group.street_name }}</span>
              <span class="seg-range-text" role="cell">
                <button
                  v-for="seg in group.segs"
                  :key="seg.key"
                  type="button"
                  class="seg-range-chip"
                  :class="{ active: expandedSegKey === seg.key }"
                  @click.stop="toggleSegEditor(seg.key)"
                >{{ rangeLabel(seg) }}</button>
              </span>
              <span class="seg-count" role="cell">{{ group.doorCount }}</span>
              <button
                class="seg-x"
                :aria-label="`Remove ${group.street_name}`"
                @click.stop="removeGroupWithUndo(group)"
              >
                ✕
              </button>
            </div>
          </div>
          <!-- Editor for the open row: house-number range, side, and
               trim-by-tapping on the map. -->
          <div v-if="expandedSeg" class="seg-editor">
            <div class="seg-editor-title">
              <strong>{{ expandedSeg.street_name }}</strong>
              <span class="muted">{{ expandedSeg.city ?? 'any city' }}</span>
              <span class="seg-doors" :class="{ 'seg-doors-empty': !expandedSeg.doorCount }">
                {{ expandedSeg.doorCount }} doors
              </span>
            </div>
            <div class="seg-editor-controls">
              <input
                type="number"
                class="seg-cell-num"
                :value="expandedSeg.range_start"
                min="0"
                aria-label="Range start"
                @change="expandedSeg.range_start = Number(($event.target as HTMLInputElement).value); onSegmentRangeChange(expandedSeg)"
              />
              <span class="muted">–</span>
              <input
                type="number"
                class="seg-cell-num"
                :value="expandedSeg.range_end"
                min="0"
                aria-label="Range end"
                @change="expandedSeg.range_end = Number(($event.target as HTMLInputElement).value); onSegmentRangeChange(expandedSeg)"
              />
              <select
                class="seg-side-select"
                :value="expandedSeg.parity"
                aria-label="Which side of the street"
                @change="onSegmentParityChange(expandedSeg, ($event.target as HTMLSelectElement).value)"
              >
                <option value="both">Both sides</option>
                <option value="even">Even side</option>
                <option value="odd">Odd side</option>
              </select>
            </div>
            <p class="muted seg-trim-hint">
              Tap this street's doors on the map to drop or restore each house. Tap the row again
              when you're done.
            </p>
            <p v-if="expandedSeg.takenCount" class="muted seg-trim-hint">
              {{ expandedSeg.takenCount }} door{{ expandedSeg.takenCount === 1 ? '' : 's' }} in
              this range belong to another turf — skipped.
            </p>
          </div>
        </template>
        <p v-else class="muted empty-note">
          Nothing here yet — type a street name above, tap the match, then Add. Narrow the
          house numbers first to take just part of a street, or circle a patch with Lasso.
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
            {{ draftTakenCount }} door{{ draftTakenCount === 1 ? '' : 's' }} inside these ranges
            belong{{ draftTakenCount === 1 ? 's' : '' }} to another turf and
            {{ draftTakenCount === 1 ? 'is' : 'are' }} skipped.
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

/* Segmented dots/numbers control, top-left, same chrome as Scout's. */
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

/* Segmented layers control, stacked directly beneath the pin-style toggle. */
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

/* Erase mode wears the outcomes' fixed "no" red, not the theme accent. */
.layer-btn.lasso-erase.active {
  background: #d64545;
}

.layer-btn:not(.active):hover {
  background: var(--surface-2);
}

/* Compact house-history card, pinned to the map's bottom edge. */
.door-card {
  position: absolute;
  left: 0.6rem;
  right: 0.6rem;
  bottom: 0.6rem;
  z-index: 6;
  padding: 0.5rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  max-height: 45%;
  overflow-y: auto;
}

.door-card-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.door-card-street {
  font-size: 0.95rem;
}

.door-card-head > .muted {
  flex: 1;
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.door-card-x {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  cursor: pointer;
  padding: 0 0.15rem;
}

.door-card-x:hover {
  color: var(--danger);
}

.door-card-note {
  margin: 0.3rem 0 0;
  font-size: 0.85rem;
}

/* Ownership line for doors another turf holds — names the turf and offers
   the deliberate hop into editing it. */
.door-card-owner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.3rem;
}

.door-card-owner-text {
  flex: 1;
  min-width: 0;
  font-size: 0.82rem;
}

.door-card-owner-edit {
  flex-shrink: 0;
}

/* Registered voters at the door; ✓ = signed. The green matches the Signed
   outcome hex on purpose — same meaning as the pin colors. */
.door-card-roster {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.35rem;
}

.door-card-person {
  font-size: 0.78rem;
  line-height: 1.2;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  white-space: nowrap;
}

.door-card-person.signed {
  border-color: #2e9e5b;
  color: #2e9e5b;
  font-weight: 600;
}

.door-card-list {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.door-card-row {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-size: 0.85rem;
}

.door-card-dot {
  flex-shrink: 0;
  align-self: center;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
}

.door-card-outcome {
  font-weight: 700;
  white-space: nowrap;
}

.door-card-who {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
}

.door-card-when {
  flex-shrink: 0;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
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

/* Match rows: tap the name to locate; the located row grows a second line
 * with the house-number range and the Add button. */
.street-match {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 0.6rem;
  min-height: 44px;
  padding: 0.35rem 0.5rem 0.35rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.street-match-actions {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0 0.25rem;
}

.range-num {
  width: 4.8rem;
  min-height: 38px;
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

/* --- Streets table: one THIN text row per swept stretch (2026-07-24
   night — "more compact, just rows and columns"). No inline inputs; the
   open row's editor sits below the table. --- */

.seg-table {
  display: flex;
  flex-direction: column;
  margin-bottom: 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.seg-thead,
.seg-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 2.4rem 1.9rem;
  align-items: center;
  gap: 0.4rem;
  padding: 0 0.2rem 0 0.55rem;
}

.seg-thead {
  min-height: 24px;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}

.seg-row {
  min-height: 36px;
  background: var(--surface);
  cursor: pointer;
}

.seg-row + .seg-row {
  border-top: 1px solid var(--border);
}

/* The open row is the map's trim target. */
.seg-row.open {
  background: color-mix(in srgb, var(--draft-color) 10%, var(--surface));
  box-shadow: inset 3px 0 0 var(--draft-color);
}

.seg-street-name {
  font-weight: 700;
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Multiple chunks on one street list side by side, left to right. */
.seg-range-text {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.15rem;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.seg-range-chip {
  padding: 0.05rem 0.3rem;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}

.seg-range-chip:hover {
  background: var(--surface-2);
}

.seg-range-chip.active {
  background: color-mix(in srgb, var(--draft-color) 22%, transparent);
  color: var(--text);
  font-weight: 700;
}

.seg-count {
  font-size: 0.8rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--draft-color);
}

.seg-col-num {
  text-align: right;
}

.seg-row.empty .seg-count {
  color: var(--danger);
}

.seg-x {
  min-height: 34px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
}

.seg-x:hover {
  color: var(--danger);
}

/* Editor for the open row. */
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
  flex: 1;
  font-size: 0.82rem;
}

.seg-doors {
  font-size: 0.85rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.seg-doors-empty {
  color: var(--danger);
}

.seg-editor-controls {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.seg-cell-num {
  width: 4.6rem;
  min-height: 40px;
  padding: 0.3rem 0.4rem;
  font: inherit;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.seg-cell-num:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.seg-side-select {
  min-height: 40px;
  padding: 0.3rem 0.4rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.seg-trim-hint {
  margin: 0;
  font-size: 0.8rem;
}

/* Flash action button in the sweep bar ("Take them too"). */
.sweep-action {
  flex-shrink: 0;
}

/* Copy-or-clear prompt for a previous day's turfs. */
.stale-card {
  border-left: 6px solid #d97706;
}

.stale-text {
  margin: 0 0 0.5rem;
  font-size: 0.88rem;
}

.stale-actions {
  display: flex;
  gap: 0.5rem;
}

/* Base number-input style shared with the located search row. */
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
