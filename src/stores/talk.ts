import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import { deleteKnock, submitKnock } from '@/lib/knockQueue'
import { geocodeAndCache } from '@/lib/geocode'
import {
  findNextOnStreet,
  findUpcomingOnStreet,
  type UpcomingDoor,
  type WalkDirection,
  type WalkParity,
} from '@/lib/streetWalk'
import { useAuthStore } from './auth'
import type { Address, KnockLog, KnockOutcome, NewKnock, Person } from '@/types'

const WALK_DIRECTION_KEY = 'forcefield.walk_direction'
const WALK_PARITY_KEY = 'forcefield.walk_parity'
const KNOCK_PARTLY_SIGNED_KEY = 'forcefield.knock_partly_signed'

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
  selectedPerson: Person | null
  notes: string
  /** Outcome logged for the CURRENT selection (person, or household if no
   * person picked) — editable until the selection changes or Next is tapped.
   * Tapping the same button again undoes it; tapping a different one swaps
   * it; both write through activeClientId so it's the same DB row. */
  pendingOutcome: KnockOutcome | null
  activeClientId: string | null
  /** Which way Next auto-advances on the current street — a per-device
   * preference (set from Hunt mode) mimicking how canvassers actually walk:
   * house numbers ascending/descending, one side of the street or both. */
  walkDirection: WalkDirection
  walkParity: WalkParity
  /** Whether Next stops at doors where someone signed but other residents
   * haven't yet — some pushes chase every signature in a household, others
   * treat one signature as door-done. Per-device, like the walk prefs. */
  knockPartlySigned: boolean
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
    selectedPerson: null,
    notes: '',
    pendingOutcome: null,
    activeClientId: null,
    walkDirection: (localStorage.getItem(WALK_DIRECTION_KEY) as WalkDirection) || 'ascending',
    walkParity: (localStorage.getItem(WALK_PARITY_KEY) as WalkParity) || 'both',
    knockPartlySigned: localStorage.getItem(KNOCK_PARTLY_SIGNED_KEY) !== 'false',
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
      const [addressRes, rosterRes, historyRes] = await Promise.all([
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
      ])
      if (addressRes.error || !addressRes.data) return
      this.selectedAddress = addressRes.data as Address
      this.roster = (rosterRes.data ?? []) as Person[]
      this.history = (historyRes.data ?? []) as unknown as KnockHistoryEntry[]
      this.selectedPerson = preselectPersonId
        ? (this.roster.find((p) => p.id === preselectPersonId) ?? null)
        : null
      this.pendingOutcome = null
      this.activeClientId = null
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
    },

    clearAddress() {
      this.selectedAddress = null
      this.roster = []
      this.history = []
      this.selectedPerson = null
      this.pendingOutcome = null
      this.activeClientId = null
      this.upcoming = null
      upcomingSeq++
    },

    /** Recompute the Up-next preview for the current door. Fire-and-forget
     * from loadAddress and the walk-pref setters; a stale lookup (the door
     * or a pref changed while it ran) is dropped on landing. */
    async refreshUpcoming() {
      const current = this.selectedAddress
      const seq = ++upcomingSeq
      this.upcoming = null
      if (!current) return
      const list = await findUpcomingOnStreet(
        current,
        this.walkDirection,
        this.walkParity,
        { knockPartlySigned: this.knockPartlySigned },
        4,
      )
      if (seq !== upcomingSeq || this.selectedAddress?.id !== current.id) return
      this.upcoming = list
    },

    /** Log an outcome for whatever is currently selected. Signed / Didn't
     * Sign / Maybe require a person picked from the roster (OUTCOMES[].
     * requiresPerson); Not Home / Skip / Hostile only require the household
     * (selectedAddress) — OutcomeButtons.vue disables each button
     * individually per that rule. Tapping the already-active button undoes
     * it; tapping a different one swaps it in place (same DB row, via
     * activeClientId); tapping with nothing active creates a new log. The
     * button row itself never hides — this only changes which outcome is
     * highlighted. */
    async logOutcome(outcome: KnockOutcome) {
      const auth = useAuthStore()
      if (!auth.profile) return

      if (this.pendingOutcome === outcome && this.activeClientId) {
        const clientId = this.activeClientId
        this.pendingOutcome = null
        this.activeClientId = null
        this.history = this.history.filter((h) => h.client_id !== clientId)
        await deleteKnock(clientId)
        return
      }

      const clientId = this.activeClientId ?? crypto.randomUUID()
      const knock: NewKnock = {
        client_id: clientId,
        person_id: this.selectedPerson?.id ?? null,
        household_id: this.selectedAddress?.id ?? null,
        canvasser_id: auth.profile.id,
        occurred_at: new Date().toISOString(),
        outcome,
        notes: this.notes.trim() || null,
      }
      this.pendingOutcome = outcome
      this.activeClientId = clientId
      // This door is now the newest stop on your knock path (kept distinct —
      // a re-knock moves it back to the front). Deliberately NOT removed on
      // undo: you still physically visited, so Previous may return here.
      if (knock.household_id) {
        const id = knock.household_id
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
      if (knock.household_id) {
        this.history = [
          {
            ...knock,
            id: clientId,
            created_at: knock.occurred_at,
            // The DB stamps these on insert (squad of the day, door's turf) —
            // the optimistic row doesn't know them and nothing here reads them.
            squad_id: null,
            squad_name: null,
            turf_id: null,
            turf_name: null,
            person: this.selectedPerson ? { name: this.selectedPerson.name } : null,
            canvasser: {
              username: auth.profile.username,
              display_name: auth.profile.display_name,
            },
          },
          ...this.history.filter((h) => h.client_id !== clientId),
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
      this.notes = ''

      const current = this.selectedAddress
      if (!current) return
      const next = await findNextOnStreet(current, this.walkDirection, this.walkParity, {
        knockPartlySigned: this.knockPartlySigned,
      })
      if (next) await this.loadAddress(next.id)
    },

    /** Up-next chip tap: jump straight to that door — same slate-clearing
     * as Next (any outcome shown was already written by logOutcome), just
     * to a chosen house instead of the first one. */
    async jumpTo(addressId: string) {
      this.pendingOutcome = null
      this.activeClientId = null
      this.selectedPerson = null
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
      this.notes = ''

      await this.ensureKnockPath()
      const path = this.myKnockPath
      if (!path.length) return
      const idx = this.selectedAddress ? path.indexOf(this.selectedAddress.id) : -1
      const target = path[idx + 1]
      if (target) await this.loadAddress(target)
    },
  },
})
