<script lang="ts">
/**
 * Where the map was left, remembered for the life of the page (2026-07-27,
 * user call: going to Canvass and back, "it's not staying on the same part of
 * the map, and it does that just fine in Scout").
 *
 * Scout stays put because App.vue's `<keep-alive>` names CanvasserHomeView and
 * nothing else, so Scout is never torn down. /turf is remounted on every visit:
 * a fresh map at the fallback centre, then a flight to geolocation, which threw
 * away the view the canvasser had deliberately set, every single trip.
 *
 * THIS BLOCK EXISTS BECAUSE `<script setup>` IS NOT MODULE SCOPE. Everything
 * declared at the top of a `<script setup>` compiles INTO the setup function,
 * so it is per instance and a remount starts it over — a `let` up there would
 * read exactly like this and do nothing at all. A plain `<script>` alongside it
 * runs once, in the real module scope, and its bindings are visible to the
 * setup block below.
 *
 * Module scope and NOT localStorage, deliberately: it then lasts exactly as
 * long as keep-alive would, so this behaves like Scout rather than merely near
 * it. A fresh page load has no memory and still opens on where the canvasser is
 * standing, which is what `zoomToMe` is for and is right at the start of a
 * shift. Persisting it across loads would strand somebody who drove to another
 * town on yesterday's view, and this page has no locate button to escape with.
 */
export let lastCamera: { lat: number; lng: number; zoom: number } | null = null

export function rememberCameraOf(map: google.maps.Map | null) {
  const c = map?.getCenter()
  const z = map?.getZoom()
  if (!c || z == null) return
  lastCamera = { lat: c.lat(), lng: c.lng(), zoom: z }
}
</script>

<script setup lang="ts">
// Turf cutter, SEARCH-FIRST (2026-07-24 rework): the flow is type a street
// name, tap a match (the map zooms to it), then tap "Add to turf" on the
// match to take every door. Drafted streets live in a compact TABLE: one
// thin text row per street; tapping a row opens the range/side editor below
// the table AND focuses TRIM mode — that street's doors paint and each map
// tap drops or restores one house. The Lasso still circles a whole patch at
// once, and Save / Start over / Cancel sit in the row directly under the
// map, where your thumb already is.
//
// A turf is never drawn as a SHAPE here — no areas, no outlines. Doors carry
// everything: status in the fill, the owning turf in the ring, one color per
// turf however it's split up inside. See the paint-state section below.
//
// TURF IS FOR TODAY (2026-07-24 night, user call): the cutter only works
// with turfs cut TODAY (local day of created_at). When a previous day's
// turfs still hold doors, a prompt offers "Copy to today" (fresh rows, same
// streets/assignee — day squads never carry) or "Clear" (their doors
// release; the old rows stay behind, door-less, as history). Doors owned by
// another turf never silently join a capture — they're skipped with a
// flash that names who holds them and where to free them, and offers a
// "Take them too" steal when this draft may re-cut the owner (a top-level
// cut takes top-level turfs, a sub-cut takes siblings — canStealFrom).
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
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { attachPoiTapGuard, loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  CityLimitsLayer,
  readMapPref,
  readPinMode,
  writeMapPref,
  writePinMode,
} from '@/lib/mapLayers'
import type { PinMode } from '@/lib/mapLayers'
import {
  DoorCanvasLayer,
  NUMBERS_MIN_ZOOM,
  PINS_MIN_ZOOM,
  TAP_RADIUS_PX,
} from '@/lib/doorCanvas'
import type { DoorBadge, DoorPaintState } from '@/lib/doorCanvas'
import { createBadgeFactory } from '@/lib/doorBadges'
import type { BadgePerson } from '@/lib/doorBadges'
import { afterScrollUnlock } from '@/lib/appChrome'
import { attachMapScrollGuard } from '@/lib/mapScroll'
import type { MapScrollGuard } from '@/lib/mapScroll'
import {
  geocodeAndCache,
  geocodeMissing,
  normalizeStreetName,
  streetAtPoint,
  stripLeadingDirectional,
} from '@/lib/geocode'
import type { StreetAtPoint } from '@/lib/geocode'
import { localToday, startOfLocalDayISO } from '@/lib/day'
import { memberColor } from '@/lib/memberColors'
import {
  OUTCOME_HEX,
  OUTCOME_SHORT,
  doorPartlySigned,
  doorStatusOutcome,
} from '@/lib/outcomes'
import { fetchAllRows, supabase } from '@/lib/supabase'
import { doorCache, whenIdle } from '@/lib/addressCache'
import {
  fetchDoors,
  fetchDoorsInBox,
  fetchDoorsStaged,
  fetchStreetSummaries,
  type DoorBox,
  type StreetSummary,
} from '@/lib/doorData'
import { houseNumber, streetNameOf, titleCase } from '@/lib/streetWalk'
import { decodeTurfPlan } from '@/lib/turfPlan'
import { useRoute, useRouter } from 'vue-router'
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

/** How long this page is allowed to present itself as loading (2026-07-27, user
 * call: "a cold load stops at four seconds, just so that it's not taking
 * forever").
 *
 * It is a cap on the WAITING, not on the fetching. The county keeps arriving
 * quietly behind it, because the alternative — abandoning the read — would
 * leave the street index permanently short and every door count on the page
 * wrong for the rest of the session. What the canvasser gets in those four
 * seconds is the part that matters: the streets, from the database, and the
 * doors in front of them. Door counts keep saying "counting…" until they can
 * be right, which is the one thing that must not be hurried. */
const LOAD_BADGE_MS = 4000
let loadBadgeTimer: ReturnType<typeof setTimeout> | null = null

function stopLoadBadge() {
  pinsLoading.value = false
  if (loadBadgeTimer) clearTimeout(loadBadgeTimer)
  loadBadgeTimer = null
}

function startLoadBadge() {
  pinsLoading.value = true
  if (loadBadgeTimer) clearTimeout(loadBadgeTimer)
  loadBadgeTimer = setTimeout(stopLoadBadge, LOAD_BADGE_MS)
}
const loadError = ref('')
const saveError = ref('')
const saving = ref(false)

const turfs = ref<TurfWithMeta[]>([])
/** Has the turfs query actually answered? An empty list means "none" only
 * after this is true; before it, it means "not yet", and the two empty states
 * below say very different things. Without it the page claims "No turf cut
 * yet." for as long as the query takes, which is a positive statement of fact
 * made before anything is known. */
const turfsLoaded = ref(false)
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
// PINS_MIN_ZOOM / NUMBERS_MIN_ZOOM / TAP_RADIUS_PX are shared with Scout and
// Squad (src/lib/doorCanvas.ts) — all three maps change scale together.
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
  // The editor is about ONE street, so put it on screen: disarm the street
  // tool (its taps would fight yours) and zoom there.
  streetTapActive.value = false
  doorInfo.value = null
  const seg = segments.value.find((s) => s.key === key)
  // Pin down the street's unmapped doors so there's something to tap.
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
  return `${s.range_start} to ${s.range_end}${side}`
}

function isGroupOpen(g: StreetGroup): boolean {
  return g.segs.some((s) => s.key === expandedSegKey.value)
}

/** Chip tap inside an open street: switch which stretch the editor is on.
 *  Tapping the chip you're already on is a no-op — collapsing the street out
 *  from under your finger isn't what picking a stretch means. */
function openSegChunk(key: string) {
  if (expandedSegKey.value === key) return
  toggleSegEditor(key)
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

const route = useRoute()
const router = useRouter()
const editingTurfId = ref<string | null>(null)
/** Set when this draft was pre-built from an AI chat suggestion (?plan=…).
 * Drives the banner on the draft card — the draft is otherwise completely
 * ordinary, and only a human pressing Save ever writes anything. */
const planNote = ref('')
/** Is the cutting UI open at all? (2026-07-24 later still, user call: "you
 * should have to actually select create new turf".) Closed = the page is a
 * pure turf OVERVIEW — no draft card, and the map colors other turfs by
 * owner instead of crossing them out. Opened by "Create new turf" or by
 * editing an existing one. */
const draftOpen = ref(false)
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
/** Prebuilt search list: one row per street+city with count and span. Built
 * from whatever is indexed so far, so it is only the whole county once
 * `indexComplete` says so — until then the search box prefers the server's
 * list (see searchSummaries below). */
let streetSummaries: StreetSummary[] = []
/** A page has landed since streetSummaries was last flattened. */
let summariesDirty = false
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
  return first === last ? first : `${first} to ${last}`
})

/** Street summaries accumulate across pages (see addToIndex), so the map they
 * are built in outlives any single call. */
const streetSummaryByKey = new Map<string, StreetSummary>()

/** Bumped whenever the address index changes.
 *
 * `addressById` is a bare Map on purpose — 22,746 rows behind a Vue proxy
 * would cost far more than it could ever pay back — but that means filling it
 * signals the template NOTHING, and anything derived from it goes stale in
 * silence. That is not hypothetical: `fetchTurfs` resolves in ~450ms while the
 * index takes longer, so `dispatchTurfs` computed its door counts against an
 * EMPTY map, cached them, and every turf in the list read "0 doors" until some
 * unrelated ref happened to change and force a re-render (measured at 49s).
 * The data was there in under a second; only the number was wrong.
 *
 * So the index gets one reactive handle, and everything derived from it reads
 * this. Bump it through bumpIndexVersion() wherever the Map is written. */
const addressIndexVersion = ref(0)

/** How often a streaming load may invalidate everything built on the index.
 *
 * The bump used to fire once per PAGE, and a cold load is 32 of them. Anything
 * derived from the index is a tally over 22,746 rows, so each bump re-ran every
 * one of those AND re-rendered whatever they feed. Throttling costs nothing
 * real: a number that lands 200ms late during a load that takes seconds is
 * still a number climbing honestly, and the states that must be exact — a
 * finished load, a wholesale replacement after a save — bump immediately and
 * cancel any pending one, so the last word is never a stale trailing timer. */
const INDEX_BUMP_MS = 200
let indexBumpTimer: ReturnType<typeof setTimeout> | null = null

function bumpIndexVersion(immediate = false) {
  if (immediate) {
    if (indexBumpTimer) {
      clearTimeout(indexBumpTimer)
      indexBumpTimer = null
    }
    addressIndexVersion.value++
    return
  }
  // Throttle, not debounce: a scheduled bump is left alone rather than pushed
  // further out, so a continuous stream of pages still reports progress instead
  // of going quiet until it stops.
  if (indexBumpTimer) return
  indexBumpTimer = setTimeout(() => {
    indexBumpTimer = null
    addressIndexVersion.value++
  }, INDEX_BUMP_MS)
}

/** Is the index the WHOLE county, or only as much of it as has arrived?
 *
 * Every door count on this page is a tally over the index, so a partial index
 * doesn't make them approximate, it makes them wrong — and a number that is
 * quietly climbing reads exactly like a number that has finished. The cold load
 * now also paints the viewport first, so a partial index is geographically
 * lopsided too: the turf on screen would show its real count while one across
 * the county showed nothing. So counts say "counting…" until this is true,
 * which on every visit after the first is immediately (the device's own copy
 * arrives complete). */
const indexComplete = ref(false)

/** Has the street index actually loaded? Until it has, a door count isn't zero,
 *  it's unknown, and the difference matters on a page about who holds what. */
const addressesReady = computed(() => indexComplete.value && addressById.size > 0)

/** The street list from the database (migration 20260727120000): the search box
 * is usable in two requests instead of twenty-three, because searching streets
 * never needed the doors underneath them. DISPLAY ONLY — see lib/doorData.ts.
 * Superseded by the client's own summaries the moment the index is complete, so
 * the two can only ever disagree during a first load. */
const serverSummaries = ref<StreetSummary[]>([])

/** What the search box actually searches. Client-computed once the whole county
 * is indexed (the authority, and the same objects the rest of the page reasons
 * about); the server's list before that; the partial client one if the server's
 * never arrived. */
function searchSummaries(): StreetSummary[] {
  if (indexComplete.value) return clientSummaries()
  return serverSummaries.value.length ? serverSummaries.value : clientSummaries()
}

/** The index's own street list, flattened on demand. Rebuilt only when a page
 *  has landed since the last read — during a load nobody is reading it. */
function clientSummaries(): StreetSummary[] {
  if (summariesDirty) {
    streetSummaries = [...streetSummaryByKey.values()]
    summariesDirty = false
  }
  return streetSummaries
}

function resetIndex() {
  addressById.clear()
  streetsByKey.clear()
  streetsByName.clear()
  streetsByNorm.clear()
  streetSummaryByKey.clear()
  streetSummaries = []
  summariesDirty = false
  indexComplete.value = false
  bumpIndexVersion(true)
}

/** Fold one page of addresses into the street indexes. Kept separate from
 * resetIndex so startup can index each page as it lands (loadCutterData)
 * rather than holding everything back until the 24th one: the county table
 * is several seconds of paging even on a good connection, and the whole
 * point of this page is searching streets. */
