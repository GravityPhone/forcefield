import { defineStore } from 'pinia'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from './auth'
import type { Chat, ChatKind, ChatMessage, ChatProfile } from '@/types'

/** Chat row enriched with what the list pane needs. */
export interface ChatListItem extends Chat {
  members: ChatProfile[]
  isMember: boolean
}

interface ChatState {
  chats: ChatListItem[]
  loadingChats: boolean
  activeChatId: string | null
  messages: ChatMessage[]
  loadingMessages: boolean
  /** Usernames for message senders — filled from memberships and topped up
   * on demand (global chat can have senders we haven't seen yet). */
  profiles: Record<string, ChatProfile>
  sendError: string
}

const MESSAGE_PAGE = 100
let channel: RealtimeChannel | null = null

/** Supabase's autoRefreshToken can be mid-rotation when a write fires right
 * after navigating to a new tab/view — the request goes out on a
 * stale/expired token and RLS checks like `created_by = auth.uid()` fail
 * with a 403 even though the write is legitimate. getSession() resolves
 * once any in-flight refresh settles, so awaiting it before a write closes
 * that race. Cheap: it's a local read, not a network round trip, once the
 * session is already fresh. */
async function ensureFreshSession() {
  await supabase.auth.getSession()
}

export const useChatStore = defineStore('chat', {
  state: (): ChatState => ({
    chats: [],
    loadingChats: false,
    activeChatId: null,
    messages: [],
    loadingMessages: false,
    profiles: {},
    sendError: '',
  }),

  getters: {
    activeChat(state): ChatListItem | null {
      return state.chats.find((c) => c.id === state.activeChatId) ?? null
    },
    myId(): string | null {
      return useAuthStore().profile?.id ?? null
    },
  },

  actions: {
    /** Display title for a chat: squads/global use their name; DMs list the
     * other members' names. */
    chatTitle(chat: ChatListItem): string {
      if (chat.name) return chat.name
      const others = chat.members.filter((m) => m.id !== this.myId)
      if (!others.length) return 'Just you'
      return others.map((m) => m.display_name || m.username).join(', ')
    },

    async loadChats() {
      this.loadingChats = true
      // chat_members has two FKs to profiles (user_id, added_by) — the embed
      // must name the user_id one explicitly or PostgREST rejects it.
      const { data, error } = await supabase
        .from('chats')
        .select(
          '*, chat_members(user_id, profiles!chat_members_user_id_fkey(id, username, display_name))',
        )
        .order('created_at')
      this.loadingChats = false
      if (error || !data) return

      type Row = Chat & { chat_members: { user_id: string; profiles: ChatProfile | null }[] }
      this.chats = (data as Row[]).map((row) => {
        const members = row.chat_members
          .map((m) => m.profiles)
          .filter((p): p is ChatProfile => p !== null)
        for (const p of members) this.profiles[p.id] = p
        return {
          id: row.id,
          kind: row.kind,
          name: row.name,
          created_by: row.created_by,
          created_at: row.created_at,
          members,
          isMember: row.kind === 'global' || members.some((m) => m.id === this.myId),
        }
      })
      // Global room first, then squads, then PMs.
      const rank: Record<ChatKind, number> = { global: 0, squad: 1, dm: 2 }
      this.chats.sort((a, b) => rank[a.kind] - rank[b.kind] || a.created_at.localeCompare(b.created_at))
    },

    async openChat(chatId: string) {
      this.activeChatId = chatId
      this.messages = []
      this.sendError = ''
      this.loadingMessages = true

      const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE)
      this.loadingMessages = false
      if (this.activeChatId !== chatId) return // switched away mid-fetch
      if (!error && data) {
        this.messages = (data as ChatMessage[]).reverse()
        await this.ensureSenderProfiles(this.messages)
      }
      this.subscribe(chatId)
    },

    closeChat() {
      this.activeChatId = null
      this.messages = []
      this.unsubscribe()
    },

    subscribe(chatId: string) {
      this.unsubscribe()
      channel = supabase
        .channel(`chat-${chatId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `chat_id=eq.${chatId}` },
          (payload) => {
            const msg = payload.new as ChatMessage
            if (this.activeChatId !== msg.chat_id) return
            if (this.messages.some((m) => m.id === msg.id)) return // we sent it
            this.messages.push(msg)
            void this.ensureSenderProfiles([msg])
          },
        )
        .subscribe()
    },

    unsubscribe() {
      if (channel) {
        void supabase.removeChannel(channel)
        channel = null
      }
    },

    async ensureSenderProfiles(messages: ChatMessage[]) {
      const missing = [...new Set(messages.map((m) => m.sender_id))].filter(
        (id) => !this.profiles[id],
      )
      if (!missing.length) return
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .in('id', missing)
      for (const p of (data ?? []) as ChatProfile[]) this.profiles[p.id] = p
    },

    async sendMessage(body: string) {
      const auth = useAuthStore()
      const chatId = this.activeChatId
      const text = body.trim()
      if (!auth.profile || !chatId || !text) return
      this.sendError = ''
      await ensureFreshSession()
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        chat_id: chatId,
        sender_id: auth.profile.id,
        body: text,
        created_at: new Date().toISOString(),
      }
      this.messages.push(message) // optimistic; realtime echo is deduped by id
      const { error } = await supabase.from('chat_messages').insert(message)
      if (error) {
        this.messages = this.messages.filter((m) => m.id !== message.id)
        this.sendError = 'Message failed to send — check your connection.'
      }
    },

    /** Create a squad (named, open) or PM (unnamed, invite-only) and open it. */
    async createChat(kind: 'squad' | 'dm', name: string | null, memberIds: string[]) {
      const auth = useAuthStore()
      if (!auth.profile) return
      await ensureFreshSession()

      // Starting a PM with the same people twice reuses the existing thread.
      if (kind === 'dm') {
        const targetSet = [...new Set([auth.profile.id, ...memberIds])].sort().join('|')
        const existing = this.chats.find(
          (c) => c.kind === 'dm' && c.members.map((m) => m.id).sort().join('|') === targetSet,
        )
        if (existing) {
          await this.openChat(existing.id)
          return
        }
      }

      const { data: chat, error } = await supabase
        .from('chats')
        .insert({ kind, name: kind === 'squad' ? name : null, created_by: auth.profile.id })
        .select('*')
        .single()
      if (error || !chat) {
        this.sendError = 'Could not start that chat — try again.'
        return
      }

      const rows = [...new Set([auth.profile.id, ...memberIds])].map((userId) => ({
        chat_id: chat.id,
        user_id: userId,
        added_by: auth.profile!.id,
      }))
      await supabase.from('chat_members').insert(rows)

      await this.loadChats()
      await this.openChat(chat.id)
    },

    async joinSquad(chatId: string) {
      const auth = useAuthStore()
      if (!auth.profile) return
      await ensureFreshSession()
      await supabase
        .from('chat_members')
        .insert({ chat_id: chatId, user_id: auth.profile.id, added_by: auth.profile.id })
      await this.loadChats()
    },

    async addMembers(chatId: string, memberIds: string[]) {
      const auth = useAuthStore()
      if (!auth.profile || !memberIds.length) return
      await ensureFreshSession()
      const rows = memberIds.map((userId) => ({
        chat_id: chatId,
        user_id: userId,
        added_by: auth.profile!.id,
      }))
      await supabase.from('chat_members').insert(rows)
      await this.loadChats()
    },

    /** Search app users for the member pickers (excludes yourself). */
    async searchUsers(query: string): Promise<ChatProfile[]> {
      const q = query.trim()
      if (q.length < 1) return []
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .neq('id', this.myId ?? '')
        .limit(10)
      return (data ?? []) as ChatProfile[]
    },
  },
})
