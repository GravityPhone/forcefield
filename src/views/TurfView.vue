<script setup lang="ts">
// Turf cutter: the same Google map as Hunt, but pins are paint targets
// instead of knock targets. Cutting works like a highlighter — tap one door
// to anchor a sweep, tap another door down the same street to close it, and
// every door in that house-number range lights up under a colored stroke.
// Sweeps stack into a draft turf that gets a name and an assignee: a squad
// (the day crew sorts out who takes what) or a single canvasser. Saving
// stamps addresses.turf_id server-side via the set_turf_segments RPC, which
// is what Hunt reads to show "your turf".
//
// Roles: campaign managers (and admins) cut anywhere. Squad leaders only
// cut SUB-turfs — cuts inside a turf assigned to them (directly or via
// their squad) that carve doors out of the parent, for splitting the crew's
// assignment. RLS + the RPC enforce this server-side; the scoping here just
// keeps the UI honest.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import AppShell from '@/components/AppShell.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import type { SelectOption } from '@/components/ui/AppSelect.vue'
import { loadMaps, mapsAuthError, MAP_RENDERING_TYPE } from '@/lib/googleMaps'
import { GOOGLE_MAPS_MAP_ID } from '@/lib/config'
import {
  CityLimitsLayer,
  TurfAreasLayer,
  corridorFor,
  dotClusterRenderer,
  readMapPref,
  writeMapPref,
} from '@/lib/mapLayers'
import type { DoorPoint } from '@/lib/mapLayers'
import { walkRanges } from '@/lib/doorPath'
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
 * table (not just geocoded pins), so the door count is exact. */
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
/** Latest outcome per door — pins wear the same status colors as Hunt, so
 * knocked/unknocked history reads the same while cutting. */
const statusByAddress = ref<Map<string, KnockOutcome>>(new Map())

// --- Pin style: dots or house numbers, same toggle as Hunt ---
type PinMode = 'dots' | 'numbers'
/** Below this zoom, numbers mode falls back to plain dots — house numbers
 * only mean something when you're close enough to be looking at one street. */
const NUMBERS_MIN_ZOOM = 16
function readStoredPinMode(): PinMode {
  try {
    return localStorage.getItem('turf-pin-mode') === 'numbers' ? 'numbers' : 'dots'
  } catch {
    return 'dots'
  }
}
const pinMode = ref<PinMode>(readStoredPinMode())
/** Tracked so numbers mode can fall back to dots when zoomed out; only
 * threshold crossings trigger a restyle. */
let mapZoom = 14

function setPinMode(mode: PinMode) {
  pinMode.value = mode
  try {
    localStorage.setItem('turf-pin-mode', mode)
  } catch {
    /* private mode — the toggle still works this session */
  }
  restyleAll()
}

// --- Draft turf state ---
const draftName = ref('')
const segments = ref<DraftSegment[]>([])
const anchor = ref<AddressLite | null>(null)
const parityChoice = ref<TurfParity>('both')
/** Which draft segment's inline editor is open (pill tap toggles it). */
const expandedSegKey = ref<string | null>(null)
const expandedSeg = computed(() => segments.value.find((s) => s.key === expandedSegKey.value) ?? null)

function toggleSegEditor(key: string) {
  expandedSegKey.value = expandedSegKey.value === key ? null : key
}
const editingTurfId = ref<string | null>(null)
/** Which of the lead's turfs a NEW sub-turf carves from (auto when one). */
const draftParentId = ref<string | null>(null)
// 'none' | 'squad:<id>' | 'user:<id>' — Reka's SelectItem forbids '' values.
const assignChoice = ref('none')
const sweepBusy = ref(false)

let map: google.maps.Map | null = null
let clusterer: MarkerClusterer | null = null
let areasLayer: TurfAreasLayer | null = null
let cityLayer: CityLimitsLayer | null = null
/** Draft-sweep shading lives on its own Data layer so it can restyle and
 * clear independently of the saved-turf areas. */
let draftData: google.maps.Data | null = null
const draftFeaturesBySeg = new Map<string, google.maps.Data.Feature[]>()
let initStarted = false
const markersByAddress = new Map<string, google.maps.marker.AdvancedMarkerElement>()
const addressById = new Map<string, AddressLite>()
const segPolylines = new Map<string, google.maps.Polyline>()
/** Street rows already pulled for a sweep, so range tweaks don't re-query. */
const streetCache = new Map<string, AddressLite[]>()
let segKeyCounter = 0
/** Set on teardown so a background geocode sweep stops dropping pins onto a
 * disposed map. */
let unmounted = false

const turfColorById = computed(() => new Map(turfs.value.map((t) => [t.id, t.color])))

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
const showAreas = ref(readMapPref('map-show-areas', true))
const showCity = ref(readMapPref('map-show-city', false))

