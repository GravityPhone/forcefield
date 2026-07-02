import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import { submitKnock } from '@/lib/knockQueue'
import { useAuthStore } from './auth'
import type { Address, KnockLog, KnockOutcome, NewKnock, Person } from '@/types'

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
  pendingOutcome: KnockOutcome | null
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
      this.activeTab = 'talk'
      this.clearSearch()
    },

    /** Tap a roster row to pick who you're actually talking to (tap again to
     * deselect — the outcome then applies to the household). */
    selectPerson(person: Person) {
      this.selectedPerson = this.selectedPerson?.id === person.id ? null : person
    },

    clearAddress() {
      this.selectedAddress = null
      this.roster = []
      this.history = []
      this.selectedPerson = null
      this.pendingOutcome = null
    },

    /** Log an outcome. Works with nothing selected (anonymous walk-up: both
     * person and household null; a caught name goes in the notes field). */
    async logOutcome(outcome: KnockOutcome) {
      const auth = useAuthStore()
      if (!auth.profile || this.pendingOutcome) return
      const knock: NewKnock = {
        client_id: crypto.randomUUID(),
        person_id: this.selectedPerson?.id ?? null,
        household_id: this.selectedAddress?.id ?? null,
        canvasser_id: auth.profile.id,
        occurred_at: new Date().toISOString(),
        outcome,
        notes: this.notes.trim() || null,
      }
      this.pendingOutcome = outcome
      await submitKnock(knock)
      // Optimistic: show the fresh knock in this household's history.
      if (knock.household_id) {
        this.history.unshift({ ...knock, id: knock.client_id, created_at: knock.occurred_at })
      }
    },

    /** Canvasser confirms before the screen clears — no silent auto-advance.
     * Keeps the address + roster loaded: door conversations often involve
     * several residents; switching houses happens via search or Hunt. */
    confirmNext() {
      this.pendingOutcome = null
      this.selectedPerson = null
      this.notes = ''
    },
  },
})
