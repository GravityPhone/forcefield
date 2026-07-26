import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import { deleteKnock, submitKnock } from '@/lib/knockQueue'
import { geocodeAndCache } from '@/lib/geocode'
import {
  findNextOnStreet,
  findUpcomingOnStreet,
  type NextHouseOptions,
  type UpcomingDoor,
  type WalkDirection,
  type WalkParity,
} from '@/lib/streetWalk'
import { fetchMyTurf } from '@/lib/myTurf'
import { appointmentSettings } from '@/lib/appointments'
import { useAuthStore } from './auth'
import type { Address, Appointment, KnockLog, KnockOutcome, NewKnock, Person } from '@/types'

const WALK_DIRECTION_KEY = 'forcefield.walk_direction'
const WALK_PARITY_KEY = 'forcefield.walk_parity'
const KNOCK_PARTLY_SIGNED_KEY = 'forcefield.knock_partly_signed'
const MY_DOORS_ONLY_KEY = 'forcefield.my_doors_only'

/** Person search hit with its address embedded (null for unlinked walk-ups). */
export interface PersonHit extends Person {
  addresses: Pick<Address, 'street' | 'unit' | 'city'> | null
}

/** A knock in a door's history, with who it was about and who logged it
 * embedded — what the Talk screen's history list renders. */
export interface KnockHistoryEntry extends KnockLog {
  person: { name: string } | null
  canvasser: { username: string; display_name: string | null } | null
}

interface TalkState {
  activeTab: 'talk' | 'hunt'
  searchQuery: string
  searchResults: { persons: PersonHit[]; addresses: Address[] }
  searching: boolean
  selectedAddress: Address | null
  roster: Person[]
  history: KnockHistoryEntry[]
  /** Still-to-come appointments at the loaded door, soonest first — someone
   * promised to be back here. Fetched with the door and refreshed after the
   * appointment sheet saves. Empty when the campaign has appointments off,
   * since nobody could have booked one. */
  appointments: Appointment[]
  selectedPerson: Person | null
  notes: string
  /** Outcome logged for the CURRENT selection (person, or household if no
   * person picked) — editable until the selection changes or Next is tapped.
   * Tapping the same button again undoes it; tapping a different one swaps
   * it; both write through activeClientId so it's the same DB row. */
  pendingOutcome: KnockOutcome | null
  activeClientId: string | null
  /** Set when the person signing is registered at a DIFFERENT door than the
   * one loaded — a spouse, an adult kid, a new tenant, or somebody who just
   * happened to answer here. Their signature belongs to their own registered
   * household; carries the label so the door card can say where it went. */
  signerHome: { id: string; label: string } | null
  /** Client id of the second row an away signature writes — the VISIT at the
   * door actually stood at. Tracked so tapping Signed again undoes both. */
  awayVisitClientId: string | null
  /** Which way Next auto-advances on the current street — a per-device
   * preference (set from Hunt mode) mimicking how canvassers actually walk:
   * house numbers ascending/descending, one side of the street or both. */
  walkDirection: WalkDirection
  walkParity: WalkParity
  /** Whether Next stops at doors where someone signed but other residents
   * haven't yet — some pushes chase every signature in a household, others
   * treat one signature as door-done. Per-device, like the walk prefs. */
  knockPartlySigned: boolean
  /** "My doors" switch, sitting next to Next: on, the walk (Next, Back AND
   * the Up-next chips) only ever offers doors on turf that's yours today;
   * off, it offers every door on the street, which is how you wander a block
   * nobody cut and knock what's closest. Per-device, like the walk prefs. */
  myDoorsOnly: boolean
  /** Turf ids that are mine today — the set the switch above filters on.
   * Empty until ensureMyTurf() has run (and legitimately empty when nothing
   * is assigned to me, which is why the switch hides itself then). */
  myTurfIds: Set<string>
  myTurfLoaded: boolean
  /** The next few doors the walk pattern would visit from the current one —
   * the "Up next" chips. null = not computed yet (loading); [] = end of the
   * street. Refreshed on loadAddress and whenever a walk pref changes. */
  upcoming: UpcomingDoor[] | null
  /** Your own knocked doors, distinct, newest knock first — what the
   * Previous button steps back through. Session knocks are prepended as
   * they're logged; the server's last 500 fill in behind on first use. */
  myKnockPath: string[]
  myKnockPathLoaded: boolean
}