function toggleAreas() {
  showAreas.value = !showAreas.value
  writeMapPref('map-show-areas', showAreas.value)
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

/** Whether the armed anchor is already part of the turf — informs the hint
 * text. The actual add-vs-erase outcome isn't knowable until the SECOND tap
 * (erase only fires when both taps land on already-included doors), so this
 * doesn't drive any red/danger styling on its own anymore. */
const anchorInTurf = computed(() =>
  anchor.value ? draftMemberIds.value.has(anchor.value.id) : false,
)

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
  if (sweepBusy.value) return 'Sweeping…'
  if (flashMsg.value) return flashMsg.value
  if (anchor.value) {
    const a = anchor.value
    return anchorInTurf.value
      ? `Anchor down at ${a.street} (already in the turf) — tap a new door to extend the turf out to it, or another door already in the turf to erase the stretch between (tap the anchor again to cancel).`
      : `Anchor down at ${a.street} — tap another door to sweep the walk between them, even onto another street (tap the anchor again to cancel).`
  }
  const base =
    'Tap two doors to sweep the walk between them — an existing pin plus a new one extends the turf; two existing pins erase the stretch between. Hold a door to take just it (connects to the rest of the turf); double-tap a street to add or remove it whole.'
  return isSubcutter.value
    ? `${base} Only doors inside your assigned turf count toward a sub-turf.`
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

// --- Map + pins ---

function styleMarker(marker: google.maps.marker.AdvancedMarkerElement, a: AddressLite) {
  const el = marker.content as HTMLElement
  const s = el.style
  const isAnchor = anchor.value?.id === a.id
  const inDraft = draftMemberIds.value.has(a.id)
  // While editing, doors still stamped to the turf but swept OUT of the
  // draft show as ringless — the map previews the save.
  const stampedColor =
    a.turf_id && !(editingTurfId.value && a.turf_id === editingTurfId.value)
      ? turfColorById.value.get(a.turf_id)
      : undefined

  // Fill = knock status, same colors as Hunt (blue = never knocked), so the
  // door's history reads identically while cutting. Ring = turf membership:
  // the draft's color while swept into the cut being drawn, otherwise the
  // saved turf's color, no ring for unclaimed doors.
  const outcome = statusByAddress.value.get(a.id)
  const ring = inDraft ? draftColor.value : stampedColor
  const showNumber = pinMode.value === 'numbers' && mapZoom >= NUMBERS_MIN_ZOOM && !!el.dataset.house
  el.textContent = showNumber ? el.dataset.house! : ''
  s.boxSizing = 'border-box'
  s.cursor = 'pointer'
  s.display = 'flex'
  s.alignItems = 'center'
  s.justifyContent = 'center'
  s.color = '#fff'
  s.fontWeight = '700'
  s.lineHeight = '1'
  if (showNumber) {
    const h = isAnchor ? 24 : inDraft ? 20 : 19
    s.width = 'auto'
    s.height = `${h}px`
    s.minWidth = `${h}px`
    s.padding = '0 5px'
    s.borderRadius = '7px'
    s.fontSize = isAnchor ? '13px' : '11px'
  } else {
    const size = isAnchor ? 24 : inDraft ? 17 : 13
    s.width = `${size}px`
    s.height = `${size}px`
    s.minWidth = ''
    s.padding = ''
    s.borderRadius = '50%'
    s.fontSize = ''
  }
  s.background = outcome ? OUTCOME_HEX[outcome] : PIN_DEFAULT_HEX
  s.border = isAnchor ? '3px solid #111' : '1.5px solid #ffffff'
  s.boxShadow = ring
    ? `0 0 0 2.5px ${ring}, 0 0 3px rgba(0, 0, 0, 0.45)`
    : '0 0 3px rgba(0, 0, 0, 0.45)'
  s.animation = isAnchor ? 'turf-anchor-pulse 1.1s ease-in-out infinite' : ''
  marker.zIndex = isAnchor ? 1000 : inDraft ? 500 : 1
}

function restyleAll() {
  for (const [id, marker] of markersByAddress) {
    const a = addressById.get(id)
    if (a) styleMarker(marker, a)
  }
}

function upsertMarker(a: AddressLite) {
  addressById.set(a.id, a)
  if (a.lat == null || a.lng == null || !map) return
  let marker = markersByAddress.get(a.id)
  if (!marker) {
    const content = document.createElement('div')
    const num = houseNumber(a.street)
    if (num > 0) content.dataset.house = String(num)
    attachHoldGesture(content, a.id)
    marker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat: a.lat, lng: a.lng },
      title: `${a.street}${a.unit ? ' ' + a.unit : ''}`,
      content,
      gmpClickable: true,
    })
    marker.addListener('gmp-click', () => void onPinTap(a.id))
    markersByAddress.set(a.id, marker)
    clusterer?.addMarker(marker)
  }
  styleMarker(marker, a)
}