function addToIndex(rows: AddressLite[]) {
  const summaries = streetSummaryByKey
  for (const a of rows) {
    // Paged reads are disjoint, but the viewport-first read and the on-demand
    // single-street read both overlap them BY DESIGN — so a door already in the
    // index is skipped rather than pushed into its street's array a second
    // time, which would double that street's door count and its segments.
    // (Wholesale replacements go through indexAddresses, which resets first.)
    if (addressById.has(a.id)) continue
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
  // The flat list is rebuilt on READ, not here: 1,244 entries copied on every
  // one of a cold load's 32 pages, for a list only the search box ever asks for.
  summariesDirty = true
  // Throttled, so the door counts still climb as the county lands without
  // every page invalidating every tally built on the index.
  bumpIndexVersion()
}

/** Replace the whole index (the post-save reloadAll path, where the row set
 * arrives complete). */
function indexAddresses(rows: AddressLite[]) {
  resetIndex()
  addToIndex(rows)
  indexComplete.value = true
  // The set is complete as of right now: nothing derived from it may sit on a
  // throttled bump scheduled mid-fill.
  bumpIndexVersion(true)
}

/** One street's doors, pulled on demand.
 *
 * The search list can name a street before the county has finished arriving
 * (it comes from the database, not the index), and a row you can see but can't
 * act on is worse than one that isn't there yet. So locating a street the index
 * doesn't hold yet fetches just that street: one small query, folded in, and
 * everything downstream — ranges, counts, claiming — works off the real rows as
 * usual. Once the whole table is in, there is by definition nothing to fetch. */
async function ensureStreetRows(name: string, city: string | null): Promise<void> {
  if (indexComplete.value || streetRows(name, city).length) return
  try {
    const rows = await fetchDoors<AddressLite>({
      select: ADDRESS_COLUMNS,
      streetEndsWith: name,
    })
    if (unmounted) return
    // The query matches any street ENDING in this name ("MAIN ST" also catches
    // "N MAIN ST"), so the client's own parsing decides what actually belongs.
    const exact = rows.filter(
      (a) =>
        streetNameOf(a.street) === name &&
        (!city || a.city.toUpperCase() === city.toUpperCase()),
    )
    if (!exact.length) return
    addToIndex(exact)
    for (const a of exact) {
      if (a.lat != null && a.lng != null) doorLayer?.upsertDoor(canvasDoorOf(a))
    }
    doorLayer?.requestRepaint()
  } catch {
    // No signal: the street stays unlocatable until the county load catches up.
  }
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
// The cutter's "Turf" button gates exactly ONE thing: whether every door
// wears the color of the turf that owns it. One meaning, the same in
// overview and while cutting (2026-07-25) — no area shading, no symbols,
// no mode where the colors go away. ON by default here, unlike Scout and
// Squad, where nothing-toggled means plain status pins: this is the page
// that exists to show how the county is divided, so opening it with no
// division drawn was starting everyone one tap behind. Turn it off to read
// pure knock status. Deliberately NOT Scout's shared pref — its layer
// filters ITS map's doors.
const showTurfColors = ref(readMapPref('cutter-turf-layer', true))
const showCity = ref(readMapPref('map-show-city', false))

function toggleTurfColors() {
  showTurfColors.value = !showTurfColors.value
  writeMapPref('cutter-turf-layer', showTurfColors.value)
}

// Turf FOOTPRINTS are gone (2026-07-25, user call — "I actually don't want
// that; just having the individual dots colored is good enough"). The
// stroke-only convex hulls drawn around each turf read as a big empty
// polygon over the map, and the colored dots already say which ground is
// whose — at every zoom, since below PINS_MIN_ZOOM a door's turf ring paints
// as the halo around its 2px dot. TurfOutlineLayer went with it; see git
// history if a shape-per-turf is ever wanted back.

// Dots vs. house-number pills — same control as Scout's pin-style toggle,
// re-added to the cutter (2026-07-24 later still, user call). Own
// localStorage key, same pattern Hunt uses (not the boolean readMapPref
// helper — this is a 3-way-shaped string pref). Defaults to 'numbers' —
// unlike Hunt, the cutter always showed numbers automatically once zoomed
// in before this toggle existed, so 'numbers' is the behavior-preserving
// default; 'dots' still falls back automatically below NUMBERS_MIN_ZOOM.
const pinMode = ref<PinMode>(readPinMode('turf-pin-mode', 'numbers'))

function setPinMode(mode: PinMode) {
  if (pinMode.value === mode) return
  pinMode.value = mode
  writePinMode('turf-pin-mode', mode)
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

/** What saveTurf() would call this turf if you never type a name. Shown in
 * the editing bar so an unnamed draft still reads as something, rather than
 * as a blank. Mirrors the naming rule in saveTurf — keep the two together. */
const defaultDraftName = computed(() => {
  const opt = assignOptions.value.find((o) => o.value === assignChoice.value)
  const who = assignChoice.value !== 'none' && opt ? opt.label.split(': ')[1] : ''
  return who ? `${who}'s turf` : `Turf ${todayTurfs.value.length + 1}`
})
const draftTakenCount = computed(() => segments.value.reduce((n, s) => n + s.takenCount, 0))

/** Doors the user chose to STEAL from another turf ("Take them too" on the
 * skip flash). They count as claimable in every draft computation; at save
 * time the owning turf is re-cut around them first, so the draft's RPC can
 * actually claim them. Snapshotted/restored with Undo. */
const stealIds = ref(new Set<string>())

/** "Take" — destructive create (2026-07-25, user call). With it armed, every
 * sweep simply takes the doors it lands on, whoever holds them, instead of
 * skipping them and offering a "Take them too" button afterwards. The user's
 * words: "there is a toggle that lets you… but the button is called Take.
 * You take the turf. And that way, we don't have to have a dialogue."
 *
 * It changes nothing about what SAVING does — doors still get released from
 * their old turf first, honestly, by releaseStolenDoors(). It only removes
 * the per-sweep confirmation. Off by default and never persisted: this is a
 * mode you arm for one cut, not a setting you forget is on. */
const takeMode = ref(false)

/** Turning Take OFF keeps every door already taken (2026-07-25, user call:
 * "all Take does is make it so you can instantly take over and add it to the
 * turf that you're editing — and then when you click save, it actually saves
 * it to the database"). It used to hand back everything the mode had swept
 * in, which meant disarming the lasso reverted the doors you'd just taken
 * back to their old turf's color — the sweep looked like it had come undone.
 * The switch governs the NEXT sweep, nothing retroactive; Undo is how you
 * take a sweep back. */
function toggleTakeMode() {
  takeMode.value = !takeMode.value
  for (const seg of segments.value) computeSegment(seg)
  doorLayer?.requestRepaint()
}

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
  // Messages with a decision on them hang around longer — and so do the long
  // ones, which are the skip lines that name a holder and where to go next.
  flashTimer = setTimeout(
    () => {
      flashMsg.value = ''
      flashAction.value = null
    },
    action ? 8000 : msg.length > 80 ? 6500 : 3500,
  )
}

function runFlashAction() {
  const a = flashAction.value
  flashMsg.value = ''
  flashAction.value = null
  clearTimeout(flashTimer)
  a?.run()
}

// The sweep bar used to carry a standing instruction that changed with every
// armed tool, focused street and draft state. That whole ladder is gone
// (2026-07-25, user call): the tools say what they are, and the help tour is
// where explanation lives. What's left is transient feedback only, so the bar
// renders only while a flash is up.
const hint = computed(() => flashMsg.value)

// --- Assignment options: today's squads + every canvasser. A turf may point
// at a past day's squad that loadToday won't return — keep it selectable so
// touching the dropdown doesn't silently drop the assignment. ---
function assignOptionsFor(t: TurfWithMeta | null): SelectOption[] {
  const opts: SelectOption[] = [{ value: 'none', label: 'Unassigned' }]
  const squadIds = new Set<string>()
  for (const s of squadsStore.squads) {
    squadIds.add(s.id)
    opts.push({ value: `squad:${s.id}`, label: `Squad: ${s.name}` })
  }
  if (t?.squad && !squadIds.has(t.squad.id)) {
    opts.push({
      value: `squad:${t.squad.id}`,
      label: `Squad: ${t.squad.name} (${prettyDay(t.squad.squad_date)})`,
    })
  }
  for (const p of people.value) {
    opts.push({ value: `user:${p.id}`, label: `Canvasser: ${p.display_name || p.username}` })
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

/** Non-empty when the turf is still pointed at a past day's crew. State, not
 * instruction (2026-07-25) — the reassign control is right there. */
function staleDispatchLabel(t: TurfWithMeta): string {
  if (t.parent_turf_id || !t.squad || t.squad.squad_date === localToday()) return ''
  return `Not out today. Last crew: ${t.squad.name}, ${prettyDay(t.squad.squad_date)}.`
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
    listError.value = 'Could not reassign that turf. Try again.'
    return
  }
  if (editingTurfId.value === t.id) assignChoice.value = choice
  await fetchTurfs()
}

function segmentLabel(s: { street_name: string; range_start: number; range_end: number; parity: TurfParity }): string {
  const side = s.parity === 'both' ? '' : ` · ${PARITY_LABELS[s.parity].toLowerCase()}`
  return `${s.street_name} ${s.range_start} to ${s.range_end}${side}`
}

// --- Door canvas paint state ---
// Every door on the map, always, and each one answers three questions in
// three concentric bands — the whole color system on this page (2026-07-25,
// after "the turf coloring system is still not making sense"):
//
//   FILL   how does this door stand? Green = everyone signed, green with a
//          yellow band = partly signed (project-wide rule), red = closed
//          (didn't sign / skip / hostile), white = anything else. The hexes
//          reuse outcomes.ts literals — never change those there.
//   RING   whose ground is it? The owning turf's identity color, with the
//          Turf layer on — ONE color per turf, sub-turfs painted as their
//          parent, and the SAME while cutting as in overview. A door going
//          into the draft you're building wears the uniform dark ring
//          instead: that's the one membership that changes minute to minute.
//   HALO   the turf you SELECTED, lit up whole (overview only).
//
// Plus one face in the middle: whoever knocked the door today. Nothing else
// is drawn — no assignee avatars, no cross-outs, no areas, no shapes.
const FILL_SIGNED = OUTCOME_HEX.signed
const FILL_CLOSED = OUTCOME_HEX.didnt_sign
const RING_PARTLY = OUTCOME_HEX.maybe
const FILL_OPEN = '#ffffff'
const OPEN_OUTLINE = '#8a90a5'
const OPEN_INK = '#1d2433'

/** Avatars on doors, from the factory every map shares
 * (src/lib/doorBadges.ts). ONE kind of face rides a door here: whoever
 * knocked it today. Images decode async — the layer repaints when one
 * lands. */
const { badgeFor } = createBadgeFactory(() => doorLayer?.requestRepaint())

/** door id -> the id of whoever last knocked it today, and those people's
 * profiles — the avatar badge every map wears. Filled by fetchTodayKnockers
 * alongside the knock statuses: both are "what happened at these doors". */
const todayKnockerByDoor = ref<Map<string, string>>(new Map())
const knockerById = ref<Map<string, BadgePerson>>(new Map())

/** A turf's identity color: the assignee's own accent (the same color their
 * Squad card / chat name wears) when it's one person's turf, else the turf's
 * auto-assigned palette hue — squad-assigned and unassigned turfs still each
 * get a distinct color. */
function turfDisplayColor(t: TurfWithMeta): string {
  return t.assignee ? memberColor(t.assignee) : t.color
}

/** The turf whose color a door WEARS: always the top-level one (2026-07-25,
 * user call: "it's important that one turf is all one color… I don't even
 * want the turf page to reflect sub doors that are assigned"). Per-member
 * "<name>'s doors" sub-turfs are a Squad-page concept — cut there, dissolved
 * nightly — and painting each one in its member's accent shattered a single
 * crew's ground into five colors on the one page that exists to show how the
 * county is divided between CREWS. Only one nesting level exists, so one hop
 * is the whole walk. */
function paintTurfOf(turfId: string): TurfWithMeta | undefined {
  const t = turfById.value.get(turfId)
  if (!t?.parent_turf_id) return t
  return turfById.value.get(t.parent_turf_id) ?? t
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
  // EVERY door paints, always (2026-07-25, user call: "I wanna just see
  // everything, and then the turf will toggle it on and off"). The map used
  // to open blank and reveal doors only for a searched street, a trimmed
  // street, or — with the Turf layer on — somebody else's ground, which made
  // the layer toggle read as the switch that turns the map on at all.
  //
  // The baseline is Scout's: the whole county on knock-status colors, and the
  // Turf layer is purely additive on top of it — ONE ring per door, in the
  // color of the turf that owns it, and the SAME in overview and while
  // cutting (2026-07-25, user call: "when I click on a turf and then I edit
  // it, I should still see all of the colors for all of the turfs"). The
  // red cross-out "taken" symbol is gone with that: the turf colors already
  // say a door is somebody's, and flipping every one of them to a red X the
  // moment you opened a draft threw away the picture you were reading.
  //
  // Draft members can still carry another turf's stamp (a sub-cut claims
  // from its parent pool, a steal from its victim until save) — membership
  // wins over anything else.
  const owner = ownedElsewhere && !inDraft ? paintTurfOf(a.turf_id!) : undefined
  const eff = statusByAddress.value.get(id)
  let fill = FILL_OPEN
  let innerRing: string | null = null
  if (eff === 'signed') fill = FILL_SIGNED
  else if (partlySignedDoors.value.has(id)) {
    fill = FILL_SIGNED
    innerRing = RING_PARTLY
  } else if (eff === 'didnt_sign' || eff === 'skip' || eff === 'hostile') fill = FILL_CLOSED
  // Whoever knocked this door TODAY rides in the middle of it, same as Scout
  // and Squad — the door keeps saying what happened, the avatar says who was
  // there. That's the only face on this map now: an ASSIGNEE's avatar never
  // rides a door here (same 2026-07-25 call), because who a door is assigned
  // to is a Squad-page question and it fought the turf color for the middle
  // of the pin.
  const badge = todayBadge(id)
  // The SELECTED turf lights up: every door of it (sub-turfs included) wears
  // a halo in the turf's own color and draws big and last. This is what tells
  // you which ground you picked — the job the outline polygon was doing, done
  // on the doors, which is the only place turf membership is ever drawn now.
  // Independent of the Turf layer on purpose: you asked for this turf.
  const picked =
    !draftOpen.value && !!(a.turf_id && selectedFamilyIds.value?.has(a.turf_id))
  const pickedColor = picked && selectedTurf.value ? turfDisplayColor(selectedTurf.value) : null
  return {
    fill,
    badge,
    halo: pickedColor,
    // The outer ring says WHOSE this door is — including while you're
    // cutting: a door in the draft wears the DRAFT'S OWN COLOR (2026-07-25,
    // user call: they lassoed another turf's doors with Take armed and "it
    // did not change colors to my color"). It used to be a uniform dark
    // ring, on the theory that "in the draft" is a different kind of fact
    // from "belongs to that turf" — but a draft IS a turf, and taking a door
    // has to show it changing hands. Editing keeps a turf in its own color
    // for the same reason.
    ring: inDraft
      ? draftColor.value
      : owner && showTurfColors.value
        ? turfDisplayColor(owner)
        : pickedColor,
    innerRing,
    outline: fill === FILL_OPEN ? OPEN_OUTLINE : null,
    ink: fill === FILL_OPEN ? OPEN_INK : '#fff',
    // Draft members draw bigger and above their neighbors — so does a door
    // somebody covered today, and every door of the selected turf.
    emphasis: inDraft || !!badge || picked,
  }
}

/** The badge for a door: whoever in the org last knocked it TODAY. Loaded
 * with the knock statuses (same lazy trigger), so it costs nothing until the
 * cutter first paints status-colored doors. */
function todayBadge(id: string): DoorBadge | null {
  const knocker = todayKnockerByDoor.value.get(id)
  const person = knocker ? knockerById.value.get(knocker) : undefined
  return person ? badgeFor(person) : null
}

// Any paint-relevant state change repaints the one canvas (rAF-coalesced in
// the layer). showTurfColors governs the per-door turf color; zoom crossings
// repaint via the layer's own idle check.
watch(
  [draftMemberIds, statusByAddress, partlySignedDoors, expandedSegKey, locatedStreet, turfs, editingTurfId, showTurfColors, pinMode, draftOpen, todayKnockerByDoor, knockerById],
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

/** The columns the in-memory index is built from. `unit` and `zip` are load-
 * bearing despite nothing on screen showing them: geocodeCapturedStreets feeds
 * these very rows to the geocoder, and without the zip the query line silently
 * loses it. Anything added here needs a bump of CACHE_SHAPE below. */
const ADDRESS_COLUMNS = 'id, street, unit, city, zip, lat, lng, turf_id'

/** Bump when ADDRESS_COLUMNS changes: a copy stored by an older build is then
 *  discarded instead of served with a field silently missing. */
const CACHE_SHAPE = 1

/** This page's own stored copy of the county. Named separately from Scout's
 *  because the two select different columns (lib/addressCache.ts). */
const cache = doorCache('cutter', CACHE_SHAPE)

/** The WHOLE address table, ungeocoded rows included — street sweeps, door
 * counts, and search all run from memory so no gesture ever waits on the
 * network. ~23k slim rows ≈ a small map tile's worth of JSON.
 *
 * One undivided pass, for the post-save reload where nobody is watching it
 * fill. The staged version the cold path uses lives in lib/doorData.ts, which
 * owns the load order for all three maps. */
function fetchAddresses(): Promise<AddressLite[]> {
  return fetchDoors<AddressLite>({ select: ADDRESS_COLUMNS })
}

async function fetchTurfs() {
  const [turfRes, histRes] = await Promise.all([
    supabase
      .from('turfs')
      .select(
        '*, turf_segments(*), assignee:profiles!turfs_assignee_id_fkey(id, username, display_name, avatar, color), squad:squads!turfs_squad_id_fkey(id, name, squad_date)',
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
  turfsLoaded.value = true
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

/** Today's knocks org-wide (a few hundred rows, not the whole history) plus
 * the profiles behind them. Best-effort — no badges is a fine failure. */
async function fetchTodayKnockers() {
  try {
    const rows = await fetchAllRows<{
      household_id: string
      canvasser_id: string
      occurred_at: string
    }>((from, to) =>
      supabase
        .from('knock_logs')
        .select('household_id, canvasser_id, occurred_at')
        .gte('occurred_at', startOfLocalDayISO())
        .not('household_id', 'is', null)
        .order('id')
        .range(from, to),
    )
    const latest = new Map<string, { canvasserId: string; at: number }>()
    for (const r of rows) {
      const at = Date.parse(r.occurred_at)
      const prev = latest.get(r.household_id)
      if (!prev || prev.at <= at) latest.set(r.household_id, { canvasserId: r.canvasser_id, at })
    }
    const ids = [...new Set([...latest.values()].map((v) => v.canvasserId))]
    if (!ids.length) return
    const { data } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar, color')
      .in('id', ids)
    knockerById.value = new Map(((data ?? []) as BadgePerson[]).map((p) => [p.id, p]))
    todayKnockerByDoor.value = new Map([...latest].map(([door, v]) => [door, v.canvasserId]))
  } catch {
    /* no badges this session */
  }
}

/** Latest outcome per door, for the status-colored dot fills. Best-effort:
 * a failed fetch keeps whatever colors we already had. */
async function fetchKnockStatuses() {
  void fetchTodayKnockers()
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
      if (doorPartlySigned(r.outcome, r.signed_count, r.person_count)) partly.add(r.household_id)
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
  startLoadBadge()
  // The street data does not need the map, so it must not queue behind it
  // (2026-07-27). This used to run after loadMaps() resolved, which meant the
  // whole county read started only once the Maps SDK had downloaded, parsed and
  // built a map — measured here as seconds of doing nothing before the first
  // address request even went out. Now both start at once and meet in the
  // middle: the fetches tolerate a doorLayer that doesn't exist yet (pages are
  // upserted when it does, and the final setDoors sweeps up either way).
  void loadCutterData()
  try {
    await loadMaps()
  } catch {
    loadError.value = 'Could not load the map. Check your connection.'
    initStarted = false
    stopLoadBadge()
    return
  }
  if (!mapEl.value) {
    stopLoadBadge()
    return
  }

  map = new google.maps.Map(mapEl.value, {
    center: lastCamera ? { lat: lastCamera.lat, lng: lastCamera.lng } : FALLBACK_CENTER,
    zoom: lastCamera?.zoom ?? 15,
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
  attachPoiTapGuard(map)
  map.addListener('click', (e: google.maps.MapMouseEvent) => onMapClick(e))

  doorLayer = new DoorCanvasLayer(map, {
    minPinZoom: PINS_MIN_ZOOM,
    numbersMinZoom: NUMBERS_MIN_ZOOM,
    pinMode: () => pinMode.value,
    paintFor: paintForDoor,
  })
  // Whatever the index already holds goes in NOW (2026-07-27). loadCutterData
  // started before this and reads the device's own copy from IndexedDB, which
  // finishes long before the Maps SDK has downloaded, parsed and built a map —
  // so on every visit after the first, the whole county was already indexed by
  // the time this layer came into existence, and the layer was born EMPTY. Its
  // `doorLayer?.setDoors(...)` had run against a null. Nothing else populated
  // it on that path (the viewport read is cold-load only), so the map sat blank
  // until the unconditional background refetch finished paging the entire
  // county a second time. That was most of "it takes forever to load stuff in":
  // not slow loading, a map painting nothing while its data sat in memory.
  // A no-op on a genuinely cold load, where the index is still empty.
  doorLayer.setDoors(locatedCanvasDoors())
  // Settled pan/zoom: repaint only if the view outgrew the painted canvas
  // (or the zoom landed somewhere new — mid-animation the canvas just
  // stretches via its CSS transform).
  map.addListener('idle', () => {
    doorLayer?.checkView()
    // Every pan, zoom, turf focus and street locate ends in an idle, so this is
    // the one place that needs to record where the map came to rest.
    rememberCamera()
    // A cold load reads the doors on screen directly (no-op otherwise), so the
    // flight to the user's own location lands on painted ground.
    void loadViewportDoors()
  })

  cityLayer = new CityLimitsLayer(map)
  if (showCity.value) void cityLayer.setVisible(true)

  // Fly to where the user is standing — cutting usually starts on the
  // ground — while the street data streams in behind the map. ONLY when there
  // is nowhere to go back to: a remembered view is where this canvasser put the
  // map on purpose, and flying off it was the bug. Safe to test here because
  // the first 'idle' (which sets lastCamera) can't have fired yet.
  if (!lastCamera) void zoomToMe()

  // The map exists now, so the doors on screen can be read directly. On a warm
  // load this is disarmed and does nothing.
  void loadViewportDoors()
}

/** How far from the campaign's ground the user can be and still get flown
 * to their own location — demo visitors across the country stay on the
 * fallback view instead of landing on an empty map. */
const NEAR_CAMPAIGN_METERS = 60000

/** Record where the map came to rest, so the next visit opens there. The store
 * itself lives in the plain `<script>` block at the top of this file, which is
 * the only part of an SFC that survives a remount. */
function rememberCamera() {
  rememberCameraOf(map)
}

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

/** Bumped by every whole-table load that lands. A background refetch that
 * started before a save captures this and drops its rows if a fresher set
 * (reloadAll's) has replaced the index since — a slow read must never
 * reinstate the turf_ids the save just changed. */
let addressGeneration = 0

/** Store a complete table once the main thread is free — writing ~4 MB is
 * cheap but not free, and nothing on screen is waiting on it. Skipped if a
 * fresher set has been published in the meantime, so two saves in quick
 * succession can't leave the older one on disk. */
function cacheLater(rows: AddressLite[]) {
  const gen = addressGeneration
  whenIdle(() => {
    if (gen === addressGeneration) void cache.write(rows)
  })
}

// --- Viewport-first cold load ---
// Only ever a REORDERING: the whole county still loads behind this, so panning
// away from the opening view works exactly as before and no new failure mode is
// introduced. All this buys is that the doors somebody is looking at arrive in
// one request instead of scattered across twenty-three.

/** How many box reads a single cold load may spend. More than one because the
 *  opening frame moves: the map starts on the fallback centre and flies to the
 *  user's own location when geolocation answers, and a canvasser may pan while
 *  the county is still arriving. Small because each one is a whole extra query
 *  for rows the paged read is already fetching. */
let viewportFetchesLeft = 0
/** Boxes already read, so settling back over the same ground costs nothing. */
let viewportBoxes: DoorBox[] = []

function armViewportFirst() {
  viewportFetchesLeft = 3
  viewportBoxes = []
  void loadViewportDoors()
}

function disarmViewportFirst() {
  viewportFetchesLeft = 0
}

function boxOf(b: google.maps.LatLngBounds): DoorBox {
  const sw = b.getSouthWest()
  const ne = b.getNorthEast()
  return { south: sw.lat(), north: ne.lat(), west: sw.lng(), east: ne.lng() }
}

function boxCovered(box: DoorBox): boolean {
  return viewportBoxes.some(
    (b) => b.south <= box.south && b.north >= box.north && b.west <= box.west && b.east >= box.east,
  )
}

async function loadViewportDoors() {
  if (viewportFetchesLeft <= 0 || !map) return
  const bounds = map.getBounds()
  if (!bounds) return
  const box = boxOf(bounds)
  // A box straddling the antimeridian would read as an empty range. Nothing in
  // Ohio does, but a bad box should skip rather than silently return nothing.
  if (box.west > box.east || box.south > box.north) return
  if (boxCovered(box)) return
  viewportFetchesLeft--
  viewportBoxes.push(box)
  try {
    const rows = await fetchDoorsInBox<AddressLite>({
      select: ADDRESS_COLUMNS,
      located: true,
      box,
    })
    // The paged read may have finished (and reset the index) while this was in
    // flight; then these rows are already there and folding them in is at best
    // a no-op, at worst a duplicate. addToIndex skips known ids, but bailing
    // here says why.
    if (unmounted || indexComplete.value || !rows.length) return
    addToIndex(rows)
    for (const a of rows) {
      if (a.lat != null && a.lng != null) doorLayer?.upsertDoor(canvasDoorOf(a))
    }
    doorLayer?.requestRepaint()
  } catch {
    // The county load behind this is the real one; losing a head start is fine.
  }
}

/** The street search list, straight from the database, so the box works long
 * before the doors do. Best-effort: without it the search simply falls back to
 * whatever the index holds so far, which is what it did before. */
async function seedStreetSummaries() {
  try {
    const rows = await fetchStreetSummaries()
    if (unmounted || indexComplete.value || !rows.length) return
    serverSummaries.value = rows
    // A query typed before this landed re-runs against the fuller list.
    if (streetQuery.value.trim().length >= 2) onStreetInput(streetQuery.value)
  } catch {
    /* the index's own summaries stand */
  }
}

/** Publish a complete address table: replace the index, the canvas and the
 * stale-turf prompt, and keep the device's copy in step. */
function applyAddresses(rows: AddressLite[]) {
  addressGeneration++
  indexAddresses(rows)
  doorLayer?.setDoors(locatedCanvasDoors())
  refreshStaleTurfs()
  doorLayer?.requestRepaint()
  cacheLater(rows)
}

/** Background data load: the county address table into the street indexes,
 * plus turfs/squads/people for coloring, scoping, and the assign pickers.
 * The map is already up and interactive while this runs. */
async function loadCutterData() {
  try {
    // All five reads go out together, as they always have — the address
    // paging is the slow one and the other four ride alongside it.
    //
    // They are deliberately still published TOGETHER, at the end. Publishing
    // the turf list as soon as its own query landed was tried and reverted:
    // the rows render their door counts out of the address index, so the
    // whole dispatch list sat there reading "0 doors" until the county table
    // finished. A turf list that says every turf is empty is worse than a
    // turf list that isn't there yet.
    const meta = Promise.all([
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

    // The device's own copy first, if there is one: one IndexedDB read against
    // 23 network round trips, and the page is fully usable the moment it lands.
    // The whole table is refetched behind it either way, further down.
    const cached = await cache.read<AddressLite>()
    if (unmounted) return
    if (cached?.length) {
      addressGeneration++
      indexAddresses(cached)
      doorLayer?.setDoors(locatedCanvasDoors())
      doorLayer?.requestRepaint()
      stopLoadBadge()
    } else {
      // Nothing stored: the long way round. Three reads overlap here, and they
      // are complementary rather than alternatives — in the order somebody
      // actually needs them.
      resetIndex()
      // 1. The doors ON SCREEN, in one request. The paged read below comes back
      //    ordered by id, which is scattered geographically, so the few hundred
      //    doors in front of the canvasser would otherwise dribble in across
      //    every page of it. Armed before anything else so the first thing the
      //    map can draw is the neighbourhood it is already showing.
      armViewportFirst()
      // 2. The street list, without any doors under it at all — searching
      //    streets never needed them (migration 20260727120000).
      void seedStreetSummaries()
      // 3. The county, streaming, behind both.
      const stream = (page: AddressLite[]) => {
        if (unmounted) return
        addToIndex(page)
        for (const a of page) {
          if (a.lat != null && a.lng != null) doorLayer?.upsertDoor(canvasDoorOf(a))
        }
        doorLayer?.requestRepaint()
        // A search typed while the pages are still arriving refines itself
        // rather than sitting on whatever the index held when it was typed.
        if (streetQuery.value.trim().length >= 2) onStreetInput(streetQuery.value)
      }
      const { located, unlocated } = await fetchDoorsStaged<AddressLite>(
        { select: ADDRESS_COLUMNS },
        stream,
      )
      if (unmounted) return
      disarmViewportFirst()
      // Belt and braces: the streaming upserts above skip any page that landed
      // before the layer existed, and this also drops doors that are no longer
      // in the table on a re-run. One pass over an already-built index.
      addressGeneration++
      indexComplete.value = true
      bumpIndexVersion(true)
      doorLayer?.setDoors(locatedCanvasDoors())
      cacheLater([...located, ...unlocated])
    }
    await meta
    if (unmounted) return
    await computeLeaderlessSquads()
    if (unmounted) return
    defaultDraftParent()
    refreshStaleTurfs()
    // Every door paints on its knock status from the moment the page opens
    // (see paintForDoor), so the statuses are no longer a lazy trim-mode
    // extra — they ARE the map. Unawaited on purpose: the doors are already
    // on screen in their unknocked color and simply recolor when this lands,
    // which is the map-first startup this page was rebuilt around.
    ensureKnockStatuses()
    // Both need the street index above to resolve names to house numbers.
    applyIncomingStreet()
    applyIncomingAssignee()
    applyIncomingPlan()
    // A stored copy is a head start, never an authority: turf_id is rewritten
    // server-side every time anyone saves a turf, and which turf a door is in
    // is what this page exists to show. So refetch the table unconditionally,
    // once the map has settled, and swap it in when it lands.
    if (cached?.length) whenIdle(() => void refreshAddresses())
  } catch {
    loadError.value = 'Could not load the street data. Check your connection and reload.'
  } finally {
    stopLoadBadge()
  }
}

/** Silent whole-table refetch behind a cache-seeded page. Failure is fine: the
 * copy already on screen stands, and this runs again next visit. */
async function refreshAddresses() {
  const gen = addressGeneration
  try {
    const rows = await fetchAddresses()
    // A save landed while this was in flight — reloadAll has already published
    // fresher rows, and these would put the old turf_ids back.
    if (unmounted || !rows.length || gen !== addressGeneration) return
    applyAddresses(rows)
  } catch {
    /* the cached copy stands */
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
  applyAddresses(rows)
  defaultDraftParent()
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
    .select(ADDRESS_COLUMNS)
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
// A BARE TAP NEVER CHANGES A TURF (2026-07-25, user call: "you have to use
// either the street add-and-remove tap tool or the lasso in order to change
// a turf"). Changing what a turf holds is always something you armed a tool
// to do — ☝ Streets for a whole street, the lasso for a patch or a single
// dot under its line — so a stray tap while reading the map can't quietly
// move a door. (Tap-to-toggle lived here for one afternoon; it made
// single-door edits easy and accidental in equal measure.)
//
// So: armed ☝ Streets takes the tap; otherwise a tap opens the door's house
// history, cutting or not, at any zoom.

function onMapClick(e: google.maps.MapMouseEvent) {
  if (!e.latLng || !map) return
  if (streetTapActive.value) {
    void handleStreetTap(e.latLng)
    return
  }
  // Works at EVERY zoom (2026-07-25, user call: "I wanna be able to tap one
  // of the dots in one of the turfs and edit that turf"). Turf colors are
  // exactly what you read zoomed OUT — the whole county's ground at a glance
  // — and a PINS_MIN_ZOOM floor meant that at the one zoom where you can see
  // which turf is which, tapping it did nothing. Nearest painted door wins,
  // so a fat-fingered tap at town zoom still lands in the right turf.
  const id = doorLayer?.doorAt(e.latLng, TAP_RADIUS_PX)
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
  // A tapped door also picks its turf — the bar along the map's bottom edge
  // takes it from there (name, Edit, details).
  selectTurfOfDoor(a)
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

/** The turf that owns the bubbled door, when it's not the one being edited.
 * The TOP-LEVEL one, like everything else on this page — a door in "Angie's
 * doors" reads as the crew turf it was carved from. */
const doorOwner = computed(() => {
  const tid = doorInfo.value?.address.turf_id
  if (!tid || editingTurfId.value === tid) return null
  return paintTurfOf(tid) ?? null
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
  if (takeMode.value && autoStealable(a)) return true
  return claimableWithoutSteal(a)
}

/** The claim rule with no stealing in it at all — what set_turf_segments()
 * would give this draft on its own. Split out so Take mode can tell "this
 * door is already mine to claim" from "this door belongs to someone and I'm
 * about to take it", and only record the latter for release at save. */
function claimableWithoutSteal(a: AddressLite): boolean {
  const parentId = effectiveParentId.value
  return (
    (editingTurfId.value !== null && a.turf_id === editingTurfId.value) ||
    (parentId !== null ? a.turf_id === parentId : !a.turf_id && !isSubcutter.value)
  )
}

/** Would Take mode grab this door? Same permission gate as the manual steal
 * — a manager can take from any top-level turf, a sub-cutter only from a
 * sibling sub-turf — so the toggle never reaches ground the RPC would
 * refuse anyway. */
function autoStealable(a: AddressLite): boolean {
  return !!a.turf_id && canStealFrom(turfById.value.get(a.turf_id))
}

/** May the current cutter steal doors from this turf? The gate is the shape
 * of the DRAFT, not the role — a steal is only ever safe when releasing the
 * victim lands the doors in the pool this draft claims from:
 *
 *   top-level draft → released doors go unassigned → top-level victims only
 *   sub-cut draft    → released doors go to the shared parent → siblings only
 *
 * A manager can Edit a sub-turf too, so keying this off `isManager` was
 * wrong in one reachable way: taking from a top-level turf while editing a
 * sub-turf released those doors to unassigned and then the sub-cut's RPC
 * declined them — the victim lost them and nobody got them.
 *
 * THE CUTTER NEVER TAKES DOORS OUT OF A PER-MEMBER SUB-TURF, and that rule
 * is load-bearing (2026-07-25, learned the hard way): those "<name>'s doors"
 * rows are the crew's own split, cut on the Squad page, and they're what
 * puts each canvasser's avatar on their doors there. Letting Take reach them
 * for one afternoon cost a real one — editing NW Richwood with Take armed
 * swallowed all four members' shares (190 doors) into the parent in a single
 * save, silently, because sub-turfs paint as their parent here and there was
 * nothing on screen to show a boundary being crossed. Their segment rows are
 * rewritten by the RPC, so the split could not be restored. To take ground
 * that a crew has already divided, dissolve the split on the Squad page
 * first — deliberately a decision someone makes on purpose, and what
 * skipSentence() sends you to do.
 *
 * Sub-cutters take only from a SIBLING sub-turf: those released doors land
 * in the shared parent pool, which is exactly where their draft claims from,
 * and re-arranging their own crew's split is their job. */
function canStealFrom(victim: TurfWithMeta | undefined): boolean {
  if (!victim || !isTodayTurf(victim)) return false
  const parentId = effectiveParentId.value
  if (parentId !== null) return victim.parent_turf_id === parentId
  return isManager.value && victim.parent_turf_id === null
}

/** (Re)derive a segment's members from the street index. Pure memory —
 * instant. Taken doors are counted but never join. */
function computeSegment(seg: DraftSegment) {
  const rows = streetRows(seg.street_name, seg.city)
  const members = rows.filter((a) => matchesSegment(a, seg))
  const free = members.filter(claimableDoor)
  // Take mode: a door this segment only got because the toggle is on has to
  // be RECORDED as a steal, or save time wouldn't know to re-cut the turf
  // that currently holds it and the RPC would simply decline to claim it.
  if (takeMode.value) {
    for (const a of free) {
      if (!claimableWithoutSteal(a) && !stealIds.value.has(a.id) && autoStealable(a)) {
        stealIds.value.add(a.id)
      }
    }
  }
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
  closeDraft()
}

/** Re-cut from scratch WITHOUT losing the name/assignee already picked (or,
 * mid-edit, without leaving edit mode) — just the swept streets go away. */
function startOverDraft() {
  if (segments.value.length) snapshotDraft()
  segments.value = []
  stealIds.value = new Set()
  takeMode.value = false
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
  // The house bubble belongs to overview — a draft opening or closing under
  // it would leave it hanging over a map whose taps now mean something else.
  doorInfo.value = null
  segments.value = []
  stealIds.value = new Set()
  takeMode.value = false
  expandedSegKey.value = null
  editingTurfId.value = null
  draftName.value = ''
  assignChoice.value = 'none'
  saveError.value = ''
  locatedStreet.value = null
  defaultDraftParent()
}

/** Leave cutting entirely — back to the pure overview (turf colors on the
 * map, no draft card). Any armed tool disarms with it. */
function closeDraft() {
  clearDraft()
  undoStack.value = []
  draftOpen.value = false
  if (lassoActive.value) toggleLasso()
  streetTapActive.value = false
}

/** "Create new turf" — the only way into a fresh cut now. */
function startNewTurf() {
  clearDraft()
  undoStack.value = []
  planNote.value = ''
  draftOpen.value = true
  void nextTick(focusDraft)
}

/** A plan handed over from the AI chat (/turf?plan=…). The assistant can't cut
 * turf — it's read-only — so it hands us a draft instead: streets it found in
 * a real query, pre-built here into an ordinary draft that a human reviews and
 * saves. Nothing is claimed until they press Save.
 *
 * Runs after indexAddresses(), because resolving a street name to its house
 * numbers needs the in-memory street index. */
/** /turf?street=Grove St — where the AI chat's [[Street]] links land now
 * (2026-07-25, user call). Zooms to the street, paints its doors on their
 * knock status like everything else, and leaves the search box filled so the
 * house-range controls are right there. Deliberately does NOT open a draft:
 * arriving from a sentence is a "show me" not a "start cutting".
 *
 * Needs the street index, so it runs at the tail of loadCutterData with the
 * other query handlers. The param is consumed either way. */
function applyIncomingStreet() {
  const raw = route.query.street
  if (typeof raw !== 'string' || !raw.trim()) return
  const wanted = normalizeStreetName(raw.trim().slice(0, 80))
  void router.replace({ path: '/turf', query: {} })
  const list = searchSummaries()
  const hit =
    list.find((s) => s.street_name === wanted) ??
    list.find((s) => s.street_name.includes(wanted))
  if (!hit) {
    flash(`No street called ${titleCase(wanted)} in the address list.`)
    return
  }
  onStreetInput(titleCase(hit.street_name))
  void locateStreet(hit)
}

/** /turf?assignee=<profile id> — the way in from a person's page now that
 * per-member sub-turfs are out of the picker (2026-07-25, user call: "the
 * campaign manager can go to the user's profile page and click View doors,
 * and you can view their doors on the map in the turf editor").
 *
 * Selects whatever turf carries that person's name today (their sub-turf if
 * a leader cut them one, otherwise a turf assigned to them outright) and
 * flies to it. Read-only on arrival — this is "show me their stretch", and
 * Edit is right there on the card if that's what you actually want. */
function applyIncomingAssignee() {
  const raw = route.query.assignee
  if (typeof raw !== 'string' || !raw) return
  void router.replace({ path: '/turf', query: {} })
  const theirs = todayTurfs.value.filter((t) => t.assignee_id === raw)
  // Prefer the biggest, so somebody with both a personal slice and a whole
  // turf lands on the one that actually holds their day.
  const best = theirs.sort((a, b) => turfDoorCount(b.id) - turfDoorCount(a.id))[0]
  if (!best) {
    flash('No turf carries that person’s name today.')
    return
  }
  selectedTurfId.value = best.id
  focusTurf(best.id)
}

function applyIncomingPlan() {
  const raw = route.query.plan
  if (typeof raw !== 'string' || !raw) return
  const plan = decodeTurfPlan(raw)
  // Consume the param either way: a bad plan shouldn't re-prompt on reload,
  // and a good one must not re-apply over whatever gets done next.
  const consume = () => void router.replace({ path: '/turf', query: {} })
  if (!plan) return consume()

  // Never silently discard work in progress — an unsaved draft or an open
  // edit is someone's afternoon. Cancel leaves the plan in the URL so they
  // can finish, then reload to pick it up.
  const busy = draftOpen.value && (segments.value.length > 0 || editingTurfId.value)
  if (
    busy &&
    !window.confirm("Discard the turf you're working on and start the assistant's suggested plan?")
  ) {
    return
  }
  consume()

  startNewTurf()
  if (plan.name) draftName.value = plan.name
  planNote.value = plan.note ?? ''

  const missing: string[] = []
  for (const s of plan.streets) {
    const streetName = s.street.toUpperCase()
    const rows = streetRows(streetName, s.city)
    if (!rows.length) {
      missing.push(s.street)
      continue
    }
    const nums = rows.map((r) => houseNumber(r.street)).filter((n) => Number.isFinite(n))
    if (!nums.length) {
      missing.push(s.street)
      continue
    }
    addSegment(streetName, s.city, s.from ?? Math.min(...nums), s.to ?? Math.max(...nums), 'both')
  }
  // Name what didn't land rather than quietly dropping it — the assistant can
  // misspell a street, and a short draft with no explanation reads as a bug.
  if (missing.length) {
    flash(`Couldn't find ${missing.join(', ')} in the address list. The rest is in your draft.`)
  }
  void nextTick(focusDraft)
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
const streetMatches = ref<StreetSummary[]>([])

function onStreetInput(value: string) {
  streetQuery.value = value
  const q = value.trim().toUpperCase()
  if (q.length < 2) {
    streetMatches.value = []
    locatedStreet.value = null
    return
  }
  streetMatches.value = searchSummaries()
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
async function locateStreet(m: { street_name: string; city: string; lo: number; hi: number }) {
  locatedStreet.value = { name: m.street_name, city: m.city }
  locatedFrom.value = m.lo
  locatedTo.value = m.hi
  scrollMapIntoView()
  // During a first load the list can name a street the index hasn't reached
  // yet — the summaries come from the database, the doors are still arriving.
  // Fetch just that street so the range controls, the count and Add all work
  // off real rows rather than an empty street. No-op once the county is in.
  await ensureStreetRows(m.street_name, m.city)
  if (unmounted) return
  void materializeStreetPins(m.street_name, m.city, true)
}

/** Ride the page back up to the map. `nearest` scrolls the minimum needed,
 * so tapping something already beside the map doesn't jump. */
function scrollMapIntoView() {
  mapEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// --- Skipped-door stealing ---
// A capture NEVER silently includes doors another turf owns: they're
// skipped, the flash says so, and — when this cutter may re-cut the owner
// (canStealFrom) — the flash carries a "Take them too" button. Stealing
// marks the doors in stealIds (drafts treat them as claimable); the owning
// turf is only actually re-cut around them at save time.

/** Who holds a batch of skipped doors, and why this cutter can't have them.
 * The three cases are the three reasons canStealFrom() says no. */
function skipSummary(doors: AddressLite[]): {
  holders: TurfWithMeta[]
  reason: 'past-day' | 'crew-split' | 'other-turf'
} {
  const holders = new Map<string, TurfWithMeta>()
  for (const a of doors) {
    const t = a.turf_id ? turfById.value.get(a.turf_id) : undefined
    if (t) holders.set(t.id, t)
  }
  const list = [...holders.values()]
  const every = (fn: (t: TurfWithMeta) => unknown) => list.length > 0 && list.every((t) => !!fn(t))
  return {
    holders: list,
    reason: every((t) => !isTodayTurf(t))
      ? 'past-day'
      : every((t) => t.parent_turf_id)
        ? 'crew-split'
        : 'other-turf',
  }
}

/** One dry line for a skipped batch: how many, who has them, and the way to
 * get them when there is one.
 *
 * Specific on purpose (2026-07-25, reported from the field: "it's saying that
 * they are in another turf, but obviously I know that, and that's why I'm
 * using the take toggle"). The old note said "another turf's" for every
 * refusal, so with Take armed the copy was word-for-word the copy with Take
 * off and the toggle read as broken. Each reason now names its holder and
 * points at the one place the doors can actually be freed.
 *
 * Doors in a per-member sub-turf are the common case, and the most confusing:
 * on this map they wear their PARENT's color, so while you're editing that
 * parent they look like they're already yours. They aren't — the crew divided
 * them on the Squad page, and that's where the split comes undone (see
 * canStealFrom for why Take must never swallow it silently). */
function skipSentence(doors: AddressLite[], lead?: string): string {
  const head = lead ?? `${doors.length} skipped`
  const blocked = doors.filter(
    (a) => !canStealFrom(a.turf_id ? turfById.value.get(a.turf_id) : undefined),
  )
  // Doors still one tap away (the "Take them too" button) aren't the
  // friction. When part of a batch is out of reach entirely, that part is
  // what the line has to be about.
  const focus = blocked.length ? blocked : doors
  const part = focus.length < doors.length ? `${focus.length} of them ` : ''
  const them = focus.length === 1 ? 'it' : 'them'
  const { holders, reason } = skipSummary(focus)
  const one = holders.length === 1 ? holders[0] : null
  if (reason === 'past-day') {
    const who = one ? `${one.name}, cut ${prettyDay(turfDay(one))}` : `${holders.length} turfs from earlier days`
    return `${head}: ${part ? `${part}in ` : ''}${who}. Copy or clear old turf above first.`
  }
  if (reason === 'crew-split') {
    const who = one ? one.name : `${holders.length} crew splits`
    return `${head}: ${part ? `${part}in ` : ''}${who}, split on the Squad page. Dissolve the split there to take ${them}.`
  }
  const who = one ? one.name : holders.length ? `${holders.length} other turfs` : 'another turf'
  return `${head}: ${part}held by ${who}.`
}

/** The unclaimable doors a segment's range sweeps over — the ones behind
 * takenCount, resolved back to rows so a note can name who holds them. */
function takenDoorsOf(seg: DraftSegment): AddressLite[] {
  return streetRows(seg.street_name, seg.city).filter(
    (a) => matchesSegment(a, seg) && !claimableDoor(a),
  )
}

const expandedSegSkipNote = computed(() => {
  const seg = expandedSeg.value
  if (!seg?.takenCount) return ''
  return skipSentence(takenDoorsOf(seg), `${seg.takenCount} in this range skipped`)
})

const draftSkipNote = computed(() => {
  const n = draftTakenCount.value
  if (!n) return ''
  return skipSentence(
    segments.value.flatMap(takenDoorsOf),
    `${n} door${n === 1 ? '' : 's'} in these ranges skipped`,
  )
})

/** The flash action for a batch of skipped doors, or null when none of
 * their owners can be stolen from. */
function stealActionFor(doors: AddressLite[]): { label: string; run: () => void } | null {
  // With Take armed there is nothing to offer — those doors were already
  // claimed by the sweep that just ran. That's the whole point of the mode.
  if (takeMode.value) return null
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
  flash(`Took ${n} door${n === 1 ? '' : 's'}. The other turf gives them up when you save.`)
}

/** Post-add flash for a street: honest got/skipped counts, with the steal
 * offer when doors were skipped. */
function flashAddResult(streetName: string, city: string | null, prefix: string) {
  const segsNow = matchingSegments(streetName, city)
  const got = segsNow.reduce((n, s) => n + s.doorCount, 0)
  const taken = segsNow.reduce((n, s) => n + s.takenCount, 0)
  if (!taken) {
    flash(`${prefix}: ${got} door${got === 1 ? '' : 's'}.`)
    return
  }
  const takenDoors = streetRows(streetName, city).filter(
    (a) => segsNow.some((s) => matchesSegment(a, s)) && !claimableDoor(a),
  )
  flash(
    `${prefix}: ${got} door${got === 1 ? '' : 's'}. ${skipSentence(takenDoors, `${taken} skipped`)}`,
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
  flashAddResult(m.street_name, m.city, `Added ${m.street_name} ${lo} to ${hi}`)
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

/** Take rides with the sweep tools: it only changes what an ADD sweep does
 * (take the doors it lands on instead of skipping and asking), so the BUTTON
 * shows only while one is armed to add — 2026-07-25, user call.
 *
 * The MODE is not disarmed when that row leaves, and this is the fix for
 * "when I unselect Lasso the new highlights go away and I see the old color
 * from the old turf": disarming used to flip Take off, and flipping it off
 * used to hand back every door the mode had swept in, so a sweep you'd just
 * made silently came undone. The "you've forgotten it's on" worry is covered
 * where it belongs — the sticky editing bar wears a Take chip the whole time
 * it's armed. */
const canTake = computed(
  () => draftOpen.value && (lassoActive.value || streetTapActive.value) && selectMode.value === 'add',
)

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
        : 'No known street near that tap. Try right on the road.',
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
      flash(`That looks like ${vote.name}. Tap again to confirm.`)
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
    flash(`${name} is already in this turf. Switch to Erase to take it out.`)
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

/** A TAP with the lasso armed (no drag) means the ONE door under your
 * finger — the nearest, never everything within a radius, so it stays exact
 * at any zoom (a fat ring at county zoom would sweep half a town). Single
 * doors are the whole reason a bare map tap was tempting; this keeps them
 * one gesture without letting a stray tap on an unarmed map move anything
 * (2026-07-25, user call: changing a turf goes through ☝ Streets or the
 * lasso, always). */
function lassoTapDoor(p: { x: number; y: number }): AddressLite | null {
  const ll = doorLayer?.containerToLatLng(p.x, p.y)
  const id = ll ? doorLayer?.doorAt(ll, TAP_RADIUS_PX) : null
  return id ? (addressById.get(id) ?? null) : null
}

function onLassoUp() {
  if (!lassoDrawing) return
  lassoDrawing = false
  const drawn = lassoPath
  lassoPath = []
  const c = lassoCanvasEl.value
  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
  if (!drawn.length) return
  const wasTap = drawn.length < 3
  // The loop encloses doors, and the line itself brushes them — touching a
  // dot with the stroke counts, so a quick scribble over a few pins works.
  // A tap resolves to its single nearest door instead.
  const doors: AddressLite[] = wasTap
    ? [lassoTapDoor(drawn[drawn.length - 1])].filter((a): a is AddressLite => !!a)
    : (doorLayer?.doorsInPolygon(drawn, LASSO_BRUSH_PX) ?? [])
        .map((id) => addressById.get(id))
        .filter((a): a is AddressLite => !!a)
  if (selectMode.value === 'erase') {
    const drafted = doors.filter((a) => draftMemberIds.value.has(a.id))
    if (!drafted.length) {
      flash(
        segments.value.length
          ? wasTap
            ? 'Not a door in this turf. Tap a dot in this turf’s color.'
            : 'No doors of this turf in that loop. Circle dots in its color.'
          : 'Nothing to erase yet. Erase takes doors out of the turf being built. Add streets first, or open a turf and tap Edit.',
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
      wasTap
        ? `${drafted[0].street} removed.`
        : `Lasso: removed ${doorCount} door${doorCount === 1 ? '' : 's'} across ${streetCount} street${streetCount === 1 ? '' : 's'}.`,
    )
    return
  }
  if (!doors.length) {
    flash(
      wasTap
        ? 'No door there. Tap a dot, or drag a loop around several.'
        : 'No mapped doors in that loop. Houses only get dots once their street is added or searched. Use the ☝ tool or search first.',
    )
    return
  }
  // Doors another turf owns never silently join a capture — they're
  // skipped, and the flash offers the steal when it's allowed.
  const free = doors.filter(claimableDoor)
  const taken = doors.filter((a) => !claimableDoor(a))
  if (!free.length) {
    flash(
      skipSentence(taken, wasTap ? taken[0].street : `Every door in that loop skipped`),
      stealActionFor(taken),
    )
    return
  }
  snapshotDraft()
  const { doorCount, streetCount } = addDoorsAsSegments(free)
  if (!doorCount) {
    undoStack.value.pop()
    flash('Could not read streets for those doors. Try a tighter loop.')
    return
  }
  flash(
    wasTap
      ? `${free[0].street} added.`
      : taken.length
        ? `Lasso: swept ${doorCount} door${doorCount === 1 ? '' : 's'} across ${streetCount} street${streetCount === 1 ? '' : 's'}. ${skipSentence(taken)}`
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
 * (unassigned for a top-level cut, the parent for a sub-cut).
 *
 * One hop is enough because canStealFrom() only ever yields victims whose
 * release lands the doors where this draft can claim them: a top-level turf
 * for a manager (released to unassigned), a sibling sub-turf for a
 * sub-cutter (released to the shared parent, which IS their pool). A
 * two-hop sub-turf release lived here briefly and is gone with the rule that
 * needed it — see canStealFrom. */
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
    flash('Cleared. Every door is up for grabs today.')
  } catch {
    flash('Could not clear the old turf. Try again.')
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
    flash('Copied to today: same turf, fresh day.')
  } catch {
    flash('Could not copy the old turf. Reload and try again.')
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
    const who = assignChoice.value !== 'none' && opt ? opt.label.split(': ')[1] : ''
    name = who ? `${who}'s turf` : `Turf ${todayTurfs.value.length + 1}`
  }
  if (isSubcutter.value && !editingTurfId.value && !draftParentId.value) {
    saveError.value = 'No turf is assigned to you yet. Your campaign manager assigns turf first.'
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
    // Saved: back to the overview with the turf you just cut SELECTED, so it
    // lights up on the map and its bar is right there — the answer to "did
    // that land?" without hunting for it in a dropdown.
    closeDraft()
    await reloadAll()
    selectedTurfId.value = turfId
    // Fill in dots for every door now in this turf, in the background —
    // never blocks the save.
    void geocodeTurfDoors(turfId)
  } catch {
    saveError.value = 'Could not save the turf. Try again.'
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
/** TOP-LEVEL turfs only (2026-07-25, user call: "it has certain people's
 * doors listed here, and that shouldn't be listed there — you just select the
 * main turf"). The per-member "<name>'s doors" sub-turfs are a squad-page
 * concept: they're cut there, dissolved nightly, and listing them here padded
 * the dropdown with rows nobody picks. A manager who wants to see one
 * person's share opens it from that person's page instead (see ?assignee=).
 *
 * Sub-cutters are the exception: their whole job IS sub-turfs, so they still
 * get theirs. */
const turfPickOptions = computed<SelectOption[]>(() => {
  const shown = listTurfs.value.filter((t) => isSubcutter.value || !t.parent_turf_id)
  // Selecting a door on the map can land on a sub-turf a manager's dropdown
  // doesn't list. Carry it as a row while it's selected, or the trigger sits
  // blank on a turf the map is plainly highlighting.
  const sel = selectedTurf.value
  if (sel && !shown.some((t) => t.id === sel.id)) shown.push(sel)
  return [
    { value: 'none', label: 'Look at a turf…' },
    ...shown.map((t) => ({
      value: t.id,
      label: `${t.parent_turf_id ? '↳ ' : ''}${t.name}`,
    })),
  ]
})

function onPickTurf(value: string) {
  selectedTurfId.value = value === 'none' ? null : value
  if (selectedTurfId.value) focusTurf(selectedTurfId.value)
}

// --- Tapping a turf in the lists below the map ---
// One tap picks it and frames it on the map; tapping the SAME row again
// rides the page back up to the map, because from down in the dispatch list
// the thing that just moved is off screen (2026-07-25, user call: "double
// tapping it should also scroll the screen up"). Deliberately the second tap
// and not the first: each row carries its own assignment dropdown, and
// yanking the page away mid-dispatch costs more than one extra tap.

const TURF_ROW_DOUBLE_MS = 600
let lastTurfTap: { id: string; at: number } | null = null

function tapTurfRow(id: string) {
  const now = performance.now()
  const again = lastTurfTap !== null && lastTurfTap.id === id && now - lastTurfTap.at < TURF_ROW_DOUBLE_MS
  lastTurfTap = { id, at: now }
  onPickTurf(id)
  if (again) scrollMapIntoView()
}

// --- The selected turf, ON the map (2026-07-25, user call: "when we're not
// editing any turf, if you select it, something pops up on the map to
// indicate that we've selected a particular turf — and a button to edit
// it"). ---
//
// Selecting is now a real state with three parts: every door of that turf
// lights up (halo in the turf's color, drawn big and last), a bar names it
// along the map's bottom edge, and that bar carries Edit and a ? that opens
// the turf's details without a trip down the page. Selection comes from the
// dropdown, the dispatch rows, or tapping any door on the map.

/** The selected turf plus its sub-turfs — a crew's ground is one shape
 * however it's split up inside, so picking the parent lights all of it. */
const selectedFamilyIds = computed(() => {
  const sel = selectedTurf.value
  if (!sel) return null
  return familyIdsOf(sel.id)
})

/** Only in overview: while a draft is open the map is about the draft. */
const turfBar = computed(() => (draftOpen.value ? null : selectedTurf.value))
const turfDetailsOpen = ref(false)

function toggleTurfDetails() {
  turfDetailsOpen.value = !turfDetailsOpen.value
}

function clearTurfSelection() {
  selectedTurfId.value = null
}

/** Tapping a door selects the turf that owns it — the map is the fastest way
 * to ask "whose is this, and let me at it". The TOP-LEVEL turf, the same one
 * whose color the dot is wearing: this page divides the county between
 * crews, and per-member shares belong to the Squad page. */
function selectTurfOfDoor(a: AddressLite) {
  if (draftOpen.value || !a.turf_id) return
  selectedTurfId.value = paintTurfOf(a.turf_id)?.id ?? a.turf_id
}

// Repaint on selection (the highlight is paint state), and close the details
// popover — it describes whichever turf was selected when it opened. Its own
// watcher, not the big paint one up the file: selectedTurfId is declared down
// here, and that array is evaluated where it's written.
watch(selectedTurfId, () => {
  turfDetailsOpen.value = false
  doorLayer?.requestRepaint()
})

function editTurf(t: TurfWithMeta) {
  clearDraft()
  undoStack.value = []
  draftOpen.value = true
  editingTurfId.value = t.id
  draftName.value = t.name
  assignChoice.value = assignChoiceOf(t)
  for (const s of t.turf_segments) {
    addSegment(s.street_name, s.city, s.range_start, s.range_end, s.parity)
  }
  focusTurf(t.id)
  // The draft card only just started existing (draftOpen) — scroll to it
  // once it's actually in the DOM.
  void nextTick(focusDraft)
  // The whole turf should be pinned while it's being edited — geocode its
  // still-unmapped doors in the background (same pass a save runs).
  void geocodeTurfDoors(t.id)
}

// --- Combine two turfs (2026-07-25, user call: "there should be a way to
// combine turfs — a button, you just hit combine, and it adds the two turfs
// to each other"). ---
//
// Mechanically identical to the copy-stale flow: free the source's doors,
// then claim source + target segments under the target. It has to be that
// order, because set_turf_segments only ever claims from the free pool — a
// door still stamped with the source turf would simply be declined.
//
// The emptied source turf is then deleted, so "combine" leaves one turf and
// not one turf plus a husk. Sub-turfs of either side dissolve on the way (the
// same trigger that fires on re-dispatch), which is right: a per-member split
// of a turf that no longer exists means nothing.

const combineBusy = ref(false)

// --- "Today's turf": collapsed by default, and one control per turf instead
// of one control on every row (2026-07-27, user call: "we don't need a whole
// incredibly long today's turf thing. That should be collapsible. And the UI
// for it is terrible"). ---
//
// It was also the page's single most expensive thing to render: every row
// carried its own AppSelect (a Reka Select — trigger, portal, popper, context,
// and an options array rebuilt per row per render out of every squad and every
// profile in the org), and the list re-sorted itself by door count, so each of
// a cold load's index bumps re-rendered all of it. Collapsed with v-if, none of
// that is mounted, and none of the tallies it reads are even evaluated —
// which is why the guard below counts turfs rather than asking dispatchTurfs
// for its length, since that would sort by door count to answer.

const dispatchOpen = ref(false)

/** Is there anything to dispatch? Deliberately does NOT touch door counts. */
const hasDispatch = computed(() => todayTurfs.value.some((t) => !t.parent_turf_id))

/** Today's top-level turfs, biggest first — the dispatch list. Only ever
 *  evaluated while the card is open. */
const dispatchTurfs = computed(() =>
  todayTurfs.value
    .filter((t) => !t.parent_turf_id)
    .slice()
    .sort((a, b) => turfDoorCount(b.id) - turfDoorCount(a.id)),
)

/** The turf whose dispatch sheet is open. Held by id, so a refetch after an
 *  assignment re-reads the fresh row rather than showing the stale one. */
const dispatchSheetId = ref<string | null>(null)
const dispatchSheetOpen = computed({
  get: () => dispatchSheetId.value !== null,
  set: (v: boolean) => {
    if (!v) dispatchSheetId.value = null
  },
})
const dispatchSheetTurf = computed(
  () => turfs.value.find((t) => t.id === dispatchSheetId.value) ?? null,
)

/** Who a turf is out with right now, in words. */
function crewLabel(t: TurfWithMeta): string {
  if (t.squad) return t.squad.name
  if (t.assignee) return t.assignee.display_name || t.assignee.username
  return 'Unassigned'
}

/** Pick this turf on the map and close the sheet — the map is behind it. */
function showTurfOnMap(t: TurfWithMeta) {
  dispatchSheetId.value = null
  onPickTurf(t.id)
  // Closing a sheet locks the page for the length of its exit animation, and a
  // scroll fired inside that window is not delayed, it is discarded (see
  // appChrome). Wait the lock out rather than scrolling into a no-op.
  afterScrollUnlock(() => scrollMapIntoView())
}

/** Doors per turf, its sub-turfs' doors folded into it — a crew's assignment
 * doesn't shrink because a leader split it up.
 *
 * ONE pass over the index for the whole list, not one per turf. This used to be
 * a plain function scanning all 22,746 addresses per call, and `dispatchTurfs`
 * sorts by it: two calls per comparison, so a dozen turfs cost several million
 * iterations on every render. Tallying once and looking up is also what lets it
 * be a computed, which is the actual fix — see addressIndexVersion. */
const doorCountByTurf = computed<Map<string, number>>(() => {
  addressIndexVersion.value
  const direct = new Map<string, number>()
  for (const a of addressById.values()) {
    if (!a.turf_id) continue
    direct.set(a.turf_id, (direct.get(a.turf_id) ?? 0) + 1)
  }
  const byId = turfById.value
  const total = new Map<string, number>()
  for (const [id, n] of direct) {
    total.set(id, (total.get(id) ?? 0) + n)
    const parent = byId.get(id)?.parent_turf_id
    if (parent) total.set(parent, (total.get(parent) ?? 0) + n)
  }
  return total
})

function turfDoorCount(turfId: string): number {
  return doorCountByTurf.value.get(turfId) ?? 0
}

/** Turfs the selected one can merge into: today's other TOP-LEVEL turfs the
 * viewer may manage. Sub-turfs are excluded on both sides — they're a squad
 * page concept and their doors belong to a parent pool. */
function combineTargets(t: TurfWithMeta): SelectOption[] {
  return [
    { value: 'none', label: 'Combine into…' },
    ...todayTurfs.value
      .filter((o) => o.id !== t.id && !o.parent_turf_id && canManage(o))
      .map((o) => ({ value: o.id, label: o.name })),
  ]
}

async function combineTurf(source: TurfWithMeta, targetId: string) {
  if (targetId === 'none' || combineBusy.value) return
  const target = turfById.value.get(targetId)
  if (!target) return
  const moving = [...addressById.values()].filter((a) => a.turf_id === source.id).length
  if (
    !window.confirm(
      `Move ${moving} door${moving === 1 ? '' : 's'} from "${source.name}" into "${target.name}"? "${source.name}" is deleted.`,
    )
  ) {
    return
  }
  combineBusy.value = true
  listError.value = ''
  try {
    if (editingTurfId.value === source.id || editingTurfId.value === target.id) closeDraft()
    const asPayload = (rows: TurfWithMeta['turf_segments']): SegmentPayload[] =>
      rows.map((s) => ({
        street_name: s.street_name,
        city: s.city,
        range_start: s.range_start,
        range_end: s.range_end,
        parity: s.parity,
      }))
    // 1. Release the source's doors into the free pool.
    const { error: freeErr } = await supabase.rpc('set_turf_segments', {
      target_turf_id: source.id,
      segments: [],
    })
    if (freeErr) throw freeErr
    // 2. Claim both sets under the target. The RPC rewrites the stored
    //    segments honestly from what it actually claimed, so overlapping or
    //    adjacent ranges from the two turfs come out as clean runs.
    const { error: claimErr } = await supabase.rpc('set_turf_segments', {
      target_turf_id: target.id,
      segments: [...asPayload(target.turf_segments), ...asPayload(source.turf_segments)],
    })
    if (claimErr) throw claimErr
    // 3. The husk goes.
    const { error: delErr } = await supabase.from('turfs').delete().eq('id', source.id)
    if (delErr) throw delErr
    selectedTurfId.value = target.id
    await reloadAll()
    flash(`Combined into ${target.name}.`)
  } catch {
    listError.value = 'Could not combine that turf. Reload and try again.'
  } finally {
    combineBusy.value = false
  }
}

async function deleteTurf(t: TurfWithMeta) {
  const consequence = t.parent_turf_id
    ? `Its doors return to "${parentName(t)}".`
    : 'Its doors become unassigned.'
  if (!window.confirm(`Delete ${t.parent_turf_id ? 'sub-turf' : 'turf'} "${t.name}"? ${consequence}`)) return
  if (editingTurfId.value === t.id) closeDraft()
  await supabase.from('turfs').delete().eq('id', t.id)
  if (selectedTurfId.value === t.id) selectedTurfId.value = null
  await reloadAll()
}

/** A turf's whole ground: itself plus its sub-turfs. `addresses.turf_id`
 * points at the SUB-turf once a leader splits a crew's turf on the Squad
 * page, so a parent on its own can own no doors at all — and this page paints
 * and highlights the family as one shape (see paintTurfOf). */
function familyIdsOf(turfId: string): Set<string> {
  const ids = new Set<string>([turfId])
  for (const t of turfs.value) if (t.parent_turf_id === turfId) ids.add(t.id)
  return ids
}

/** Is any of this ground already on screen? Same test Scout (`myTurfInView`)
 * and Squad (`ourTurfInView`) make before they re-frame. */
function turfInView(ids: Set<string>): boolean {
  const bounds = map?.getBounds()
  if (!bounds) return false
  for (const a of addressById.values()) {
    if (!a.turf_id || !ids.has(a.turf_id)) continue
    if (a.lat != null && a.lng != null && bounds.contains({ lat: a.lat, lng: a.lng })) return true
  }
  return false
}

/** Frame a turf — unless you can already see some of it (2026-07-26, user
 * call: "if we can see any of the pins, then we don't mess with the Zoom. We
 * only zoom over to something when we've selected it from somewhere else
 * other than the map. But when you click on the map and then click edit, no
 * zooming should occur"). One rule covers both halves: a door you tapped is
 * by definition on screen, so Edit holds still; a turf picked from the
 * dropdown or the dispatch list across the county isn't, so it flies. */
function focusTurf(turfId: string) {
  if (!map) return
  const ids = familyIdsOf(turfId)
  if (turfInView(ids)) return
  const bounds = new google.maps.LatLngBounds()
  for (const a of addressById.values()) {
    if (a.turf_id && ids.has(a.turf_id) && a.lat != null && a.lng != null) {
      bounds.extend({ lat: a.lat, lng: a.lng })
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 64)
  // Keyed on the index, not the badge: the badge now gives up after four
  // seconds while the county is still arriving, so it no longer answers "could
  // this turf's doors simply not be here yet?".
  else if (!indexComplete.value) flash('Still loading street data. Try that again in a moment.')
}

/** Opening a draft keeps you AT THE TOP — on the map, with Save / Start over
 * / Cancel in the row directly under it (2026-07-25, user call: "when we
 * edit, we don't want to get brought to the bottom of the screen, we just
 * wanna stay up top"). It used to scroll the draft CARD into view, which
 * back when the card led with its streets table meant riding down past the
 * map to reach the buttons; with the buttons moved up, the map IS the draft
 * card's front door. `nearest` means no movement at all when you started up
 * there — tapping Edit on the map bar doesn't twitch the page. */
function focusDraft() {
  scrollMapIntoView()
}

// --- Map fullscreen. Same approach as Scout's (HuntTab): Safari (incl.
// iOS) only ever exposes the webkit-prefixed API, so both directions need a
// fallback, and Google Maps has to be told its container resized once the
// browser finishes the transition. ---

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
    // The canvas overlay sizes itself off the map div — re-measure after the
    // transition or it keeps painting at the old dimensions.
    doorLayer?.checkView()
    doorLayer?.requestRepaint()
  }, 0)
}

// --- Jump to top / bottom ---
// A pair of fixed left-edge buttons for the one case that earns them: a
// draft with a LOT of streets in it, where the table alone runs several
// screens and the map is a long thumb-scroll away. Anything shorter than
// that scrolls fine on its own and the buttons are just two chips sitting
// over the page (2026-07-25, user call: "take out the top and bottom scroll
// buttons — or have it only show up when there are more than twelve streets
// being shown"). Never in fullscreen; the map owns the screen then.

/** Streets in the draft table before the jump pair appears. */
const JUMP_MIN_STREETS = 12

const scrollY = ref(0)

function measureScroll() {
  const el = document.scrollingElement ?? document.documentElement
  scrollY.value = el.scrollTop
}

const showJump = computed(
  () => !isFullscreen.value && streetGroups.value.length > JUMP_MIN_STREETS,
)
const atPageTop = computed(() => scrollY.value < 40)
const atPageBottom = computed(() => {
  const el = document.scrollingElement ?? document.documentElement
  return scrollY.value + window.innerHeight >= el.scrollHeight - 40
})

function jumpTo(where: 'top' | 'bottom') {
  const el = document.scrollingElement ?? document.documentElement
  el.scrollTo({ top: where === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' })
}

// Drags inside the map are the map's, never the page's; a touch on a map
// that's scrolled half off screen brings it back into view first. Shared with
// Scout and the Squad map (src/lib/mapScroll.ts).
let scrollGuard: MapScrollGuard | null = null

onMounted(() => {
  if (!initStarted) {
    initStarted = true
    void initialize()
  }
  if (mapWrapEl.value) {
    scrollGuard = attachMapScrollGuard(mapWrapEl.value, {
      isFullscreen: () => isFullscreen.value,
    })
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  window.addEventListener('scroll', measureScroll, { passive: true })
  window.addEventListener('resize', measureScroll)
  measureScroll()
})

// Cards appear and disappear as the draft opens/closes and streets pile up —
// re-measure after the DOM settles rather than polling.
watch([draftOpen, segments, streetMatches, selectedTurfId], () => void nextTick(measureScroll), {
  deep: true,
})

onUnmounted(() => {
  unmounted = true
  if (indexBumpTimer) {
    clearTimeout(indexBumpTimer)
    indexBumpTimer = null
  }
  scrollGuard?.dispose()
  scrollGuard = null
  doorLayer?.dispose()
  cityLayer?.dispose()
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  window.removeEventListener('scroll', measureScroll)
  window.removeEventListener('resize', measureScroll)
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
          Cutting turf is a manager's or squad leader's job.
          <router-link to="/canvass">Canvass</router-link>
        </p>
      </div>
    </div>
    <div v-else class="stack">
      <!-- WHICH turf you're cutting, at the very top of the page (2026-07-25,
           user call: "it should be a little bit more obvious which turf we're
           editing, it should display it more towards the top"). Sticky, so it
           stays put while you work down the streets table. Wears the turf's
           own color, and says Editing vs New so a re-cut is never mistaken
           for a fresh one. -->
      <div
        v-if="draftOpen"
        class="editing-bar"
        :style="{ '--draft-color': draftColor }"
      >
        <span class="editing-dot" aria-hidden="true"></span>
        <span class="editing-what">{{
          editingTurfId
            ? isSubcutter ? 'Editing sub-turf' : 'Editing'
            : isSubcutter ? 'New sub-turf' : 'New turf'
        }}</span>
        <strong class="editing-name">{{ draftName.trim() || defaultDraftName }}</strong>
        <span class="editing-count">{{ draftDoorCount }} door{{ draftDoorCount === 1 ? '' : 's' }}</span>
        <!-- Take stays armed after its map button hides with the tool, so
             this chip is both the reminder and the way off. -->
        <button
          v-if="takeMode"
          type="button"
          class="editing-take"
          title="Take is on. Sweeps pull doors out of whoever holds them. Tap to turn it off."
          @click="toggleTakeMode"
        >
          Take ✕
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

      <!-- This draft was pre-built from an AI chat suggestion. Say so on
           screen: the assistant proposed the ground, but it's an ordinary
           draft and nothing is claimed until a human saves it. -->
      <div v-if="draftOpen && planNote" class="plan-banner">
        <strong>Suggested by the assistant</strong>
        <span class="plan-banner-note">{{ planNote }}</span>
        <span class="muted"
          >Review the streets below, change anything, then Save. Nothing is claimed until you
          do.</span
        >
      </div>

      <!-- Find a street by name: tap a match to zoom to it and see its
           doors; the located row grows the explicit "Add to turf" button.
           Cutting only — in overview there's no draft for a street to
           join, and the search box is how a cut starts. -->
      <input
        v-if="draftOpen"
        :value="streetQuery"
        class="street-search"
        data-help="turf-search"
        type="search"
        placeholder="Type a street name to start"
        aria-label="Search streets"
        @input="onStreetInput(($event.target as HTMLInputElement).value)"
      />
      <div v-if="draftOpen && streetMatches.length" class="street-matches">
        <div
          v-for="m in streetMatches"
          :key="m.street_name + m.city"
          class="street-match"
          :class="{ located: isLocated(m) }"
        >
          <button class="street-match-main" @click="locateStreet(m)">
            <span class="street-match-name">{{ m.street_name }}</span>
            <span class="muted">{{ m.city }} · {{ m.count }} doors · {{ m.lo }} to {{ m.hi }}</span>
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
              <span class="muted">to</span>
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

      <div
        ref="mapWrapEl"
        class="map-wrap"
        :class="{ 'map-wrap-fullscreen': isFullscreen }"
        data-help="turf-map"
      >
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
        <!-- Map layers: color every door by the turf that owns it, and city
             limits. Stacked directly beneath the pin-style toggle. -->
        <div class="layer-toggle" role="group" aria-label="Map layers">
          <button
            type="button"
            class="layer-btn"
            :class="{ active: showTurfColors }"
            :aria-pressed="showTurfColors"
            title="Ring every door in the color of the turf that owns it"
            @click="toggleTurfColors"
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
        <!-- The way out of an edit, top-right beside fullscreen (2026-07-26,
             user call: "the cancel button… is just kind of in a weird spot,
             and it should always be there whether or not we've made any
             changes yet… it could just be at the top right corner of the
             map"). It used to be the last button in the draft card's action
             row, a scroll below the map and gone entirely in fullscreen. -->
        <button
          v-if="draftOpen"
          type="button"
          class="map-cancel-btn"
          :disabled="saving"
          @click="cancelEdit"
        >
          {{ editingTurfId ? 'Cancel edit' : 'Cancel' }}
        </button>
        <!-- Fullscreen, top-right corner. Always available — the map is the
             work surface, and on a phone the page chrome eats most of it. -->
        <button
          type="button"
          class="map-fullscreen-btn"
          :aria-label="isFullscreen ? 'Exit fullscreen map' : 'View map fullscreen'"
          title="Fullscreen"
          @click="toggleFullscreen"
        >
          <!-- Four corner brackets pointing out (enter) / in (exit), drawn
               inline so it renders identically everywhere. -->
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <template v-if="isFullscreen">
              <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </template>
            <template v-else>
              <path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </template>
          </svg>
        </button>
        <!-- Undo, right under the fullscreen button: the draft-card Undo is
             a scroll away (and invisible in fullscreen), and undo is the
             one control you reach for mid-gesture. -->
        <button
          v-if="draftOpen && canUndo"
          type="button"
          class="map-undo-btn"
          :disabled="saving"
          aria-label="Undo the last change to this turf"
          title="Undo"
          @click="undoDraft"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M9 14 4 9l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4 9h10a6 6 0 0 1 0 12h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <!-- Selection tools, top-right: Lasso (freezes the map, drag a
             loop) and Streets (tap the road itself to take a whole
             street). While either is armed, Add/Erase picks what it does.
             Cutting only — in overview there's no draft to sweep into. -->
        <div v-if="draftOpen" class="lasso-toggle" data-help="turf-tools">
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
        </div>
        <!-- Add/Erase on their OWN row underneath, at small size — the Squad
             page's arrangement, brought back here (2026-07-25, user call:
             "two at the top, two small ones in the bottom"). Four buttons on
             one row was too busy and reached across the map. -->
        <div v-if="draftOpen && (lassoActive || streetTapActive)" class="sweep-mode-row">
          <button
            type="button"
            class="layer-btn btn-tiny"
            :class="{ active: selectMode === 'add' }"
            :aria-pressed="selectMode === 'add'"
            title="Add the selection to the turf"
            @click="selectMode = 'add'"
          >
            Add
          </button>
          <button
            type="button"
            class="layer-btn btn-tiny lasso-erase"
            :class="{ active: selectMode === 'erase' }"
            :aria-pressed="selectMode === 'erase'"
            title="Remove the selection from the turf"
            @click="selectMode = 'erase'"
          >
            Erase
          </button>
        </div>
        <!-- Destructive create. Armed, every sweep takes the doors it lands
             on from whoever holds them, instead of skipping and asking. Only
             while a sweep tool is armed to ADD (2026-07-25, user call: "only
             when I have lasso in add mode do we see Take") — it modifies what
             a sweep does, so it has no business on screen when no sweep can
             happen. -->
        <div v-if="canTake" class="take-row">
          <button
            type="button"
            class="layer-btn btn-tiny take-btn"
            :class="{ active: takeMode }"
            :aria-pressed="takeMode"
            title="Sweeps take doors from other turf instead of skipping them"
            @click="toggleTakeMode"
          >
            Take
          </button>
        </div>
        <!-- The map's bottom edge: what just happened, the house you tapped,
             and the turf that's selected. Stacked, so they never cover each
             other. -->
        <div class="map-bottom">
        <!-- Loading lives at the BOTTOM edge, in the same stack as the flash
             and the door bubble (2026-07-27). Centred at the top it was
             flanked by the two chrome columns, which leaves a 320px phone
             about 128px to say anything in: the first-load line either wrapped
             to five words a line or ran under the pin-style toggle. Nothing
             sits along the bottom, and this column already exists to keep the
             things that do from covering each other. -->
        <div v-if="pinsLoading" class="pins-loading" role="status" aria-live="polite">
          <span class="pins-loading-spinner" aria-hidden="true"></span>
          <span class="pins-loading-text">Loading streets…</span>
        </div>
        <!-- Per-gesture feedback ("Added WALNUT ST, 41 doors"), and only
             while a flash is up — no standing instructions. It lives ON the
             map (2026-07-25): tapping doors one at a time would otherwise
             shove the map down the page with every tap, and a flash above
             the map is invisible in fullscreen, which is where sweeping
             actually happens. -->
        <div v-if="hint" class="sweep-bar" :style="{ '--draft-color': draftColor }">
          <span class="sweep-dot" aria-hidden="true"></span>
          <p class="sweep-hint">{{ hint }}</p>
          <!-- One optional action on the flash — e.g. "Take them too" after a
               capture skipped another turf's doors. -->
          <button v-if="flashAction" class="btn btn-sm btn-primary sweep-action" @click="runFlashAction">
            {{ flashAction.label }}
          </button>
        </div>
        <!-- Compact house history: tap a dot (no tool armed) to see the
             door's last knocks. -->
        <div v-if="doorInfo" class="door-card">
          <div class="door-card-head">
            <strong class="door-card-street">{{ doorInfo.address.street }}</strong>
            <span class="muted">{{ doorInfo.address.city }}</span>
            <button class="door-card-x" aria-label="Close house history" @click="doorInfo = null">✕</button>
          </div>
          <!-- Which turf owns this door. Editing it lives one row down, on
               the selection bar — the tap that opened this card selected
               that turf, so the button is already on screen. -->
          <div v-if="doorOwner" class="door-card-owner">
            <span class="door-card-owner-text">
              In <strong>{{ doorOwner.name }}</strong>
              <span class="muted"> · {{ ownerAssignment(doorOwner) }}</span>
            </span>
            <button
              v-if="!turfBar && canManage(doorOwner) && isTodayTurf(doorOwner)"
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
              <span class="door-card-outcome">{{ OUTCOME_SHORT[k.outcome] }}</span>
              <span v-if="knockWho(k)" class="muted door-card-who">{{ knockWho(k) }}</span>
              <span class="muted door-card-when">{{ knockWhen(k.occurred_at) }}</span>
            </li>
          </ul>
        </div>
        <!-- The selected turf. Its doors are lit up behind this; the bar
             says which one, and carries the two things you'd want next. -->
        <div v-if="turfBar" class="turf-bar" data-help="turf-selected">
          <div v-if="turfDetailsOpen" class="turf-bar-details">
            <p class="turf-bar-detail">
              <span class="muted">Out with</span> {{ ownerAssignment(turfBar) }}
            </p>
            <p class="turf-bar-detail">
              <span class="muted">Doors</span>
              {{ addressesReady ? turfDoorCount(turfBar.id) : 'counting…' }}
            </p>
            <p v-if="turfBar.parent_turf_id" class="turf-bar-detail">
              <span class="muted">Inside</span> {{ parentName(turfBar) }}
            </p>
            <p class="turf-bar-detail">
              <span class="muted">Streets</span>
              {{ turfBar.turf_segments.map(segmentLabel).join(' · ') || 'None' }}
            </p>
            <p v-if="crewHistory(turfBar)" class="turf-bar-detail">
              <span class="muted">Crews</span> {{ crewHistory(turfBar) }}
            </p>
            <p v-if="staleDispatchLabel(turfBar)" class="turf-bar-detail turf-bar-stale">
              ⚠ {{ staleDispatchLabel(turfBar) }}
            </p>
          </div>
          <div class="turf-bar-main">
            <span
              class="turf-swatch"
              :style="{ background: turfDisplayColor(turfBar) }"
              aria-hidden="true"
            ></span>
            <span class="turf-bar-name">{{ turfBar.name }}</span>
            <button
              v-if="canManage(turfBar) && isTodayTurf(turfBar)"
              type="button"
              class="turf-bar-btn"
              @click="editOwnerTurf(turfBar)"
            >
              Edit
            </button>
            <button
              type="button"
              class="turf-bar-btn turf-bar-q"
              :class="{ active: turfDetailsOpen }"
              :aria-pressed="turfDetailsOpen"
              aria-label="Turf details"
              @click="toggleTurfDetails"
            >
              ?
            </button>
            <button
              type="button"
              class="turf-bar-x"
              aria-label="Clear turf selection"
              @click="clearTurfSelection"
            >
              ✕
            </button>
          </div>
        </div>
        </div>
      </div>
      <p v-if="loadError" class="muted map-error">{{ loadError }}</p>
      <p v-if="mapsAuthError" class="muted map-error">
        Google rejected the Maps API key. Usually quota, billing, or a referrer restriction on
        the key. The exact reason is logged in the browser console.
      </p>

      <!-- Overview: cutting starts only when you ask for it. -->
      <div v-if="!draftOpen && !(isSubcutter && !myParentTurfs.length)" class="new-turf-bar">
        <button class="btn btn-primary new-turf-btn" data-help="turf-create" @click="startNewTurf">
          + {{ isSubcutter ? 'Create new sub-turf' : 'Create new turf' }}
        </button>
      </div>
      <p v-else-if="!draftOpen" class="muted empty-note">
        {{ turfsLoaded ? 'No turf assigned to you yet.' : 'Loading…' }}
      </p>

      <!-- Draft tray: the turf being cut. -->
      <div
        v-if="draftOpen"
        class="card draft-card"
        :style="{ '--draft-color': draftColor }"
      >
        <!-- A lead with no assigned turf has no ground to cut on. -->
        <template v-if="isSubcutter && !myParentTurfs.length">
          <h3 class="draft-title">
            <span class="draft-swatch" aria-hidden="true"></span>
            Sub-turf
          </h3>
          <p class="muted empty-note">No turf assigned to you yet.</p>
        </template>
        <template v-else>
        <!-- Save / Start over / Cancel FIRST, so they sit directly under the
             map (2026-07-25, user call: "I want those buttons right below the
             map so they're right there and easy to get to"). Everything else
             about the draft — its name, who it's for, the streets in it — is
             set once; these three are what you reach for after every
             gesture. -->
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
          <!-- Cancel is on the MAP now (2026-07-26) — see .map-cancel-btn. -->
        </div>
        <p v-if="saveError" class="error">{{ saveError }}</p>

        <!-- No heading here: the sticky bar at the top of the page already
             says which turf this is and how many doors are in it, and saying
             it twice on a phone screen is a card's worth of nothing. -->

        <!-- Which turf the sub-turf carves from (auto when there's one). -->
        <AppSelect
          v-if="isSubcutter && !editingTurfId && myParentTurfs.length > 1"
          class="parent-pick"
          small
          :options="myParentTurfs.map((t) => ({ value: t.id, label: `Inside: ${t.name}` }))"
          :model-value="draftParentId ?? ''"
          aria-label="Cut inside which of your turf"
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
          <!-- Streets list: ONE line per street, its name and its door count,
               nothing else (2026-07-26, user call — house-number ranges on
               every row made a twelve-street turf a wall of digits). Tap a
               street and everything about it opens under its own row: which
               stretches of it are in, the from–to and side editor, and
               dropping it. A street cut into several stretches (a trimmed
               hole splits a run) lists them as chips, one tap each — the
               segments themselves are unchanged, this is display only.
               Opening a street also focuses the map on it: its doors paint,
               and map taps trim houses. -->
          <div class="seg-table" role="list" aria-label="Streets in this turf" data-help="turf-streets">
            <div
              v-for="group in streetGroups"
              :key="group.key"
              class="seg-item"
              :class="{ open: isGroupOpen(group) }"
              role="listitem"
            >
              <button
                type="button"
                class="seg-row"
                :aria-expanded="isGroupOpen(group)"
                @click="toggleGroupEditor(group)"
              >
                <span class="seg-street-name">{{ group.street_name }}</span>
                <span
                  class="seg-count"
                  :class="{ 'seg-count-empty': !group.doorCount }"
                >{{ group.doorCount }}</span>
                <span class="seg-caret" aria-hidden="true">{{ isGroupOpen(group) ? '▴' : '▾' }}</span>
              </button>

              <div v-if="isGroupOpen(group) && expandedSeg" class="seg-panel">
                <!-- One stretch needs no chooser. -->
                <div v-if="group.segs.length > 1" class="seg-chunks">
                  <button
                    v-for="seg in group.segs"
                    :key="seg.key"
                    type="button"
                    class="seg-range-chip"
                    :class="{ active: expandedSegKey === seg.key }"
                    @click="openSegChunk(seg.key)"
                  >{{ rangeLabel(seg) }}</button>
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
                  <span class="muted">to</span>
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
                <p v-if="expandedSegSkipNote" class="muted seg-trim-hint">{{ expandedSegSkipNote }}</p>
                <div class="seg-panel-foot">
                  <span class="seg-panel-facts">
                    <span class="seg-doors" :class="{ 'seg-doors-empty': !expandedSeg.doorCount }">
                      {{ expandedSeg.doorCount }} doors
                    </span>
                    <span class="muted">{{ expandedSeg.city ?? 'any city' }}</span>
                  </span>
                  <button
                    class="btn btn-ghost btn-sm seg-remove"
                    :aria-label="`Remove ${group.street_name}`"
                    @click="removeGroupWithUndo(group)"
                  >
                    Remove street
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>
        <p v-else class="muted empty-note">No streets yet.</p>

        <div class="draft-form">
          <input
            v-model="draftName"
            class="draft-name"
            type="text"
            maxlength="80"
            placeholder="Turf name (optional, defaults to the assignee)"
            aria-label="Turf name (optional)"
          />
          <AppSelect v-model="assignChoice" :options="assignOptions" aria-label="Assign this turf to" />
          <p v-if="draftSkipNote" class="muted">{{ draftSkipNote }}</p>
        </div>
        </template>
      </div>

      <!-- Existing turfs: one dropdown instead of a long list. Picking a
           turf zooms the map to it and opens its management card. Overview
           only — while you're cutting, the picker and the dispatch list below
           are a different job, and they made a long page longer (2026-07-25
           common-sense pass). -->
      <div v-if="!draftOpen" class="card">
        <h3>{{ isSubcutter ? 'Your turf' : 'Turfs' }}</h3>
        <p v-if="!turfsLoaded" class="muted empty-note">Loading…</p>
        <p v-else-if="!listTurfs.length" class="muted empty-note">
          {{ isSubcutter ? 'No turf assigned to you yet.' : 'No turf cut yet.' }}
        </p>
        <template v-else>
          <AppSelect
            class="turf-pick"
            data-help="turf-list"
            :options="turfPickOptions"
            :model-value="selectedTurfId ?? 'none'"
            aria-label="Zoom to a turf"
            @update:model-value="onPickTurf"
          />
          <div v-if="selectedTurf" class="turf-row">
            <div class="turf-row-top">
              <button class="turf-row-main" @click="tapTurfRow(selectedTurf.id)">
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
            <!-- Merge this turf into another one. Top-level turfs only. -->
            <AppSelect
              v-if="canManage(selectedTurf) && !selectedTurf.parent_turf_id"
              class="turf-row-assign"
              small
              :disabled="combineBusy"
              :options="combineTargets(selectedTurf)"
              model-value="none"
              :aria-label="`Combine ${selectedTurf.name} into another turf`"
              @update:model-value="combineTurf(selectedTurf, $event)"
            />
          </div>
        </template>
        <p v-if="listError" class="error">{{ listError }}</p>
      </div>

      <!-- Dispatch: every turf out today with the crew on it, each row one
           tap from a reassignment (2026-07-25, user call: "we want an easy
           way to assign a squad to a turf"). The picker card above handles
           ONE turf at a time and made sending five crews out a five-trip
           job. Managers only — a sub-cutter doesn't dispatch.

           Collapsed until asked for (2026-07-27): the list runs as long as
           the day's crews, and mounting a dropdown on every row of it was
           the most expensive thing this page rendered. -->
      <div v-if="!draftOpen && isManager && hasDispatch" class="card options-card" data-help="turf-dispatch">
        <button
          class="options-head"
          :aria-expanded="dispatchOpen"
          @click="dispatchOpen = !dispatchOpen"
        >
          <span>Today's turf</span>
          <span class="options-caret" aria-hidden="true">{{ dispatchOpen ? '▴' : '▾' }}</span>
        </button>
        <!-- v-if, never v-show: a closed card must not mount its rows. -->
        <div v-if="dispatchOpen" class="dispatch-list">
          <button
            v-for="t in dispatchTurfs"
            :key="t.id"
            class="dispatch-row"
            :class="{ picked: selectedTurfId === t.id }"
            @click="dispatchSheetId = t.id"
          >
            <span class="turf-swatch" :style="{ background: turfDisplayColor(t) }" aria-hidden="true"></span>
            <span class="dispatch-text">
              <span class="dispatch-name">{{ t.name }}</span>
              <!-- No count until the street index is in. Before that a turf
                   doesn't hold zero doors, it holds an unknown number, and
                   "0 doors" is the one reading that's actually wrong. -->
              <span class="muted dispatch-meta">
                {{ addressesReady ? `${turfDoorCount(t.id)} doors` : 'Counting doors…' }}
              </span>
            </span>
            <span class="dispatch-crew" :class="{ none: !t.squad && !t.assignee }">
              {{ crewLabel(t) }}
            </span>
          </button>
        </div>
      </div>

      <!-- One turf's dispatch. The assign control lives here rather than on
           every row: a manager touches one turf at a time, and 70 mounted
           dropdowns is what made this list slow to open. -->
      <BottomSheet
        v-model:open="dispatchSheetOpen"
        :title="dispatchSheetTurf?.name ?? 'Turf'"
      >
        <div v-if="dispatchSheetTurf" class="sheet-body">
          <!-- Just the count: the picker below is the crew, live and editable,
               so naming it here would be the same fact twice. -->
          <p class="muted sheet-line">
            {{ addressesReady ? `${turfDoorCount(dispatchSheetTurf.id)} doors` : 'Counting doors…' }}
          </p>
          <p v-if="staleDispatchLabel(dispatchSheetTurf)" class="turf-stale">
            ⚠ {{ staleDispatchLabel(dispatchSheetTurf) }}
          </p>
          <AppSelect
            :options="assignOptionsFor(dispatchSheetTurf)"
            :model-value="assignChoiceOf(dispatchSheetTurf)"
            :aria-label="`Assign ${dispatchSheetTurf.name}`"
            @update:model-value="reassignTurf(dispatchSheetTurf, $event)"
          />
          <button class="btn btn-ghost" @click="showTurfOnMap(dispatchSheetTurf)">Show on map</button>
          <p v-if="listError" class="error">{{ listError }}</p>
        </div>
      </BottomSheet>

      <!-- Long-page shortcut: the cutting screen runs well past one viewport
           (map + streets table + turf card), so park a jump pair on the left
           edge rather than making anyone thumb-scroll the whole way. -->
      <div v-if="showJump" class="jump-nav" role="group" aria-label="Jump on page">
        <button
          type="button"
          class="jump-btn"
          :disabled="atPageTop"
          aria-label="Jump to top of page"
          @click="jumpTo('top')"
        >
          <span aria-hidden="true">↑</span> Top
        </button>
        <button
          type="button"
          class="jump-btn"
          :disabled="atPageBottom"
          aria-label="Jump to bottom of page"
          @click="jumpTo('bottom')"
        >
          <span aria-hidden="true">↓</span> Bottom
        </button>
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

/* --- Jump to top / bottom ---
   Fixed to the left edge, clear of the phone tab bar. Sits below the tab
   bar's z-index (40) so it can never cover navigation. */

.jump-nav {
  position: fixed;
  /* The phone's left edge — 0 on a phone, the frame's gutter on a desktop
     window (style.css). The tab bar is on every screen size now, so the old
     `(min-width: 768px)` rule that lifted this to the window bottom is gone. */
  left: calc(var(--frame-left) + 0.5rem);
  bottom: calc(5.25rem + env(safe-area-inset-bottom, 0px));
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.jump-btn {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
  opacity: 0.92;
}

.jump-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* --- Sweep bar --- */

/* Flash line, pinned inside the map's bottom stack. */
.sweep-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-left: 6px solid var(--draft-color);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--draft-color) 6%, var(--surface));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
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

/* A row in the .map-bottom stack, sized to its words and centred there. */
.pins-loading {
  align-self: center;
  max-width: 100%;
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
}

/* A message, not a surface — same as the flash it stacks with: taps go
   through it to the map. */
.map-bottom > .pins-loading {
  pointer-events: none;
}

/* Actual Fullscreen API target — filling the screen only takes effect once
 * the browser grants it, driven by the JS-toggled class rather than the
 * `:fullscreen` pseudo-class so old-Safari's webkit-prefixed event (no
 * matching prefixed pseudo-class) still gets the right layout. */
.map-wrap-fullscreen {
  background: #000;
}

.map-wrap-fullscreen .map {
  height: 100%;
  border-radius: 0;
  border: none;
}

/* Fullscreen button, top-right corner. */
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

/* Cancel edit, row 1 of the right column, immediately LEFT of the fullscreen
   button rather than in the corner itself. Two reasons it doesn't take the
   corner: fullscreen sits there on all three maps and moving it per-screen
   would be a surprise, and this button comes and goes with the draft — a
   control that isn't always there must never shift one that is (the same rule
   that put Undo last in the left column). */
.map-cancel-btn {
  position: absolute;
  top: 0.6rem;
  right: calc(0.6rem + 36px + 0.5rem);
  min-height: 36px;
  padding: 0 0.7rem;
  display: flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: calc(0.8rem * var(--ui-scale, 1));
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.map-cancel-btn:hover:not(:disabled) {
  background: var(--surface-2);
}

.map-cancel-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Undo, third in the LEFT stack (under pin-style and layers) — last in that
 * column, so it appearing/disappearing never shifts another control. */
.map-undo-btn {
  position: absolute;
  top: calc(0.6rem + 2 * (36px + 0.5rem));
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
  background: var(--surface-2);
}

.map-undo-btn:disabled {
  opacity: 0.5;
  cursor: default;
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

/* Collapsible card: same head/caret idiom as Board options and Feed options. */
.options-card {
  padding: 0;
}

.options-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.7rem 0.9rem;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.options-caret {
  color: var(--text-muted);
}

/* Dispatch list: one row per turf out today. The whole row is the tap target
   and every action lives in the sheet it opens, the same lesson the Squad
   page's member tiles learned. */
.dispatch-list {
  display: flex;
  flex-direction: column;
  padding: 0 0.5rem 0.6rem;
}

.dispatch-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.4rem;
  border: none;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  /* A <button> centres and clamps its contents without these. */
  text-align: left;
  white-space: normal;
  cursor: pointer;
}

.dispatch-row + .dispatch-row {
  border-top: 1px solid var(--border);
  border-radius: 0;
}

/* The picked row — the one the map is framed on. */
.dispatch-row.picked {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.dispatch-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.dispatch-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dispatch-meta {
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

/* Who it is out with, right-aligned so the column reads down the list. */
.dispatch-crew {
  flex: 0 1 auto;
  max-width: 40%;
  font-size: 0.82rem;
  font-weight: 600;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dispatch-crew.none {
  color: var(--text-muted);
  font-weight: 500;
}

.sheet-body {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding-bottom: 0.5rem;
}

.sheet-line {
  margin: 0;
  font-size: 0.9rem;
}

/* Which turf is being cut. Sticky at the top of the page so it survives
   scrolling down through the streets table. */
.editing-bar {
  position: sticky;
  /* Under the app header, which is sticky itself now (2026-07-25) — at 0 this
     bar would slide behind it. */
  top: var(--app-top-h, 0px);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-left: 4px solid var(--draft-color);
  border-radius: var(--radius);
  background: var(--surface);
}

.editing-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--draft-color);
  flex: 0 0 auto;
}

.editing-what {
  color: var(--text-muted);
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.editing-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editing-count {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.editing-take {
  flex-shrink: 0;
  padding: 0.15rem 0.5rem;
  border: none;
  border-radius: 999px;
  background: #d64545;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  cursor: pointer;
}

/* Lasso toggle, top-right under the fullscreen button — same chrome as the
   layer buttons. */
.lasso-toggle {
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

/* Rows 3 and 4 of the right column: Add/Erase, then Take. Both sit UNDER
   the two tool buttons at reduced size, so the tools stay the thing you aim
   at and the modifiers stay out of the way. */
.sweep-mode-row,
.take-row {
  position: absolute;
  right: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  z-index: 6;
}

.sweep-mode-row {
  top: calc(0.6rem + (36px + 0.5rem) * 2);
}

/* Sits directly under Add/Erase when a tool is armed, and slides up into
   that slot when none is. */
.take-row {
  top: calc(0.6rem + (36px + 0.5rem) * 2);
}

.sweep-mode-row ~ .take-row {
  top: calc(0.6rem + 36px + 0.5rem + 28px + 0.4rem + 36px + 0.5rem);
}

.btn-tiny {
  min-height: 28px;
  padding: 0 0.55rem;
  font-size: calc(0.78rem * var(--ui-scale));
}

/* Armed Take is a warning, not a normal selection — it is the one control
   here that changes somebody else's turf. */
.take-btn.active {
  background: #d64545;
  color: #fff;
}

.layer-btn {
  min-height: 36px;
  padding: 0 0.7rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: calc(0.8rem * var(--ui-scale, 1));
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
/* Bottom-edge stack: the tapped house's card, and under it the selected
   turf's bar. A column so the two can never cover each other, and no taller
   than the map — the house card shrinks and scrolls first. */
.map-bottom {
  position: absolute;
  left: 0.6rem;
  right: 0.6rem;
  bottom: 0.6rem;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: calc(100% - 1.2rem);
  pointer-events: none;
}

.map-bottom > * {
  pointer-events: auto;
}

/* The flash is a message, not a surface: it sits over the map's bottom edge
   while you're tapping doors, so taps must pass straight through it. Only
   its action button catches them. */
.map-bottom > .sweep-bar {
  pointer-events: none;
}

.sweep-action {
  pointer-events: auto;
}

.door-card {
  min-height: 0;
  padding: 0.5rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  overflow-y: auto;
}

/* --- The selected turf, on the map ---
   Which turf the lit-up doors belong to, plus the two things you reach for
   next: Edit, and ? for its details. */

.turf-bar {
  flex-shrink: 0;
  padding: 0.45rem 0.55rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

.turf-bar-main {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.turf-bar-name {
  flex: 1;
  min-width: 0;
  font-weight: 700;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turf-bar-btn {
  flex-shrink: 0;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text);
  font-size: calc(0.82rem * var(--ui-scale));
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.turf-bar-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.turf-bar-q {
  width: 2rem;
  text-align: center;
}

.turf-bar-x {
  flex-shrink: 0;
  padding: 0.3rem 0.35rem;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
}

.turf-bar-details {
  margin-bottom: 0.45rem;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--border);
  max-height: 9rem;
  overflow-y: auto;
}

.turf-bar-detail {
  margin: 0 0 0.2rem;
  font-size: 0.82rem;
  line-height: 1.35;
}

.turf-bar-detail .muted {
  margin-right: 0.35rem;
}

.turf-bar-stale {
  color: #b45309;
  font-weight: 600;
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

.pins-loading-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.pins-loading-text small {
  font-weight: 500;
  font-size: 0.74rem;
  color: var(--muted);
}

.pins-loading-spinner {
  flex: none;
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

/* Banner on a draft the AI chat pre-built (?plan=…). */
.plan-banner {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-bottom: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  font-size: 0.85rem;
}

.plan-banner-note {
  color: var(--text);
}

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

/* --- Streets list: one line per street, everything else behind a tap
   (2026-07-26 — "just have the streets listed"). The open street's panel
   drops in under its OWN row rather than at the bottom of the list, so on a
   twelve-street turf the controls are where the finger already is. --- */

.seg-table {
  display: flex;
  flex-direction: column;
  margin-bottom: 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface);
}

.seg-item + .seg-item {
  border-top: 1px solid var(--border);
}

/* The open street is also the map's trim target. */
.seg-item.open {
  background: color-mix(in srgb, var(--draft-color) 10%, var(--surface));
  box-shadow: inset 3px 0 0 var(--draft-color);
}

.seg-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 1rem;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 38px;
  padding: 0 0.55rem;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  /* A <button> gets centered, clamped text from the UA styles otherwise. */
  text-align: left;
  white-space: normal;
  cursor: pointer;
}

.seg-street-name {
  font-weight: 700;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seg-caret {
  font-size: 0.7rem;
  color: var(--text-muted);
  text-align: right;
}

/* Everything about the open street, under its own row. */
.seg-panel {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.1rem 0.55rem 0.6rem;
}

/* A street cut into several stretches picks one to edit. */
.seg-chunks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
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

/* A range that matched no doors is the one thing worth shouting from a
   collapsed row — it means the street is in the turf but empty. */
.seg-count-empty {
  color: var(--danger);
}

.seg-panel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.seg-panel-facts {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
  font-size: 0.8rem;
}

.seg-remove {
  flex-shrink: 0;
  color: var(--danger);
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

/* Top of the draft card = directly under the map. Wraps rather than
   squeezing: Save keeps its size on a narrow phone. */
.draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

/* Overview's one call to action — full width, thumb-sized. */
.new-turf-bar {
  display: flex;
}

.new-turf-btn {
  flex: 1;
  min-height: 52px;
  font-size: 1rem;
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
