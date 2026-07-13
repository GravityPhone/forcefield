import { defineStore } from 'pinia'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { embeddedPhone } from '@/lib/phone'
import { useAuthStore } from './auth'
import type { Chat, ChatFile, ChatKind, ChatMessage, ChatProfile, MessageReaction } from '@/types'

/** Chat row enriched with what the list pane needs. */
export interface ChatListItem extends Chat {
  members: ChatProfile[]
  isMember: boolean
}

/** Attachment as emitted by vue-advanced-chat's composer (before upload). */
export interface OutgoingFile {
  name: string
  size: number
  type: string
  extension?: string
  blob?: Blob
  localUrl?: string
}

interface ChatState {
  chats: ChatListItem[]
  loadingChats: boolean
  /** Set when the chat list itself failed to load (e.g. migrations not yet
   * applied) — the drawer shows this instead of a misleading "no chats". */
  chatsError: string
  activeChatId: string | null
  messages: ChatMessage[]
  /** emoji -> user ids, per message id, for the active chat. */
  reactions: Record<string, Record<string, string[]>>
  loadingMessages: boolean
  /** Usernames for message senders — filled from memberships and topped up
   * on demand (global chat can have senders we haven't seen yet). */
  profiles: Record<string, ChatProfile>
  sendError: string
  /** Every user in the org — the global room has no chat_members rows (by
   * design, everyone's implicitly in it), so its member list is this instead. */
  orgMembers: ChatProfile[]
  /** Unread message count per chat id (only chats with unread > 0). */
  unread: Record<string, number>
  /** The slide-in chat drawer, reachable from every screen. */
  drawerOpen: boolean
}