async function fetchAddresses(): Promise<AddressLite[]> {
  return fetchAllRows<AddressLite>((from, to) =>
    supabase
      .from('addresses')
      .select('id, street, unit, city, zip, lat, lng, turf_id')
      .not('lat', 'is', null)
      .order('id')
      .range(from, to),
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

/** Latest outcome per door, for the status-colored pin fills. Best-effort:
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

async function initialize() {
  pinsLoading.value = true
  let rows: AddressLite[] = []
  try {
    ;[rows] = await Promise.all([
      fetchAddresses(),
      fetchTurfs(),
      loadMaps(),
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
      fetchKnockStatuses(),
    ])
    await computeLeaderlessSquads()
    defaultDraftParent()
  } catch {
    loadError.value = 'Could not load the map or address data. Check your connection.'
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
    zoom: 14,
    mapId: GOOGLE_MAPS_MAP_ID,
    renderingType: MAP_RENDERING_TYPE,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy',
    // Double-click/tap is the street toggle here, not zoom (pinch and the
    // +/- controls still zoom).
    disableDoubleClickZoom: true,
  })
  map.addListener('dblclick', (e: google.maps.MapMouseEvent) => {
    if (e.latLng) void onMapDoubleClick(e.latLng)
  })
  mapZoom = map.getZoom() ?? mapZoom
  map.addListener('zoom_changed', () => {
    const wasClose = mapZoom >= NUMBERS_MIN_ZOOM
    mapZoom = map?.getZoom() ?? mapZoom
    if (pinMode.value === 'numbers' && wasClose !== mapZoom >= NUMBERS_MIN_ZOOM) restyleAll()
  })
  clusterer = new MarkerClusterer({ map, markers: [], renderer: dotClusterRenderer() })

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

  const bounds = new google.maps.LatLngBounds()
  for (const a of rows) {
    upsertMarker(a)
    if (a.lat != null && a.lng != null) bounds.extend({ lat: a.lat, lng: a.lng })
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48)
  buildSavedAreas()
  pinsLoading.value = false
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
  void areasLayer.setTurfs(
    turfs.value
      .filter((t) => doorsByTurf.has(t.id))
      .map((t) => ({ id: t.id, color: t.color, doors: doorsByTurf.get(t.id)! })),
  )
}

/** Re-pull addresses + turfs after a save/delete (turf_id stamps changed
 * server-side) and repaint. */
async function reloadAll() {
  const [rows] = await Promise.all([fetchAddresses(), fetchTurfs(), fetchKnockStatuses()])
  for (const a of rows) upsertMarker(a)
  streetCache.clear()
  defaultDraftParent()
  restyleAll()
  buildSavedAreas()
}

/** After a turf is cut, geocode every door in it that has no coordinates yet
 * (fetchAddresses only pulls already-located rows, so these never showed a
 * pin). Runs in the background one door at a time — the Geocoder rate-limits
 * on bursts — dropping each pin as it resolves and refining the shaded area
 * at the end. Every result caches to the DB, so this is a one-time cost per
 * door: the whole turf ends up pinned everywhere it's shown (Squad, Hunt). */
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
      const a = missing.find((m) => m.id === id)
      if (a) {
        a.lat = loc.lat
        a.lng = loc.lng
        upsertMarker(a)
      }
    },
    () => unmounted,
  )
  if (!unmounted) buildSavedAreas()
}

// --- Sweeping ---

/** Set when a hold gesture fires so the click the browser sends right after
 * releasing the finger doesn't ALSO drop an anchor on the same pin. */
let suppressTapId: string | null = null

async function onPinTap(addressId: string) {
  if (suppressTapId === addressId) {
    suppressTapId = null
    return
  }
  const a = addressById.get(addressId)
  if (!a || sweepBusy.value) return
  if (!anchor.value) {
    anchor.value = a
    restyleAll()
    return
  }
  if (anchor.value.id === a.id) {
    anchor.value = null
    restyleAll()
    return
  }
  const from = anchor.value
  anchor.value = null
  // Same street: the range between the taps. Different streets: the WALK
  // between them — up the anchor's street to the corner where the two
  // streets come closest, then along the second street to the tap. Two taps
  // can cover doors on two streets. An already-included pin plus a NEW pin
  // extends the turf, connecting the two along that walk. Only when BOTH
  // taps land on doors already in the turf does it erase the stretch
  // between them — the one case left where there's nothing to add.
  const ranges = walkRanges(from, a, addressById.values())
  const erasing = draftMemberIds.value.has(from.id) && draftMemberIds.value.has(a.id)
  snapshotDraft()
  if (erasing) {
    for (const r of ranges) await subtractRange(r.street_name, r.city, r.lo, r.hi)
    flash(`Erased ${ranges.map((r) => `${r.street_name} ${r.lo}–${r.hi}`).join(' + ')}.`)
    return
  }
  for (const r of ranges) {
    await addSegment(r.street_name, r.city, r.lo, r.hi, parityChoice.value)
  }
  if (ranges.length > 1) {
    flash(`Swept the walk: ${ranges.map((r) => `${r.street_name} ${r.lo}–${r.hi}`).join(' + ')}.`)
  }
}

