import { defineStore } from 'pinia'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { localToday } from '@/lib/day'
import { useAuthStore } from './auth'
import type { ChatProfile, Squad } from '@/types'

/** Squad row enriched with its roster, for the Squads page. */
export interface SquadListItem extends Squad {
  members: ChatProfile[]
  isMember: boolean
}

interface SquadsState {
  squads: SquadListItem[]
  loading: boolean
  actionError: string
}

let rosterChannel: RealtimeChannel | null = null

export const useSquadsStore = defineStore('squads', {
  state: (): SquadsState => ({
    squads: [],
    loading: false,
    actionError: '',
  }),

  getters: {
    myId(): string | null {
      return useAuthStore().profile?.id ?? null
    },
    mySquads(state): SquadListItem[] {
      return state.squads.filter((s) => s.isMember)
    },
  },

  actions: {
    /** Today's squads only — yesterday's crews expired at midnight by
     * definition (squad_date filter), no cleanup job needed. */
    async loadToday() {
      this.loading = true
      const { data, error } = await supabase
        .from('squads')
        .select(
          '*, squad_members(user_id, profiles!squad_members_user_id_fkey(id, username, display_name, avatar, color))',
        )
        .eq('squad_date', localToday())
        .order('created_at')
      this.loading = false
      if (error || !data) return

      type Row = Squad & { squad_members: { user_id: string; profiles: ChatProfile | null }[] }
      this.squads = (data as Row[]).map((row) => {
        const members = row.squad_members
          .map((m) => m.profiles)
          .filter((p): p is ChatProfile => p !== null)
        return {
          id: row.id,
          name: row.name,
          chat_id: row.chat_id,
          created_by: row.created_by,
          squad_date: row.squad_date,
          created_at: row.created_at,
          members,
          isMember: members.some((m) => m.id === this.myId),
        }
      })
    },

    /** Create a squad for today — the RPC also creates its squad chat and
     * seeds both rosters, so the crew lands in a shared room immediately.
     * Returns the new squad (with roster) or null on failure. */
    async createSquad(name: string, memberIds: string[]): Promise<SquadListItem | null> {
      this.actionError = ''
      const { data, error } = await supabase.rpc('create_squad', {
        squad_name: name,
        member_ids: memberIds,
        squad_day: localToday(),
      })
      if (error || !data) {
        this.actionError = 'Could not create the squad — try again.'
        return null
      }
      await this.loadToday()
      return this.squads.find((s) => s.id === data) ?? null
    },

    /** Join puts you in the squad AND its chat (one RPC keeps them in sync). */
    async joinSquad(squadId: string) {
      this.actionError = ''
      const { error } = await supabase.rpc('join_squad', { target_squad_id: squadId })
      if (error) this.actionError = 'Could not join that squad — try again.'
      await this.loadToday()
    },

    async leaveSquad(squadId: string) {
      this.actionError = ''
      const { error } = await supabase.rpc('leave_squad', { target_squad_id: squadId })
      if (error) this.actionError = 'Could not leave that squad — try again.'
      await this.loadToday()
    },

    /** Rosters shift all day as people join up — keep the page live. */
    subscribeToRosters() {
      this.unsubscribeFromRosters()
      rosterChannel = supabase
        .channel('squad-rosters')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'squad_members' },
          () => void this.loadToday(),
        )
        .subscribe()
    },

    unsubscribeFromRosters() {
      if (rosterChannel) {
        void supabase.removeChannel(rosterChannel)
        rosterChannel = null
      }
    },
  },
})