const MESSAGE_PAGE = 100
let messagesChannel: RealtimeChannel | null = null
let reactionsChannel: RealtimeChannel | null = null
let membershipChannel: RealtimeChannel | null = null
let backgroundReady = false

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
    chatsError: '',
    activeChatId: null,
    messages: [],
    reactions: {},
    loadingMessages: false,
    profiles: {},
    sendError: '',
    orgMembers: [],
    unread: {},
    drawerOpen: false,
  }),

  getters: {
    activeChat(state): ChatListItem | null {
      return state.chats.find((c) => c.id === state.activeChatId) ?? null
    },
    myId(): string | null {
      return useAuthStore().profile?.id ?? null
    },
    totalUnread(state): number {
      return Object.values(state.unread).reduce((sum, n) => sum + n, 0)
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

    // --- Drawer ---

    openDrawer(chatId?: string) {
      this.drawerOpen = true
      if (chatId) void this.openChat(chatId)
    },

    closeDrawer() {
      this.drawerOpen = false
    },

    /** One-time background wiring (idempotent — AppShell remounts per view):
     * chat list, unread counts, and the always-on realtime listeners that
     * keep the drawer badge live even when the drawer is closed. */
    async ensureBackground() {
      if (backgroundReady && this.myId) return
      backgroundReady = true
      await this.loadChats()
      void this.loadOrgMembers()
      void this.loadUnreadCounts()
      this.subscribeToMessages()
      this.subscribeToMembership()
    },

    /** Called on logout/login switches so the next user re-wires cleanly. */
    resetBackground() {
      backgroundReady = false
      this.unsubscribeAll()
      this.$reset()
    },

    async loadChats() {
      this.loadingChats = true
      // chat_members has two FKs to profiles (user_id, added_by) — the embed
      // must name the user_id one explicitly or PostgREST rejects it.
      const { data, error } = await supabase
        .from('chats')
        .select(
          '*, chat_members(user_id, profiles!chat_members_user_id_fkey(id, username, display_name, avatar, member_phones(phone)))',
        )
        .order('created_at')
      this.loadingChats = false
      if (error || !data) {
        this.chatsError = error
          ? `Couldn't load chats: ${error.message}`
          : "Couldn't load chats — check your connection."
        return
      }
      this.chatsError = ''

      type Row = Chat & {
        chat_members: { user_id: string; profiles: (ChatProfile & { member_phones?: unknown }) | null }[]
      }
      this.chats = (data as Row[]).map((row) => {
        const members = row.chat_members
          .map((m): ChatProfile | null => {
            if (!m.profiles) return null
            const { member_phones, ...p } = m.profiles
            return { ...p, phone: embeddedPhone(member_phones) }
          })
          .filter((p): p is ChatProfile => p !== null)
        for (const p of members) this.profiles[p.id] = p
        return {
          id: row.id,
          kind: row.kind,
          name: row.name,
          team_id: row.team_id,
          created_by: row.created_by,
          created_at: row.created_at,
          members,
          // Global and team-scoped rooms have no member rows — RLS already
          // scoped them by team/role, so seeing one means you're in it.
          isMember:
            row.kind !== 'squad' && row.kind !== 'dm'
              ? true
              : members.some((m) => m.id === this.myId),
        }
      })
      // Team room first, leadership rooms, squads (today's crews), global, PMs.
      const rank: Record<ChatKind, number> = {
        team: 0,
        team_leads: 1,
        team_managers: 2,
        squad: 3,
        global: 4,
        dm: 5,
      }
      this.chats.sort((a, b) => rank[a.kind] - rank[b.kind] || a.created_at.localeCompare(b.created_at))
    },

    // --- Unread tracking ---

    async loadUnreadCounts() {
      const { data } = await supabase.rpc('get_unread_counts')
      if (!data) return
      const map: Record<string, number> = {}
      for (const row of data as { chat_id: string; unread: number }[]) {
        map[row.chat_id] = Number(row.unread)
      }
      this.unread = map
    },

    /** Stamp the active chat read — local zero for the badge, and a server
     * row via RPC so the timestamp comes from the SERVER clock (a client
     * clock can drift relative to message timestamps).
     *
     * The RPC MUST be awaited: supabase-js builders are lazy thenables that
     * only send the request when awaited/.then()'d — `void supabase.rpc(...)`
     * discards the request unsent, so no read ever reached the server and
     * every reload resurrected the badges. */
    async markRead(chatId: string) {
      if (this.unread[chatId]) delete this.unread[chatId]
      if (!this.myId) return
      await ensureFreshSession()
      const { error } = await supabase.rpc('mark_chat_read', { cid: chatId })
      if (error) console.warn(`mark_chat_read(${chatId}) failed: ${error.message}`)
    },

    async openChat(chatId: string) {
      this.activeChatId = chatId
      this.messages = []
      this.reactions = {}
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
        await this.signMediaFiles(this.messages)
        void this.loadReactions(chatId)
      }
      void this.markRead(chatId)
      this.subscribeToReactions(chatId)
    },

    /** vue-advanced-chat re-emits `fetch-messages` for the room that's
     * already open (its internal `roomsCasted` watcher re-fires whenever the
     * rooms list reference changes, e.g. after a membership refresh) and
     * expects the loading state to be acknowledged again. If we don't toggle
     * `loadingMessages`, our `messages-loaded` prop never changes value, so
     * the library's own watcher for it never fires and its spinner is stuck
     * on forever — most visible in an empty room, where there are no
     * incoming messages to trigger its other clear-path. */
    reaffirmMessagesLoaded() {
      this.loadingMessages = true
      void Promise.resolve().then(() => {
        this.loadingMessages = false
      })
    },

    closeChat() {
      this.activeChatId = null
      this.messages = []
      this.reactions = {}
      if (reactionsChannel) {
        void supabase.removeChannel(reactionsChannel)
        reactionsChannel = null
      }
    },

    // --- Realtime ---

    /** Always-on message stream (RLS scopes it to chats we can see). Feeds
     * both the open room and the unread counters for every other room. */
    subscribeToMessages() {
      if (messagesChannel) void supabase.removeChannel(messagesChannel)
      messagesChannel = supabase
        .channel('chat-messages-all')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages' },
          (payload) => {
            const msg = payload.new as ChatMessage
            if (msg.sender_id === this.myId) return // optimistic copy already shown
            if (msg.chat_id === this.activeChatId && !this.messages.some((m) => m.id === msg.id)) {
              this.messages.push(msg)
              void this.ensureSenderProfiles([msg])
              void this.signMediaFiles([msg])
            }
            // Only an actually-visible room counts as read.
            if (msg.chat_id === this.activeChatId && this.drawerOpen) {
              void this.markRead(msg.chat_id)
            } else {
              this.unread[msg.chat_id] = (this.unread[msg.chat_id] ?? 0) + 1
            }
          },
        )
        .subscribe()
    },

    subscribeToReactions(chatId: string) {
      if (reactionsChannel) void supabase.removeChannel(reactionsChannel)
      reactionsChannel = supabase
        .channel(`chat-reactions-${chatId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'message_reactions', filter: `chat_id=eq.${chatId}` },
          (payload) => this.applyReaction(payload.new as MessageReaction, false),
        )
        .on(
          // DELETE payloads only carry the primary key (no chat_id), so this
          // listener can't be filtered per-room — applyReaction just no-ops
          // for messages that aren't in the open room.
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'message_reactions' },
          (payload) => this.applyReaction(payload.old as MessageReaction, true),
        )
        .subscribe()
    },

    /** Live-refresh the chat list when someone adds you to a new DM/squad —
     * without this, a newly-added chat only appeared after a manual reload. */
    subscribeToMembership() {
      if (membershipChannel) void supabase.removeChannel(membershipChannel)
      const myId = this.myId
      if (!myId) return
      membershipChannel = supabase
        .channel(`chat-membership-${myId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_members', filter: `user_id=eq.${myId}` },
          () => void this.loadChats(),
        )
        .subscribe()
    },

    unsubscribeAll() {
      for (const ch of [messagesChannel, reactionsChannel, membershipChannel]) {
        if (ch) void supabase.removeChannel(ch)
      }
      messagesChannel = reactionsChannel = membershipChannel = null
    },

    // --- Reactions ---

    async loadReactions(chatId: string) {
      const ids = this.messages.map((m) => m.id)
      if (!ids.length) return
      const { data } = await supabase
        .from('message_reactions')
        .select('message_id, chat_id, user_id, emoji')
        .eq('chat_id', chatId)
        .in('message_id', ids)
      if (this.activeChatId !== chatId || !data) return
      this.reactions = {}
      for (const r of data as MessageReaction[]) this.applyReaction(r, false)
    },

    applyReaction(r: MessageReaction, remove: boolean) {
      if (!r.message_id || !this.messages.some((m) => m.id === r.message_id)) return
      const perMessage = (this.reactions[r.message_id] ??= {})
      const users = (perMessage[r.emoji] ??= [])
      if (remove) {
        perMessage[r.emoji] = users.filter((id) => id !== r.user_id)
        if (!perMessage[r.emoji].length) delete perMessage[r.emoji]
      } else if (!users.includes(r.user_id)) {
        users.push(r.user_id)
      }
    },

    async toggleReaction(messageId: string, emoji: string, remove: boolean) {
      const myId = this.myId
      const chatId = this.activeChatId
      if (!myId || !chatId) return
      await ensureFreshSession()
      // Apply locally right away — our own realtime echo is idempotent.
      this.applyReaction({ message_id: messageId, chat_id: chatId, user_id: myId, emoji }, remove)
      if (remove) {
        await supabase
          .from('message_reactions')
          .delete()
          .match({ message_id: messageId, user_id: myId, emoji })
      } else {
        await supabase
          .from('message_reactions')
          .upsert({ message_id: messageId, chat_id: chatId, user_id: myId, emoji })
      }
    },

    async ensureSenderProfiles(messages: ChatMessage[]) {
      const missing = [...new Set(messages.map((m) => m.sender_id))].filter(
        (id) => !this.profiles[id],
      )
      if (!missing.length) return
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar')
        .in('id', missing)
      for (const p of (data ?? []) as ChatProfile[]) this.profiles[p.id] = p
    },

    // --- Sending ---

    /** Upload composer attachments to the private chat-media bucket. Stores the
     * object PATH as the file url; signMediaFiles() mints a signed URL at view
     * time. (Path is <chatId>/<messageId>-i.ext so storage RLS can scope
     * access to members of that chat.) */
    async uploadFiles(chatId: string, messageId: string, files: OutgoingFile[]): Promise<ChatFile[]> {
      const uploaded: ChatFile[] = []
      for (const [i, f] of files.entries()) {
        if (!f.blob) continue
        const ext = (f.extension || f.name.split('.').pop() || 'bin').toLowerCase()
        const path = `${chatId}/${messageId}-${i}.${ext}`
        const { error } = await supabase.storage
          .from('chat-media')
          .upload(path, f.blob, { contentType: f.blob.type || undefined })
        if (error) continue
        uploaded.push({ name: f.name, size: f.size, type: ext, url: path })
      }
      return uploaded
    },

    /** chat-media is private: stored attachment urls are object paths. Swap each
     * in place for a short-lived signed URL the widget can render. External URLs
     * (GIFs already hosted on a CDN) are left untouched. */
    async signMediaFiles(messages: ChatMessage[]) {
      const pending: { file: ChatFile; path: string }[] = []
      for (const m of messages) {
        for (const f of m.files ?? []) {
          if (f.url && !/^https?:\/\//i.test(f.url)) pending.push({ file: f, path: f.url })
        }
      }
      if (!pending.length) return
      await Promise.all(
        pending.map(async ({ file, path }) => {
          const { data } = await supabase.storage.from('chat-media').createSignedUrl(path, 3600)
          if (data?.signedUrl) file.url = data.signedUrl
        }),
      )
    },

    async sendMessage(body: string, files: OutgoingFile[] = []) {
      const auth = useAuthStore()
      const chatId = this.activeChatId
      const text = body.trim()
      if (!auth.profile || !chatId || (!text && !files.length)) return
      this.sendError = ''
      await ensureFreshSession()

      const id = crypto.randomUUID()
      const uploaded = files.length ? await this.uploadFiles(chatId, id, files) : []
      if (files.length && !uploaded.length) {
        this.sendError = 'Attachment upload failed — check your connection.'
        if (!text) return
      }

      const message: ChatMessage = {
        id,
        chat_id: chatId,
        sender_id: auth.profile.id,
        body: text,
        files: uploaded.length ? uploaded : null,
        created_at: new Date().toISOString(), // local display only
      }
      this.messages.push(message) // optimistic; our realtime echo is skipped by sender
      // created_at stays out of the insert — the server clock stamps it
      // (client clocks drift, and a future-dated message never reads as read).
      const { created_at: _localOnly, ...payload } = message
      const { error } = await supabase.from('chat_messages').insert(payload)
      if (error) {
        this.messages = this.messages.filter((m) => m.id !== message.id)
        this.sendError = 'Message failed to send — check your connection.'
        return
      }
      // Row is stored with object paths; sign the optimistic copy for display.
      if (uploaded.length) void this.signMediaFiles([message])
    },

    /** Send a GIF picked from the GIF sheet — already hosted (Tenor CDN), so
     * no upload step, just a file descriptor the widget renders as an image. */
    async sendGif(url: string) {
      const auth = useAuthStore()
      const chatId = this.activeChatId
      if (!auth.profile || !chatId) return
      this.sendError = ''
      await ensureFreshSession()
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        chat_id: chatId,
        sender_id: auth.profile.id,
        body: '',
        files: [{ name: 'GIF', size: 0, type: 'gif', url, preview: url }],
        created_at: new Date().toISOString(), // local display only
      }
      this.messages.push(message)
      const { created_at: _localOnly, ...payload } = message
      const { error } = await supabase.from('chat_messages').insert(payload)
      if (error) {
        this.messages = this.messages.filter((m) => m.id !== message.id)
        this.sendError = 'GIF failed to send — check your connection.'
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

    /** Every org member, with role + team so team-scoped rooms and pickers
     * can filter down — the org has multiple teams, this is NOT a team list.
     * Phones come along for the member-list Call buttons; RLS keeps them
     * null outside your own team. */
    async loadOrgMembers() {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar, role, team_id, member_phones(phone)')
        .order('username')
      type Row = ChatProfile & { member_phones?: unknown }
      this.orgMembers = ((data ?? []) as Row[]).map(({ member_phones, ...p }) => ({
        ...p,
        phone: embeddedPhone(member_phones),
      }))
    },

    /** Search app users for the member pickers (excludes yourself). */
    async searchUsers(query: string): Promise<ChatProfile[]> {
      // Strip characters that carry meaning in PostgREST's .or() filter grammar
      // (commas/parens restructure the tree; %*\ are pattern/escape chars) so
      // the term can't inject extra predicates.
      const q = query.trim().replace(/[,()%*\\]/g, ' ').trim()
      if (q.length < 1) return []
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar')
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .neq('id', this.myId ?? '')
        .limit(10)
      return (data ?? []) as ChatProfile[]
    },
  },
})