/** The already-drafted door geometrically closest to `a` — what a held door
 * connects onto. Null when the draft is still empty. */
function nearestDraftDoor(a: AddressLite): AddressLite | null {
  if (a.lat == null || a.lng == null) return null
  let best: AddressLite | null = null
  let bestD = Infinity
  for (const id of draftMemberIds.value) {
    const d = addressById.get(id)
    if (!d || d.lat == null || d.lng == null || d.id === a.id) continue
    const dist = metersBetween(a.lat, a.lng, d.lat, d.lng)
    if (dist < bestD) {
      bestD = dist
      best = d
    }
  }
  return best
}

/** Holding a pin (~half a second) is contextual, same as the two-tap sweep:
 * a door already in the turf comes back OUT; a fresh door goes IN, walked in
 * from whichever drafted door sits closest so it joins the turf connected
 * rather than floating as an isolated single-door island. */
async function onPinHold(addressId: string) {
  const a = addressById.get(addressId)
  if (!a || sweepBusy.value) return
  anchor.value = null
  const name = streetNameOf(a.street)
  const n = houseNumber(a.street)
  snapshotDraft()
  if (draftMemberIds.value.has(addressId)) {
    await subtractRange(name, a.city, n, n)
    flash(`Removed ${a.street} from the turf.`)
  } else {
    const nearest = nearestDraftDoor(a)
    if (nearest) {
      const ranges = walkRanges(nearest, a, addressById.values())
      for (const r of ranges) await addSegment(r.street_name, r.city, r.lo, r.hi, 'both')
      flash(`Connected ${a.street} to the turf.`)
    } else {
      await addSegment(name, a.city, n, n, 'both')
      flash(`Added just ${a.street}.`)
    }
  }
  restyleAll()
}

/** Long-press detection on a pin's DOM content (AdvancedMarker has no native
 * hold event). Movement past a thumb-jitter threshold cancels, so panning
 * the map over a pin never fires it. */
function attachHoldGesture(el: HTMLElement, addressId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let startX = 0
  let startY = 0
  const cancel = () => clearTimeout(timer)
  el.addEventListener('pointerdown', (e) => {
    startX = e.clientX
    startY = e.clientY
    clearTimeout(timer)
    timer = setTimeout(() => {
      suppressTapId = addressId
      // If the browser swallows the follow-up click, don't leave the pin
      // permanently deaf to its next real tap.
      setTimeout(() => {
        if (suppressTapId === addressId) suppressTapId = null
      }, 700)
      void onPinHold(addressId)
    }, 450)
  })
  el.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cancel()
  })
  el.addEventListener('pointerup', cancel)
  el.addEventListener('pointercancel', cancel)
  el.addEventListener('pointerleave', cancel)
}

async function fetchStreetRows(streetName: string, city: string | null): Promise<AddressLite[]> {
  const cacheKey = `${streetName}|${city ?? ''}`
  const cached = streetCache.get(cacheKey)
  if (cached) return cached
  // Suffix match ("%WALNUT ST") like Hunt's locate, then exact-name filter —
  // this pulls EVERY row on the street (geocoded or not), so counts are real.
  const { data } = await supabase
    .from('addresses')
    .select('id, street, unit, city, zip, lat, lng, turf_id')
    .ilike('street', `%${streetName}`)
  let rows = ((data ?? []) as AddressLite[]).filter((r) => streetNameOf(r.street) === streetName)
  if (city) rows = rows.filter((r) => r.city.toUpperCase() === city.toUpperCase())
  streetCache.set(cacheKey, rows)
  return rows
}

function matchesSegment(a: AddressLite, seg: Pick<DraftSegment, 'range_start' | 'range_end' | 'parity'>): boolean {
  const n = houseNumber(a.street)
  if (n < seg.range_start || n > seg.range_end) return false
  return seg.parity === 'both' || (n % 2 === 0) === (seg.parity === 'even')
}

/** (Re)derive a segment's members from its street rows, refresh its
 * highlighter stroke, and repaint pins. */
