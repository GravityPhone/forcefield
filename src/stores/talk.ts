import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import { deleteKnock, submitKnock } from '@/lib/knockQueue'
import { geocodeAndCache } from '@/lib/geocode'
import { findNextOnStreet, type WalkDirection, type WalkParity } from '@/lib/streetWalk'
import { useAuthStore } from './auth'
import type { Address, KnockLog, KnockOutcome, NewKnock, Person } from '@/types'

const WALK_DIRECTION_KEY = 'forcefield.walk_direction'
const WALK_PARITY_KEY = 'forcefield.walk_parity'
const KNOCK_PARTLY_SIGNED_KEY = 'forcefield.knock_partly_signed'

/** Person search hit with its address embedded (null for unlinked walk-ups). */
export interface PersonHit extends Person {
  addresses: Pick<Address, 'street' | 'unit' | 'city'> | null
}

interface TalkState {
  activeTab: 'talk' | 'hunt'
  searchQuery: string
  searchResults: { persons: PersonHit[]; addresses: Address[] }
  searching: boolean
  selectedAddress: Address | null
  roster: Person[]
  history: KnockLog[]
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
}

const SEARCH_DEBOUNCE_MS = 250
let searchTimer: ReturnType<typeof setTimeout> | undefined

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
        supabase
          .from('knock_logs')
          .select('*')
          .eq('household_id', addressId)
          .order('occurred_at', { ascending: false })
          .limit(50),
      ])
      if (addressRes.error || !addressRes.data) return
      this.selectedAddress = addressRes.data as Address
      this.roster = (rosterRes.data ?? []) as Person[]
      this.history = (historyRes.data ?? []) as KnockLog[]
      this.selectedPerson = preselectPersonId
        ? (this.roster.find((p) => p.id === preselectPersonId) ?? null)
        : null
      this.pendingOutcome = null
      this.activeClientId = null
      this.activeTab = 'talk'
      this.clearSearch()

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
      await submitKnock(knock)
      // Optimistic: reflect the (possibly corrected) knock in this
      // household's history, replacing any prior entry for the same log.
      if (knock.household_id) {
        this.history = [
          { ...knock, id: clientId, created_at: knock.occurred_at },
          ...this.history.filter((h) => h.client_id !== clientId),
        ]
      }
    },

    setWalkDirection(direction: WalkDirection) {
      this.walkDirection = direction
      localStorage.setItem(WALK_DIRECTION_KEY, direction)
    },

    setWalkParity(parity: WalkParity) {
      this.walkParity = parity
      localStorage.setItem(WALK_PARITY_KEY, parity)
    },

    setKnockPartlySigned(knock: boolean) {
      this.knockPartlySigned = knock
      localStorage.setItem(KNOCK_PARTLY_SIGNED_KEY, String(knock))
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
  },
})