/** Still-to-come, not-called-off appointments at one door, soonest first.
 * `ends_at` rather than `starts_at` is the cutoff on purpose: a window you're
 * standing inside is the most relevant appointment there is.
 *
 * Skipped entirely while the campaign has appointments switched off — that's
 * the default, and opening a door is the hottest path in the app; it doesn't
 * pay for a feature nobody turned on. */
async function fetchDoorAppointments(addressId: string): Promise<Appointment[]> {
  if (!appointmentSettings.value.enabled) return []
  const { data } = await supabase
    .from('appointments')
    .select('*')
    .eq('household_id', addressId)
    .eq('status', 'scheduled')
    .gte('ends_at', new Date().toISOString())
    .order('starts_at')
  return (data ?? []) as Appointment[]
}

const SEARCH_DEBOUNCE_MS = 250
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** Invalidates in-flight Up-next lookups when a newer one starts. */
let upcomingSeq = 0

export const useTalkStore = defineStore('talk', {
  state: (): TalkState => ({
    activeTab: 'talk',
    searchQuery: '',
    searchResults: { persons: [], addresses: [] },
    searching: false,
    selectedAddress: null,
    roster: [],
    history: [],
    appointments: [],
    selectedPerson: null,
    notes: '',
    pendingOutcome: null,
    activeClientId: null,
    signerHome: null,
    awayVisitClientId: null,
    walkDirection: (localStorage.getItem(WALK_DIRECTION_KEY) as WalkDirection) || 'ascending',
    walkParity: (localStorage.getItem(WALK_PARITY_KEY) as WalkParity) || 'both',
    knockPartlySigned: localStorage.getItem(KNOCK_PARTLY_SIGNED_KEY) !== 'false',
    // ON by default since 2026-07-25 (user call): staying on your own doors
    // is the normal way to walk, and wandering off them is the exception you
    // reach for. Safe as a default because walkOptions() only actually
    // filters when myTurfIds is non-empty — somebody with no turf still gets
    // the whole street, rather than a Next button that goes nowhere. Only an
    // explicit 'false' turns it off.
    myDoorsOnly: localStorage.getItem(MY_DOORS_ONLY_KEY) !== 'false',
    myTurfIds: new Set(),
    myTurfLoaded: false,
    upcoming: null,
    myKnockPath: [],
    myKnockPathLoaded: false,
  }),

  actions: {
    /** Debounced live search over persons (by name) and addresses (by street). */
    search(query: string) {
      this.searchQuery = query
      clearTimeout(searchTimer)
      const q = query.trim()
      if (q.length < 2) {
        this.searchResults = { persons: [], addresses: [] }
        this.searching = false
        return
      }
      this.searching = true
      searchTimer = setTimeout(async () => {
        const pattern = `%${q}%`
        const [personsRes, addressesRes] = await Promise.all([
          supabase
            .from('persons')
            .select('*, addresses(street, unit, city)')
            .ilike('name', pattern)
            .limit(10),
          supabase.from('addresses').select('*').ilike('street', pattern).limit(10),
        ])
        // A newer keystroke may have superseded this query.
        if (this.searchQuery.trim() !== q) return
        this.searchResults = {
          persons: (personsRes.data ?? []) as PersonHit[],
          addresses: (addressesRes.data ?? []) as Address[],
        }
        this.searching = false
      }, SEARCH_DEBOUNCE_MS)
    },

    clearSearch() {
      clearTimeout(searchTimer)
      this.searchQuery = ''
      this.searchResults = { persons: [], addresses: [] }
      this.searching = false
    },

    /** Load an address + its full roster + prior contact history, and land on
     * the Talk tab. Single entry point for search hits and Hunt taps. */
    async loadAddress(addressId: string, preselectPersonId?: string) {
      const [addressRes, rosterRes, historyRes, apptRes] = await Promise.all([
        supabase.from('addresses').select('*').eq('id', addressId).single(),
        supabase.from('persons').select('*').eq('household_id', addressId).order('name'),
        // The door's ENTIRE visit history, with who each knock was about and
        // who logged it — the Talk screen shows all of it, day and time.
        supabase
          .from('knock_logs')
          .select('*, person:persons(name), canvasser:profiles(username, display_name)')
          .eq('household_id', addressId)
          .order('occurred_at', { ascending: false })
          .limit(500),
        fetchDoorAppointments(addressId),
      ])
      if (addressRes.error || !addressRes.data) return
      this.selectedAddress = addressRes.data as Address
      this.roster = (rosterRes.data ?? []) as Person[]
      this.history = (historyRes.data ?? []) as unknown as KnockHistoryEntry[]
      this.appointments = apptRes
      this.selectedPerson = preselectPersonId
        ? (this.roster.find((p) => p.id === preselectPersonId) ?? null)
        : null
      this.pendingOutcome = null
      this.activeClientId = null
      this.signerHome = null
      this.awayVisitClientId = null
      this.activeTab = 'talk'
      this.clearSearch()
      void this.refreshUpcoming()

      // Geocode on view, not on import: the first time this address is
      // pulled up without coordinates, look it up and cache it so it gets a
      // pin on Hunt from now on. Fire-and-forget — never blocks Talk mode.
      if (this.selectedAddress.lat == null || this.selectedAddress.lng == null) {
        const address = this.selectedAddress
        void geocodeAndCache(address).then((loc) => {
          if (loc && this.selectedAddress?.id === address.id) {
            this.selectedAddress.lat = loc.lat
            this.selectedAddress.lng = loc.lng
          }
        })
      }
    },

    /** Tap a roster row to pick who you're actually talking to (tap again to
     * deselect — the outcome then applies to the household). Switching the
     * target clears any in-progress outcome selection — it belonged to
     * whoever was previously active, not the new target. */
    selectPerson(person: Person) {
      this.selectedPerson = this.selectedPerson?.id === person.id ? null : person
      this.pendingOutcome = null
      this.activeClientId = null
      // A roster pick is by definition registered here.
      this.signerHome = null
      this.awayVisitClientId = null
    },

    /** Pick somebody found in the county roll rather than on this door's
     * roster — the spouse, the adult kid, the new tenant, the neighbour who
     * came over. They're registered somewhere, and where that is decides
     * where their signature lands (see logOutcome). */
    selectRollPerson(hit: PersonHit) {
      if (this.selectedPerson?.id === hit.id) {
        this.selectedPerson = null
        this.signerHome = null
      } else {
        const { addresses, ...person } = hit
        this.selectedPerson = person as Person
        const sameDoor = !hit.household_id || hit.household_id === this.selectedAddress?.id
        this.signerHome = sameDoor
          ? null
          : {
              id: hit.household_id!,
              label: addresses
                ? [addresses.street, addresses.city].filter(Boolean).join(', ')
                : 'their registered address',
            }
      }
      this.pendingOutcome = null
      this.activeClientId = null
      this.awayVisitClientId = null
    },

    /** Re-read the loaded door's appointments — after the sheet books, moves
     * or cancels one. No-op if the door changed underneath. */
    async reloadAppointments() {
      const id = this.selectedAddress?.id
      if (!id) return
      const rows = await fetchDoorAppointments(id)
      if (this.selectedAddress?.id !== id) return
      this.appointments = rows
    },

    clearAddress() {
      this.selectedAddress = null
      this.roster = []
      this.history = []
      this.appointments = []
      this.selectedPerson = null
      this.pendingOutcome = null
      this.activeClientId = null
      this.signerHome = null
      this.awayVisitClientId = null
      this.upcoming = null
      upcomingSeq++
    },

    /** One-time load of which turf is mine today (see lib/myTurf.ts) — what
     * the "My doors" switch filters on. Left un-loaded on failure so the next
     * walk retries rather than silently filtering against an empty set. */
    async ensureMyTurf() {
      if (this.myTurfLoaded) return
      const auth = useAuthStore()
      if (!auth.profile) return
      const { mine } = await fetchMyTurf(auth.profile.id)
      this.myTurfIds = mine
      this.myTurfLoaded = true
    },

    /** Force a re-read of which turf is mine. Claiming doors on the Squad
     * page changes the answer, and /canvass sits inside <keep-alive>, so the
     * one-time load above would otherwise hold yesterday's split until a full
     * page reload (2026-07-25). Called when /canvass is re-activated. */
    async reloadMyTurf() {
      this.myTurfLoaded = false
      await this.ensureMyTurf()
      void this.refreshUpcoming()
    },

    /** The walk options in force right now, including the "My doors" filter
     * when it's on AND there's actually turf to filter to (switching it on
     * with nothing assigned would empty every walk). */
    walkOptions(): NextHouseOptions {
      return {
        knockPartlySigned: this.knockPartlySigned,
        turfIds: this.myDoorsOnly && this.myTurfIds.size ? this.myTurfIds : null,
      }
    },

    /** Recompute the Up-next preview for the current door. Fire-and-forget
     * from loadAddress and the walk-pref setters; a stale lookup (the door
     * or a pref changed while it ran) is dropped on landing. */
    async refreshUpcoming() {
      const current = this.selectedAddress
      const seq = ++upcomingSeq
      this.upcoming = null
      if (!current) return
      await this.ensureMyTurf()
      if (seq !== upcomingSeq || this.selectedAddress?.id !== current.id) return
      const list = await findUpcomingOnStreet(
        current,
        this.walkDirection,
        this.walkParity,
        this.walkOptions(),
        4,
      )
      if (seq !== upcomingSeq || this.selectedAddress?.id !== current.id) return
      this.upcoming = list
    },

    /** Log an outcome for whatever is currently selected. Only Signed needs a
     * person picked from the roster (OUTCOMES[].requiresPerson); every other
     * button logs against the picked person when there is one and against the
     * household when there isn't. Tapping the already-active button undoes
     * it; tapping a different one swaps it in place (same DB row, via
     * activeClientId); tapping with nothing active creates a new log. The
     * button row itself never hides — this only changes which outcome is
     * highlighted. */
    async logOutcome(outcome: KnockOutcome) {
      const auth = useAuthStore()
      if (!auth.profile) return

      if (this.pendingOutcome === outcome && this.activeClientId) {
        const clientId = this.activeClientId
        // An away signature wrote a visit row too — undo takes both, or the
        // door keeps a knock for a signature that no longer exists.
        const visitId = this.awayVisitClientId
        this.pendingOutcome = null
        this.activeClientId = null
        this.awayVisitClientId = null
        this.history = this.history.filter(
          (h) => h.client_id !== clientId && h.client_id !== visitId,
        )
        await deleteKnock(clientId)
        if (visitId) await deleteKnock(visitId)
        return
      }

      const door = this.selectedAddress
      // WHERE A SIGNATURE LANDS: with the signer registered at another door,
      // it belongs to THEIR household — 412 Grove goes green even though you
      // knocked at 88 Oak — because the door-status math counts signatures by
      // the knock's household_id. Every other outcome is about the visit, so
      // it stays at the door you're standing at.
      const away = outcome === 'signed' ? this.signerHome : null

      const clientId = this.activeClientId ?? crypto.randomUUID()
      const occurredAt = new Date().toISOString()
      const knock: NewKnock = {
        client_id: clientId,
        person_id: this.selectedPerson?.id ?? null,
        household_id: away?.id ?? door?.id ?? null,
        canvasser_id: auth.profile.id,
        occurred_at: occurredAt,
        outcome,
        notes: this.notes.trim() || null,
      }
      this.pendingOutcome = outcome
      this.activeClientId = clientId

      // AND THE VISIT STILL RECORDS WHERE YOU STOOD. Without this row the door
      // drops off the day's map and the next canvasser re-knocks it. It's
      // 'maybe' ("Come back another time") because that's the honest state of
      // the door: its own residents still haven't been asked, and 'maybe'
      // keeps it yellow, walkable, and out of CLOSED_OUTCOMES.
      if (away && door) {
        const visitId = this.awayVisitClientId ?? crypto.randomUUID()
        this.awayVisitClientId = visitId
        void submitKnock({
          client_id: visitId,
          person_id: null,
          household_id: door.id,
          canvasser_id: auth.profile.id,
          occurred_at: occurredAt,
          outcome: 'maybe',
          notes: `Signature taken here for ${away.label}`,
        })
      }

      // The door you physically stood at is the newest stop on your knock path
      // — never the away household, which nobody visited. Kept distinct (a
      // re-knock moves it to the front) and deliberately NOT removed on undo:
      // you still went there, so Previous may return.
      if (door) {
        const id = door.id
        this.myKnockPath = [id, ...this.myKnockPath.filter((h) => h !== id)]
      }
      await submitKnock(knock)
      // A same-outcome tap during that await was an undo, a different-outcome
      // tap a swap — either way this submission is stale and must not prepend
      // a ghost entry over the newer state (the roster bubbles and address
      // banner render straight from history[0]).
      if (this.activeClientId !== clientId || this.pendingOutcome !== outcome) return
      // Optimistic: reflect the (possibly corrected) knock in this
      // household's history, replacing any prior entry for the same log.
      // An away signature's row belongs to a DIFFERENT door's history, so what
      // shows here is the visit it left behind — which is what a later reload
      // of this door will fetch anyway.
      const shown: NewKnock | null = away
        ? door
          ? {
              ...knock,
              client_id: this.awayVisitClientId!,
              person_id: null,
              household_id: door.id,
              outcome: 'maybe',
              notes: `Signature taken here for ${away.label}`,
            }
          : null
        : knock
      if (shown?.household_id) {
        const entryClientId = shown.client_id
        this.history = [
          {
            ...shown,
            id: entryClientId,
            created_at: shown.occurred_at,
            // The DB stamps these on insert (squad of the day, door's turf) —
            // the optimistic row doesn't know them and nothing here reads them.
            squad_id: null,
            squad_name: null,
            turf_id: null,
            turf_name: null,
            // The visit row is about the door, not the signer — its person_id
            // is null and its name must be too.
            person:
              shown.person_id && this.selectedPerson
                ? { name: this.selectedPerson.name }
                : null,
            canvasser: {
              username: auth.profile.username,
              display_name: auth.profile.display_name,
            },
          },
          ...this.history.filter((h) => h.client_id !== entryClientId),
        ]
      }
    },

    setWalkDirection(direction: WalkDirection) {
      this.walkDirection = direction
      localStorage.setItem(WALK_DIRECTION_KEY, direction)
      void this.refreshUpcoming()
    },

    setWalkParity(parity: WalkParity) {
      this.walkParity = parity
      localStorage.setItem(WALK_PARITY_KEY, parity)
      void this.refreshUpcoming()
    },

    setKnockPartlySigned(knock: boolean) {
      this.knockPartlySigned = knock
      localStorage.setItem(KNOCK_PARTLY_SIGNED_KEY, String(knock))
      void this.refreshUpcoming()
    },

    setMyDoorsOnly(only: boolean) {
      this.myDoorsOnly = only
      localStorage.setItem(MY_DOORS_ONLY_KEY, String(only))
      void this.refreshUpcoming()
    },

    /** Canvasser confirms before the screen clears. The outcome itself was
     * already written by logOutcome — this just moves on, auto-advancing to
     * the next house on the street per walkDirection/walkParity (falling
     * back to staying put, roster and all, if there's no next house — e.g.
     * end of the street — since door conversations often involve several
     * residents anyway). */
    async confirmNext() {
      this.pendingOutcome = null
      this.activeClientId = null
      this.selectedPerson = null
      this.signerHome = null
      this.awayVisitClientId = null
      this.notes = ''

      const current = this.selectedAddress
      if (!current) return
      await this.ensureMyTurf()
      const next = await findNextOnStreet(
        current,
        this.walkDirection,
        this.walkParity,
        this.walkOptions(),
      )
      if (next) await this.loadAddress(next.id)
    },

    /** Up-next chip tap: jump straight to that door — same slate-clearing
     * as Next (any outcome shown was already written by logOutcome), just
     * to a chosen house instead of the first one. */
    async jumpTo(addressId: string) {
      this.pendingOutcome = null
      this.activeClientId = null
      this.selectedPerson = null
      this.signerHome = null
      this.awayVisitClientId = null
      this.notes = ''
      await this.loadAddress(addressId)
    },

    /** One-time fetch of your knock history (last 500 logs, deduped to
     * distinct doors, newest first), merged BEHIND whatever this session
     * already prepended — session knocks are newer by construction. Left
     * un-loaded on failure so the next Previous press retries (offline,
     * the session-logged path still works). */
    async ensureKnockPath() {
      if (this.myKnockPathLoaded) return
      const auth = useAuthStore()
      if (!auth.profile) return
      const { data, error } = await supabase
        .from('knock_logs')
        .select('household_id, occurred_at')
        .eq('canvasser_id', auth.profile.id)
        .not('household_id', 'is', null)
        .order('occurred_at', { ascending: false })
        .limit(500)
      if (error || !data) return
      const merged = [...this.myKnockPath]
      const seen = new Set(merged)
      for (const row of data) {
        const id = row.household_id as string
        if (seen.has(id)) continue
        seen.add(id)
        merged.push(id)
      }
      this.myKnockPath = merged
      this.myKnockPathLoaded = true
    },

    /** The Previous button: steps BACK through your own knock history —
     * the doors you've logged, distinct, newest first — not the street
     * walk (that's Next's job). Position is stateless: wherever the
     * current door sits in the path, go one older (a door not on the path
     * at all starts from your most recent knock). Ends by staying put. */
    async confirmPrevious() {
      this.pendingOutcome = null
      this.activeClientId = null
      this.selectedPerson = null
      this.signerHome = null
      this.awayVisitClientId = null
      this.notes = ''

      await this.ensureKnockPath()
      const path = this.myKnockPath
      if (!path.length) return
      const idx = this.selectedAddress ? path.indexOf(this.selectedAddress.id) : -1
      const behind = path.slice(idx + 1)
      if (!behind.length) return
      const target = (await this.firstMyDoor(behind)) ?? null
      if (target) await this.loadAddress(target)
    },

    /** First id in a list that the "My doors" switch allows — the whole list's
     * head when the switch is off. Turf membership isn't on the path (it's
     * just ids), so it takes one small lookup; capped because Back only ever
     * needs the nearest match behind you, not the whole 500-knock history. */
    async firstMyDoor(ids: string[]): Promise<string | undefined> {
      await this.ensureMyTurf()
      const turfIds = this.myDoorsOnly && this.myTurfIds.size ? this.myTurfIds : null
      if (!turfIds) return ids[0]
      const window = ids.slice(0, 60)
      const { data } = await supabase.from('addresses').select('id, turf_id').in('id', window)
      const turfBy = new Map((data ?? []).map((r) => [r.id as string, r.turf_id as string | null]))
      return window.find((id) => {
        const t = turfBy.get(id)
        return !!t && turfIds.has(t)
      })
    },
  },
})