async function computeSegment(seg: DraftSegment) {
  const rows = await fetchStreetRows(seg.street_name, seg.city)
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

  // Newly-discovered geocoded doors on this street get pins too, so the
  // stroke never floats over empty map.
  for (const a of members) if (!markersByAddress.has(a.id)) upsertMarker(a)

  segPolylines.get(seg.key)?.setMap(null)
  segPolylines.delete(seg.key)
  const located = free.filter((a) => a.lat != null && a.lng != null)
  located.sort((a, b) => houseNumber(a.street) - houseNumber(b.street))
  const path = located.map((a) => ({ lat: a.lat!, lng: a.lng! }))
  if (path.length >= 2 && map) {
    segPolylines.set(
      seg.key,
      new google.maps.Polyline({
        map,
        path,
        strokeColor: draftColor.value,
        strokeOpacity: 0.7,
        strokeWeight: 6,
        clickable: false,
      }),
    )
  }

  // Shaded swath under the stroke — the "color over the area" preview.
  if (draftData) {
    for (const f of draftFeaturesBySeg.get(seg.key) ?? []) draftData.remove(f)
    draftFeaturesBySeg.delete(seg.key)
    const corridor = await corridorFor(
      located.map((a) => ({ lat: a.lat!, lng: a.lng!, street: a.street })),
    )
    if (corridor) {
      const added = draftData.addGeoJson({
        type: 'Feature',
        geometry: corridor.geometry,
        properties: { color: draftColor.value },
      })
      draftFeaturesBySeg.set(seg.key, added)
    }
  }
  restyleAll()
}

function removeDraftShading(segKey: string) {
  if (!draftData) return
  for (const f of draftFeaturesBySeg.get(segKey) ?? []) draftData.remove(f)
  draftFeaturesBySeg.delete(segKey)
}

async function addSegment(
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
    sweepBusy.value = true
    try {
      existing.range_start = Math.min(existing.range_start, lo)
      existing.range_end = Math.max(existing.range_end, hi)
      await computeSegment(existing)
    } finally {
      sweepBusy.value = false
    }
    return
  }
  sweepBusy.value = true
  try {
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
    await computeSegment(seg)
  } finally {
    sweepBusy.value = false
  }
}

function removeSegment(seg: DraftSegment) {
  segments.value = segments.value.filter((s) => s.key !== seg.key)
  segPolylines.get(seg.key)?.setMap(null)
  segPolylines.delete(seg.key)
  removeDraftShading(seg.key)
  if (expandedSegKey.value === seg.key) expandedSegKey.value = null
  restyleAll()
}

/** Take a range OUT of the draft: segments covering it shrink (or split in
 * two around the hole); pieces left with no doors at all just disappear. */
async function subtractRange(streetName: string, city: string | null, lo: number, hi: number) {
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
    const rows = pieces.length ? await fetchStreetRows(seg.street_name, seg.city) : []
    for (const p of pieces) {
      const hasDoors = rows.some((a) => {
        const n = houseNumber(a.street)
        return n >= p.lo && n <= p.hi
      })
      if (hasDoors) await addSegment(seg.street_name, seg.city, p.lo, p.hi, seg.parity)
    }
  }
}

// --- Undo ---
// Every gesture that changes the draft's street list (sweep, erase, street
// toggle, hold, tray ✕, Clear) files a snapshot first; Undo rebuilds the
// draft from the latest one. Range/side tweaks in the pill editor are
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

/** Clear every draft stroke/shade from the map (the segment list itself is
 * the caller's business). */
function wipeDraftDrawing() {
  for (const line of segPolylines.values()) line.setMap(null)
  segPolylines.clear()
  for (const key of [...draftFeaturesBySeg.keys()]) removeDraftShading(key)
}

async function undoDraft() {
  const snap = undoStack.value.pop()
  if (!snap || sweepBusy.value) return
  sweepBusy.value = true
  try {
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
      await computeSegment(seg)
    }
    restyleAll()
  } finally {
    sweepBusy.value = false
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
  anchor.value = null
  saveError.value = ''
  defaultDraftParent()
  restyleAll()
  buildSavedAreas()
}

async function onSegmentRangeChange(seg: DraftSegment) {
  if (seg.range_end < seg.range_start) {
    ;[seg.range_start, seg.range_end] = [seg.range_end, seg.range_start]
  }
  await computeSegment(seg)
}

async function onSegmentParityChange(seg: DraftSegment, parity: string) {
  seg.parity = parity as TurfParity
  await computeSegment(seg)
}

function clearDraft() {
  segments.value = []
  wipeDraftDrawing()
  expandedSegKey.value = null
  anchor.value = null
  editingTurfId.value = null
  draftName.value = ''
  assignChoice.value = 'none'
  saveError.value = ''
  defaultDraftParent()
  restyleAll()
  // Restore the saved shading of whatever turf was being edited.
  buildSavedAreas()
}

// A different parent = a different claim pool: recompute every sweep so door
// counts and shading track the pick.
watch(draftParentId, async () => {
  for (const seg of segments.value) await computeSegment(seg)
})

