import { defineStore } from 'pinia'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { localToday } from '@/lib/day'
import { embeddedPhone } from '@/lib/phone'
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
          '*, squad_members(user_id, profiles!squad_members_user_id_fkey(id, username, display_name, avatar, color, role, member_phones(phone)))',
        )
        .eq('squad_date', localToday())
        .order('created_at')
      this.loading = false
      if (error || !data) return

      type Row = Squad & {
        squad_members: { user_id: string; profiles: (ChatProfile & { member_phones?: unknown }) | null }[]
      }
      this.squads = (data as Row[]).map((row) => {
        const members = row.squad_members
          .map((m): ChatProfile | null => {
            if (!m.profiles) return null
            const { member_phones, ...p } = m.profiles
            return { ...p, phone: embeddedPhone(member_phones) }
          })
          .filter((p): p is ChatProfile => p !== null)
        return {
          id: row.id,
          name: row.name,
          chat_id: row.chat_id,
          created_by: row.created_by,
          squad_date: row.squad_date,
          created_at: row.created_at,
          member_claim: row.member_claim ?? false,
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
        this.actionError = 'Could not create the squad. Try again.'
        return null
      }
      await this.loadToday()
      return this.squads.find((s) => s.id === data) ?? null
    },

    /** Put somebody ELSE on the crew — squad roster and squad chat together,
     * the way joining does for yourself (2026-07-25). The RPC is the gate:
     * managers dispatch anyone (moving them off another crew if that's where
     * they are), a squad leader or the crew's creator adds people who aren't
     * out with anyone else today. Returns the reason it didn't work, or null
     * — callers add several at a time and report per person. */
    async addMember(squadId: string, userId: string): Promise<string | null> {
      const { error } = await supabase.rpc('add_squad_member', {
        target_squad_id: squadId,
        member_id: userId,
      })
      return error ? error.message || 'Could not add them to the squad.' : null
    },

    /** The "edit" half of squad management (2026-07-28): a new name for the
     * crew, and the squad chat's room follows it. The RPC is the gate —
     * managers, squad leaders, or whoever started the crew. */
    async renameSquad(squadId: string, name: string): Promise<string | null> {
      const { error } = await supabase.rpc('rename_squad', {
        target_squad_id: squadId,
        new_name: name,
      })
      if (error) return error.message || 'Could not rename the squad.'
      await this.loadToday()
      return null
    },

    /** The undo for the above — off the roster and out of the squad chat. */
    async removeMember(squadId: string, userId: string): Promise<string | null> {
      const { error } = await supabase.rpc('remove_squad_member', {
        target_squad_id: squadId,
        member_id: userId,
      })
      if (error) return error.message || 'Could not take them off the squad.'
      await this.loadToday()
      return null
    },

    /** Join puts you in the squad AND its chat (one RPC keeps them in sync). */
    async joinSquad(squadId: string) {
      this.actionError = ''
      const { error } = await supabase.rpc('join_squad', { target_squad_id: squadId })
      if (error) this.actionError = 'Could not join that squad. Try again.'
      await this.loadToday()
    },

    /** Squad leader's day-scoped call: let the crew claim their own doors, or
     * take the dividing back. The RPC is the gate (leader / manager / the
     * person who started the crew) — the optimistic local flip is only so the
     * switch answers instantly; a failure puts it back. */
    async setMemberClaim(squadId: string, allow: boolean): Promise<boolean> {
      this.actionError = ''
      const squad = this.squads.find((s) => s.id === squadId)
      const before = squad?.member_claim ?? false
      if (squad) squad.member_claim = allow
      const { error } = await supabase.rpc('set_squad_member_claim', {
        target_squad_id: squadId,
        allow,
      })
      if (error) {
        if (squad) squad.member_claim = before
        this.actionError = "Couldn't change who can claim doors. Try again."
        return false
      }
      return true
    },

    async leaveSquad(squadId: string) {
      this.actionError = ''
      const { error } = await supabase.rpc('leave_squad', { target_squad_id: squadId })
      if (error) this.actionError = 'Could not leave that squad. Try again.'
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