// --- Street toggling: double-click/tap anywhere on the map snaps to the
// closest pinned door and toggles that door's ENTIRE street in or out of the
// draft. That makes multi-street turf painting fast: double-tap street after
// street to add them, double-tap an added street again to drop it. The
// two-tap anchor sweep above stays for partial-street ranges. ---

/** Farthest a double-tap can be from any pinned door and still count —
 * beyond this the tap was probably a stray zoom attempt, not a selection. */
const SNAP_RADIUS_M = 300

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(s))
}

function nearestDoor(lat: number, lng: number): { door: AddressLite; meters: number } | null {
  let best: AddressLite | null = null
  let bestD = Infinity
  for (const a of addressById.values()) {
    if (a.lat == null || a.lng == null) continue
    const d = metersBetween(lat, lng, a.lat, a.lng)
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best ? { door: best, meters: bestD } : null
}

/** Draft segments already covering this street (in the same city, when known).
 * Both the map double-tap toggle and the search-result add consult this so a
 * street can never land in the draft twice. */
function matchingSegments(streetName: string, city: string | null) {
  return segments.value.filter(
    (s) =>
      s.street_name === streetName &&
      (!s.city || !city || s.city.toUpperCase() === city.toUpperCase()),
  )
}

async function onMapDoubleClick(latLng: google.maps.LatLng) {
  if (sweepBusy.value) return
  const hit = nearestDoor(latLng.lat(), latLng.lng())
  if (!hit || hit.meters > SNAP_RADIUS_M) {
    flash('No mapped door near that spot — try closer to a street with pins, or search below.')
    return
  }
  anchor.value = null
  const name = streetNameOf(hit.door.street)
  const already = matchingSegments(name, hit.door.city)
  if (already.length) {
    snapshotDraft()
    for (const s of already) removeSegment(s)
    flash(`Removed ${name} from the draft.`)
    return
  }
  await sweepWholeStreet(name, hit.door.city)
}

/** Add an entire street (its full house-number span) as one draft segment,
 * then pin down its unmapped doors. Both the double-tap toggle and the
 * street search land here. Guards against adding a street that's already in
 * the draft — the map path pre-checks, but rapid search-result taps would
 * otherwise stack duplicate segments. */
async function sweepWholeStreet(streetName: string, city: string | null, zoomTo = false) {
  // Bail if another sweep is mid-flight: a second rapid tap would otherwise
  // clear the duplicate check below before the first one's addSegment lands.
  if (sweepBusy.value) return
  if (matchingSegments(streetName, city).length) {
    flash(`${streetName} is already in the draft — double-tap it on the map to remove it.`)
    if (zoomTo) await materializeStreetPins(streetName, city, true)
    return
  }
  let rows: AddressLite[]
  // Hold the busy flag across the door fetch — addSegment only raises it once
  // it starts, leaving the fetch window open to concurrent taps otherwise.
  sweepBusy.value = true
  try {
    rows = await fetchStreetRows(streetName, city)
  } finally {
    sweepBusy.value = false
  }
  if (!rows.length) {
    flash(`No doors found on ${streetName}.`)
    return
  }
  const nums = rows.map((r) => houseNumber(r.street))
  snapshotDraft()
  await addSegment(streetName, city, Math.min(...nums), Math.max(...nums), parityChoice.value)
  flash(`Added ${streetName} — ${rows.length} doors. Double-tap it again to remove it.`)
  await materializeStreetPins(streetName, city, zoomTo)
}

/** Streets pulled in by search (or a double-tap near a sparsely-pinned
 * street) can hold doors that were never geocoded, so the sweep would float
 * over empty map. Geocode a capped batch of them, drop their pins, refresh
 * the segment's stroke, and optionally zoom the map to the street. */
const GEOCODE_BATCH_CAP = 25

async function materializeStreetPins(streetName: string, city: string | null, zoomTo: boolean) {
  const rows = await fetchStreetRows(streetName, city)
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
    const loc = await geocodeAndCache(a)
    if (loc) {
      a.lat = loc.lat
      a.lng = loc.lng
      upsertMarker(a)
      added++
    }
  }
  if (added) {
    const seg = segments.value.find((s) => s.street_name === streetName && s.city === city)
    if (seg) await computeSegment(seg)
    if (zoomTo) fitToStreet()
  }
}

// --- Street search: the non-map way in. Typing "walnut" lists matching
// streets with their door counts and number spans; tapping one sweeps the
// whole street, zooms the map to it, and pins down its unmapped doors
// (trim the range in the tray afterwards). ---

const streetQuery = ref('')
const streetMatches = ref<{ street_name: string; city: string; count: number; lo: number; hi: number }[]>([])
const streetSearching = ref(false)
let streetTimer: ReturnType<typeof setTimeout> | undefined

function onStreetInput(value: string) {
  streetQuery.value = value
  clearTimeout(streetTimer)
  const q = value.trim()
  if (q.length < 2) {
    streetMatches.value = []
    streetSearching.value = false
    return
  }
  streetSearching.value = true
  streetTimer = setTimeout(async () => {
    const { data } = await supabase
      .from('addresses')
      .select('street, city')
      .ilike('street', `%${q}%`)
      .limit(600)
    if (streetQuery.value.trim() !== q) return
    const groups = new Map<string, { street_name: string; city: string; count: number; lo: number; hi: number }>()
    for (const r of (data ?? []) as { street: string; city: string }[]) {
      const name = streetNameOf(r.street)
      if (!name) continue
      const key = `${name}|${r.city.toUpperCase()}`
      const n = houseNumber(r.street)
      const g = groups.get(key)
      if (!g) groups.set(key, { street_name: name, city: r.city, count: 1, lo: n, hi: n })
      else {
        g.count++
        g.lo = Math.min(g.lo, n)
        g.hi = Math.max(g.hi, n)
      }
    }
    streetMatches.value = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 8)
    streetSearching.value = false
  }, 250)
}

/** Tapping a search result just SHOWS the street — zooms to it and drops
 * pins for its doors (geocoding a capped batch of unmapped ones) without
 * adding anything to the draft. Sweeping it is the separate, explicit
 * "Entire street" button. */
async function locateStreet(m: { street_name: string; city: string }) {
  mapEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  flash(`Showing ${m.street_name} — pins only. Tap doors to sweep, or use "Entire street".`)
  await materializeStreetPins(m.street_name, m.city, true)
}

async function addWholeStreet(m: { street_name: string; city: string }) {
  streetQuery.value = ''
  streetMatches.value = []
  // Bring the map back on screen — the payoff of picking a search result is
  // watching the street light up, not a new row in the tray below.
  mapEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  await sweepWholeStreet(m.street_name, m.city, true)
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
    // Fill in pins for every door now in this turf, in the background —
    // never blocks the save.
    void geocodeTurfDoors(turfId)
  } catch {
    saveError.value = 'Could not save the turf — try again.'
  } finally {
    saving.value = false
  }
}

async function editTurf(t: TurfWithMeta) {
  clearDraft()
  undoStack.value = []
  editingTurfId.value = t.id
  draftName.value = t.name
  assignChoice.value = assignChoiceOf(t)
  // Hide this turf's saved shading — the draft redraws it live.
  buildSavedAreas()
  for (const s of t.turf_segments) {
    await addSegment(s.street_name, s.city, s.range_start, s.range_end, s.parity)
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
  clusterer?.clearMarkers()
  markersByAddress.clear()
  for (const line of segPolylines.values()) line.setMap(null)
  segPolylines.clear()
  areasLayer?.dispose()
  cityLayer?.dispose()
  draftData?.setMap(null)
  draftFeaturesBySeg.clear()
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
      <!-- Sweep status: every gesture is contextual (touch a drafted door to
           erase, a fresh one to add/extend) — this bar just carries the
           instructions. The side filter lives in its own row below, not
           boxed in with the text. -->
      <div class="sweep-bar" :style="{ '--draft-color': draftColor }">
        <span class="sweep-dot" :class="{ armed: !!anchor }" aria-hidden="true"></span>
        <p class="sweep-hint">{{ hint }}</p>
      </div>
      <div class="parity-toggle" role="group" aria-label="Which side of the street to sweep">
        <button
          v-for="p in (['both', 'even', 'odd'] as const)"
          :key="p"
          class="parity-btn"
          :class="{ active: parityChoice === p }"
          @click="parityChoice = p"
        >
          {{ p === 'both' ? 'Both' : p === 'even' ? 'Even' : 'Odd' }}
        </button>
      </div>

      <div class="map-wrap">
        <div ref="mapEl" class="map"></div>
        <div v-if="pinsLoading" class="pins-loading" role="status" aria-live="polite">
          <span class="pins-loading-spinner" aria-hidden="true"></span>
          Loading pins…
        </div>
        <!-- Flip every pin between a colored dot and its house number, same
             toggle as Hunt. Sits top-left, above the layer toggle. -->
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
      </div>
      <p v-if="loadError" class="muted map-error">{{ loadError }}</p>
      <p v-if="mapsAuthError" class="muted map-error">
        Google rejected the Maps API key — usually quota, billing, or a referrer restriction on
        the key. The exact reason is logged in the browser console.
      </p>

      <!-- Non-map entry point: find a street by name. Tapping a match shows
           its pins; "Entire street" is the explicit add-to-draft action. -->
      <input
        :value="streetQuery"
        class="street-search"
        type="search"
        placeholder="…or search a street to see its doors"
        aria-label="Search streets"
        @input="onStreetInput(($event.target as HTMLInputElement).value)"
      />
      <div v-if="streetSearching" class="muted search-note">Searching…</div>
      <div v-else-if="streetMatches.length" class="street-matches">
        <div v-for="m in streetMatches" :key="m.street_name + m.city" class="street-match">
          <button class="street-match-main" @click="locateStreet(m)">
            <span class="street-match-name">{{ m.street_name }}</span>
            <span class="muted">{{ m.city }} · {{ m.count }} doors · {{ m.lo }}–{{ m.hi }}</span>
          </button>
          <button class="btn btn-sm btn-primary street-match-add" @click="addWholeStreet(m)">
            Entire street
          </button>
        </div>
      </div>

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
            <p v-if="expandedSeg.takenCount" class="muted seg-taken">
              {{ expandedSeg.takenCount }} of these doors already belong to another turf and stay there.
            </p>
          </div>
        </template>
        <p v-else class="muted empty-note">
          Nothing swept yet — tap two doors to take the walk between them, double-tap a street to
          take it whole, hold a single door, or search below.
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
            <button v-if="canUndo" class="btn btn-ghost" :disabled="saving || sweepBusy" @click="undoDraft">
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

      <!-- Existing turfs -->
      <div class="card">
        <h3>{{ isSubcutter ? 'Your turf' : 'Turfs' }}</h3>
        <p v-if="!listTurfs.length" class="muted empty-note">
          {{
            isSubcutter
              ? 'Nothing here yet — turf your campaign manager assigns to you shows up here.'
              : 'No turf cut yet. Squads without turf just pick their own streets.'
          }}
        </p>
        <div v-else class="turf-list">
          <div v-for="t in listTurfs" :key="t.id" class="turf-row" :class="{ 'turf-row-sub': t.parent_turf_id }">
            <div class="turf-row-top">
              <button class="turf-row-main" @click="focusTurf(t.id)">
                <span class="turf-swatch" :style="{ background: t.color }" aria-hidden="true"></span>
                <span class="turf-row-text">
                  <span class="turf-name">
                    {{ t.name }}
                    <span v-if="t.parent_turf_id" class="muted turf-sub-tag">↳ inside {{ parentName(t) }}</span>
                  </span>
                  <span class="muted turf-segments">
                    {{ t.turf_segments.map(segmentLabel).join(' · ') || 'No street ranges' }}
                  </span>
                  <span v-if="staleDispatchLabel(t)" class="turf-stale">
                    ⚠ {{ staleDispatchLabel(t) }}
                  </span>
                  <span v-if="crewHistory(t)" class="muted turf-history">
                    Crews: {{ crewHistory(t) }}
                  </span>
                </span>
              </button>
              <div v-if="canManage(t)" class="turf-row-actions">
                <button class="btn btn-ghost btn-sm" @click="editTurf(t)">Edit</button>
                <button class="btn btn-ghost btn-sm turf-delete" @click="deleteTurf(t)">Delete</button>
              </div>
            </div>
            <AppSelect
              v-if="canManage(t)"
              class="turf-row-assign"
              small
              :options="assignOptionsFor(t)"
              :model-value="assignChoiceOf(t)"
              :aria-label="`Reassign ${t.name}`"
              @update:model-value="reassignTurf(t, $event)"
            />
          </div>
        </div>
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

.sweep-dot.armed {
  animation: turf-anchor-pulse 1.1s ease-in-out infinite;
}

.sweep-hint {
  margin: 0;
  flex: 1;
  font-size: 0.88rem;
}

.parity-toggle {
  display: flex;
  /* Sits below the sweep-bar box now, not inside it — size to its content
   * rather than stretching the full row width (the default for a column
   * flex child). */
  align-self: flex-start;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.parity-btn {
  min-height: 36px;
  padding: 0 0.6rem;
  border: none;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.parity-btn + .parity-btn {
  border-left: 1px solid var(--border);
}

.parity-btn.active {
  background: var(--accent);
  color: #fff;
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
}

/* Pin style toggle, top-left on the map — same chrome/position as Hunt's. */
.pin-mode-toggle {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
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
  font-size: 0.7rem;
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

/* Segmented layers control, stacked under the pin-style toggle. */
.layer-toggle {
  position: absolute;
  top: calc(0.6rem + 36px + 0.5rem);
  left: 0.6rem;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
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

.search-note {
  font-size: 0.88rem;
}

.street-matches {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

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

/* --- Turf list --- */

.turf-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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

/* Sub-turfs tuck under their parent in the list. */
.turf-row-sub {
  margin-left: 1.1rem;
  border-left: 3px solid var(--border);
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

<!-- Unscoped: marker content divs live in Google's map DOM, outside this
     component's subtree, so the anchor pulse keyframes must be global. -->
<style>
@keyframes turf-anchor-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.25);
  }
}
</style>
