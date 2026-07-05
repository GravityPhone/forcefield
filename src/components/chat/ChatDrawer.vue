<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import ChatMemberList from '@/components/chat/ChatMemberList.vue'
import GifPicker from '@/components/chat/GifPicker.vue'
import { useChatStore, type ChatListItem, type OutgoingFile } from '@/stores/chat'
import { useSquadsStore } from '@/stores/squads'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { vacStyles } from '@/lib/themes'
import { avatarUrl } from '@/lib/avatars'
import { hapticTap } from '@/lib/native'
import type { ChatProfile } from '@/types'

const chat = useChatStore()
const auth = useAuthStore()
const theme = useThemeStore()

// Re-skins the (shadow-DOM) chat widget to match the account's chosen
// scheme — the library fills in anything not overridden from its own
// light/dark preset, picked via `dark` on the current theme definition.
const vacBaseTheme = computed(() => (theme.currentTheme.dark ? 'dark' : 'light'))
const vacThemeStyles = computed(() => vacStyles(theme.currentTheme))

// --- Edge handle: tap toggles the drawer, vertical drag repositions it
// (parked wherever your thumb likes — persisted), horizontal drag opens. ---

const HANDLE_POS_KEY = 'forcefield.chat_handle_top'
const handleTopPct = ref(Number(localStorage.getItem(HANDLE_POS_KEY)) || 58)
let dragStartY = 0
let dragStartX = 0
let dragStartTop = 58
let dragMode: 'none' | 'move' | 'open' = 'none'

// Horizontal pull: the drawer follows the finger in real time (no snap-open
// jump), then settles open or closed on release.
const dragPx = ref(0)
const draggingOpen = ref(false)
const drawerWidth = () => Math.min(430, window.innerWidth)

// A tap opens on pointerup, then the browser fires the tap's `click` on
// whatever is under the finger by then — which is the backdrop that just
// appeared, instantly closing the drawer again ("tapping does nothing").
// Ignore backdrop clicks right after opening.
let openedAt = 0
watch(
  () => chat.drawerOpen,
  (open) => {
    if (open) openedAt = Date.now()
  },
)

function onBackdropClick() {
  if (Date.now() - openedAt < 400) return
  chat.closeDrawer()
}

function onHandleDown(e: PointerEvent) {
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  dragStartY = e.clientY
  dragStartX = e.clientX
  dragStartTop = handleTopPct.value
  dragMode = 'none'
}

function onHandleMove(e: PointerEvent) {
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY
  if (dragMode === 'none' && Math.hypot(dx, dy) > 8) {
    dragMode = Math.abs(dy) >= Math.abs(dx) ? 'move' : 'open'
    if (dragMode === 'open') draggingOpen.value = true
  }
  if (dragMode === 'move') {
    const pct = dragStartTop + (dy / window.innerHeight) * 100
    handleTopPct.value = Math.min(85, Math.max(12, pct))
  } else if (dragMode === 'open') {
    dragPx.value = Math.min(drawerWidth(), Math.max(0, -dx))
  }
}

function onHandleUp() {
  if (dragMode === 'none') {
    hapticTap('light')
    chat.drawerOpen ? chat.closeDrawer() : chat.openDrawer()
  } else if (dragMode === 'move') {
    localStorage.setItem(HANDLE_POS_KEY, String(Math.round(handleTopPct.value)))
  } else if (dragMode === 'open') {
    // Settle: pulled past a quarter of the panel = open, else spring shut.
    if (dragPx.value > drawerWidth() * 0.25) {
      hapticTap('light')
      chat.openDrawer()
    }
    draggingOpen.value = false
    dragPx.value = 0
  }
  dragMode = 'none'
}

function onHandleCancel() {
  dragMode = 'none'
  draggingOpen.value = false
  dragPx.value = 0
}

/** Mid-drag the panel tracks the finger; otherwise CSS classes handle it. */
const drawerStyle = computed(() =>
  draggingOpen.value
    ? { transform: `translateX(${drawerWidth() - dragPx.value}px)`, transition: 'none' }
    : undefined,
)

// --- Drawer views: room list first (Dana's rule — land on what's waiting,
// not wherever you last were), then a single room. ---

const view = ref<'list' | 'room'>('list')
const membersExpanded = ref(false)

// vue-advanced-chat is ~400 kB — keep it out of every page's bundle and pull
// it in the first time the drawer actually opens.
const widgetReady = ref(false)
async function ensureWidget() {
  if (widgetReady.value) return
  const mod = await import('vue-advanced-chat')
  mod.register()
  widgetReady.value = true
}
watch(
  () => chat.drawerOpen,
  (open) => {
    if (open) void ensureWidget()
  },
  { immediate: true },
)

function openRoom(id: string) {
  hapticTap('light')
  membersExpanded.value = false
  view.value = 'room'
  void chat.openChat(id)
}

// Deliberately NO unread refetch here: the local counts are already right
// (zeroed on open, incremented by realtime), and refetching races the
// still-in-flight chat_reads upsert — the stale server count would
// resurrect the badge for the room that was just read.
function backToList() {
  view.value = 'list'
  membersExpanded.value = false
  chat.closeChat()
}

// Deep links (router /chat guard, Squads page) open the drawer with a room
// already active — follow along.
watch(
  () => chat.activeChatId,
  (id) => {
    if (id && chat.drawerOpen) view.value = 'room'
  },
)
watch(
  () => chat.drawerOpen,
  (open) => {
    if (open && chat.activeChatId && view.value === 'room') chat.markRead(chat.activeChatId)
  },
)

const myRooms = computed(() => chat.chats.filter((c) => c.isMember))

/** Room-list row art: DMs show the other person's animal, groups an emoji. */
function roomIcon(c: ChatListItem): { img: string; fallback: string } {
  if (c.kind === 'dm') {
    const other = c.members.find((m) => m.id !== chat.myId)
    return { img: avatarUrl(other?.avatar), fallback: '💬' }
  }
  const fallbacks: Record<string, string> = {
    global: '🌐',
    team: '🛡️',
    team_leads: '🎖️',
    team_managers: '⭐',
    squad: '👥',
  }
  return { img: '', fallback: fallbacks[c.kind] ?? '👥' }
}

const KIND_LABELS: Record<string, string> = {
  global: 'Everyone on the campaign',
  team: 'Your team',
  team_leads: 'Squad leaders + managers',
  team_managers: 'Campaign managers',
  squad: 'Squad',
  dm: 'Private message',
}

// Global and team-scoped rooms have no chat_members rows (membership is
// implicit), so their member list comes from the org roster — the org has
// multiple teams, so team rooms filter to that room's team (and by role for
// the leadership rooms).
const LEADERSHIP_ROLES: Record<string, string[]> = {
  team_leads: ['team_lead', 'campaign_manager', 'admin'],
  team_managers: ['campaign_manager', 'admin'],
}

const currentMembers = computed(() => {
  const room = chat.activeChat
  if (!room) return []
  if (room.kind === 'global') return chat.orgMembers
  if (room.kind === 'team' || room.kind === 'team_leads' || room.kind === 'team_managers') {
    const roles = LEADERSHIP_ROLES[room.kind]
    return chat.orgMembers.filter(
      (m) =>
        m.team_id === room.team_id && (!roles || (m.role && roles.includes(m.role))),
    )
  }
  return room.members
})

// --- Widget sizing: the message list + composer get exactly the leftover
// panel space, measured for real (visualViewport shrinks when the phone
// keyboard opens, so the composer stays glued above the keys). ---

const widgetBox = ref<HTMLElement | null>(null)
const widgetHeight = ref(400)
let boxObserver: ResizeObserver | null = null

watch([widgetBox, view], () => {
  boxObserver?.disconnect()
  if (widgetBox.value) {
    boxObserver = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h) widgetHeight.value = Math.max(240, Math.floor(h))
    })
    boxObserver.observe(widgetBox.value)
  }
})

onMounted(() => {
  if (auth.profile) void chat.ensureBackground()
})
watch(
  () => auth.profile?.id,
  (id, old) => {
    if (id !== old) {
      chat.resetBackground()
      if (id) void chat.ensureBackground()
    }
  },
)
onUnmounted(() => boxObserver?.disconnect())

// --- Adapt our data model to vue-advanced-chat's Room/Message shapes ---

const vacRooms = computed(() => {
  const c = chat.activeChat
  if (!c) return []
  return [
    {
      roomId: c.id,
      roomName: chat.chatTitle(c),
      avatar: roomIcon(c).img,
      users: c.members.map((m) => ({
        _id: m.id,
        username: m.display_name || m.username,
        avatar: avatarUrl(m.avatar),
        status: { state: 'offline' as const, lastChanged: '' },
      })),
    },
  ]
})

function senderName(id: string): string {
  const p = chat.profiles[id]
  return p ? p.display_name || p.username : ''
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const vacMessages = computed(() =>
  chat.messages.map((m) => ({
    _id: m.id,
    senderId: m.sender_id,
    content: m.body,
    username: senderName(m.sender_id),
    avatar: avatarUrl(chat.profiles[m.sender_id]?.avatar),
    date: formatDate(m.created_at),
    timestamp: formatTime(m.created_at),
    saved: true,
    files: m.files ?? undefined,
    reactions: chat.reactions[m.id],
  })),
)

// --- Custom element events (native CustomEvent; payload is event.detail[0]) ---

async function onFetchMessages(e: Event) {
  const detail = (e as CustomEvent).detail?.[0] as { room?: { roomId?: string } } | undefined
  const roomId = detail?.room?.roomId
  if (!roomId) return
  if (roomId !== chat.activeChatId) {
    await chat.openChat(roomId)
  } else {
    chat.reaffirmMessagesLoaded()
  }
}

async function onSendMessage(e: Event) {
  const detail = (e as CustomEvent).detail?.[0] as
    | { content?: string; files?: OutgoingFile[] | null }
    | undefined
  if (detail?.content || detail?.files?.length) {
    await chat.sendMessage(detail.content ?? '', detail.files ?? [])
  }
}

/** Built-in reaction picker (long-press / hover a message). */
async function onMessageReaction(e: Event) {
  const detail = (e as CustomEvent).detail?.[0] as
    | { messageId?: string; reaction?: { unicode?: string }; remove?: boolean }
    | undefined
  const emoji = detail?.reaction?.unicode
  if (detail?.messageId && emoji) {
    await chat.toggleReaction(detail.messageId, emoji, !!detail.remove)
  }
}

/** The dropdown next to each message (reply/edit/etc. by default) — we only
 * support one action: jump to (or start) a DM with that message's sender.
 * Shows on your own messages too since the library has no per-message
 * "hide for self" option; clicking it there is just a silent no-op. */
const messageActions = [{ name: 'messageUser', title: 'Message user' }]

async function onMessageAction(e: Event) {
  const detail = (e as CustomEvent).detail?.[0] as
    | { action?: { name?: string }; message?: { senderId?: string } }
    | undefined
  if (detail?.action?.name !== 'messageUser') return
  const senderId = detail.message?.senderId
  if (senderId && senderId !== chat.myId) await chat.createChat('dm', null, [senderId])
}

/** The chat header's own menu (hamburger icon next to search) — gives a
 * "Show members" entry, Discord-style, in addition to the toggle below. */
const menuActions = [{ name: 'showMembers', title: 'Show members' }]

function onMenuAction(e: Event) {
  // Payload shape varies by which internal layer emits it — sometimes the
  // raw { name, title } action, sometimes { action, roomId }. Accept both.
  const detail = (e as CustomEvent).detail?.[0] as
    | { name?: string; action?: { name?: string } }
    | undefined
  const name = detail?.name ?? detail?.action?.name
  if (name === 'showMembers') membersExpanded.value = !membersExpanded.value
}

// --- New chat / join squad / add people sheets (ported from the old /chat
// page — the drawer is chat's only home now). ---

const gifOpen = ref(false)

async function onGifPick(url: string) {
  await chat.sendGif(url)
}

const composing = ref(false)
const chatName = ref('')
const picked = ref<ChatProfile[]>([])
const creating = ref(false)
const addingPeople = ref(false)
const pickedToAdd = ref<ChatProfile[]>([])

const joinableSquads = computed(() => chat.chats.filter((c) => c.kind === 'squad' && !c.isMember))

function openComposer() {
  composing.value = true
  chatName.value = ''
  picked.value = []
}

async function createChat() {
  if (creating.value || !picked.value.length) return
  creating.value = true
  const name = chatName.value.trim()
  if (name) {
    // Named group = today's squad. Goes through the squads RPC (not a bare
    // squad chat) so the crew also exists on /squads and the leaderboard.
    const squad = await useSquadsStore().createSquad(
      name,
      picked.value.map((p) => p.id),
    )
    if (squad?.chat_id) {
      await chat.loadChats()
      openRoom(squad.chat_id)
    }
  } else {
    await chat.createChat(
      'dm',
      null,
      picked.value.map((p) => p.id),
    )
    view.value = 'room'
  }
  creating.value = false
  composing.value = false
}

async function joinSquad(chatId: string) {
  await chat.joinSquad(chatId)
  composing.value = false
  openRoom(chatId)
}

async function addPeople() {
  if (!chat.activeChat || !pickedToAdd.value.length) return
  await chat.addMembers(
    chat.activeChat.id,
    pickedToAdd.value.map((p) => p.id),
  )
  addingPeople.value = false
  pickedToAdd.value = []
}
</script>

<template>
  <template v-if="auth.profile">
    <!-- Edge handle — the drawer's always-there front door -->
    <button
      v-show="!chat.drawerOpen || draggingOpen"
      class="drawer-handle"
      :style="{ top: `${handleTopPct}dvh` }"
      aria-label="Open chat"
      @pointerdown="onHandleDown"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleCancel"
    >
      <span class="handle-grip" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/>
        </svg>
      </span>
      <span v-if="chat.totalUnread" class="handle-badge">
        {{ chat.totalUnread > 99 ? '99+' : chat.totalUnread }}
      </span>
    </button>

    <!-- Backdrop -->
    <div v-if="chat.drawerOpen" class="drawer-backdrop" @click="onBackdropClick"></div>

    <!-- Drawer panel -->
    <aside class="drawer" :class="{ open: chat.drawerOpen }" :style="drawerStyle" aria-label="Chat">
      <header class="drawer-head">
        <button v-if="view === 'room'" class="head-btn" aria-label="All chats" @click="backToList">
          ‹ Chats
        </button>
        <span class="head-title">
          {{ view === 'room' && chat.activeChat ? chat.chatTitle(chat.activeChat) : 'Chat' }}
        </span>
        <button
          v-if="view === 'room' && (chat.activeChat?.kind === 'squad' || chat.activeChat?.kind === 'dm')"
          class="head-btn"
          @click="addingPeople = true; pickedToAdd = []"
        >
          + Add
        </button>
        <button class="head-btn head-close" aria-label="Close chat" @click="chat.closeDrawer()">✕</button>
      </header>

      <!-- Room list -->
      <div v-if="view === 'list'" class="room-list">
        <button v-for="c in myRooms" :key="c.id" class="room-row" @click="openRoom(c.id)">
          <span class="room-icon">
            <img v-if="roomIcon(c).img" :src="roomIcon(c).img" alt="" />
            <span v-else>{{ roomIcon(c).fallback }}</span>
          </span>
          <span class="room-text">
            <span class="room-name">{{ chat.chatTitle(c) }}</span>
            <span class="room-kind muted">{{ KIND_LABELS[c.kind] }}</span>
          </span>
          <span v-if="chat.unread[c.id]" class="room-unread">
            {{ chat.unread[c.id] > 99 ? '99+' : chat.unread[c.id] }}
          </span>
        </button>
        <div v-if="chat.chatsError" class="rooms-error">
          <p>{{ chat.chatsError }}</p>
          <button class="btn btn-sm" @click="chat.loadChats()">Try again</button>
        </div>
        <p v-else-if="!myRooms.length && !chat.loadingChats" class="muted room-empty">
          No chats yet — start one below.
        </p>
        <button class="btn btn-primary btn-block new-chat-btn" @click="openComposer">
          + New chat or squad
        </button>
      </div>

      <!-- Single room -->
      <template v-else>
        <ChatMemberList
          v-if="chat.activeChat"
          v-model:expanded="membersExpanded"
          :members="currentMembers"
          :active-chat="chat.activeChat"
        />
        <div ref="widgetBox" class="widget-box">
          <vue-advanced-chat
            v-if="widgetReady && chat.myId && chat.activeChatId"
            :height="`${widgetHeight}px`"
            :theme="vacBaseTheme"
            :styles.prop="vacThemeStyles"
            :current-user-id="chat.myId"
            :room-id="chat.activeChatId"
            :rooms.prop="vacRooms"
            :rooms-loaded="!chat.loadingChats"
            :messages.prop="vacMessages"
            :messages-loaded="!chat.loadingMessages"
            :usernameOptions.prop="{ minUsers: 0, currentUser: false }"
            :messageActions.prop="messageActions"
            :menuActions.prop="menuActions"
            :show-add-room="false"
            :show-audio="false"
            :single-room="true"
            @fetch-messages="onFetchMessages"
            @send-message="onSendMessage"
            @send-message-reaction="onMessageReaction"
            @message-action-handler="onMessageAction"
            @menu-action-handler="onMenuAction"
          ></vue-advanced-chat>
        </div>
        <div class="composer-extras">
          <button class="gif-btn" @click="gifOpen = true">GIF</button>
        </div>
        <p v-if="chat.sendError" class="send-error">{{ chat.sendError }}</p>
      </template>
    </aside>

    <GifPicker v-model:open="gifOpen" @pick="onGifPick" />

    <!-- New chat / join squad sheet -->
    <BottomSheet v-model:open="composing" title="Start a chat" aria-label="Start a chat">
      <p class="muted hint">
        Pick one or more people on your campaign. Give it a name to form today's squad —
        an open crew anyone can join, with its own chat; leave the name off for a private
        message.
      </p>
      <UserPicker v-model="picked" />
      <div class="field">
        <label for="chat-name">Squad name (optional)</label>
        <input id="chat-name" v-model="chatName" placeholder="e.g. Richwood crew" />
      </div>
      <p v-if="chat.sendError" class="send-error">{{ chat.sendError }}</p>
      <button
        class="btn btn-primary btn-block start-btn"
        :disabled="creating || !picked.length"
        @click="createChat"
      >
        {{ creating ? 'Starting…' : 'Start chat' }}
      </button>

      <div v-if="joinableSquads.length" class="joinable">
        <h4 class="muted">Open squads you can join</h4>
        <button v-for="c in joinableSquads" :key="c.id" class="squad-row" @click="joinSquad(c.id)">
          <span class="squad-name">👥 {{ chat.chatTitle(c) }}</span>
          <span class="muted">
            {{ c.members.length }} member{{ c.members.length === 1 ? '' : 's' }} · tap to join
          </span>
        </button>
      </div>
    </BottomSheet>

    <!-- Add people sheet -->
    <BottomSheet
      v-model:open="addingPeople"
      :title="chat.activeChat ? `Add people to ${chat.chatTitle(chat.activeChat)}` : 'Add people'"
      aria-label="Add people"
    >
      <template v-if="chat.activeChat">
        <UserPicker v-model="pickedToAdd" :exclude="chat.activeChat.members.map((m) => m.id)" />
        <button class="btn btn-primary btn-block" :disabled="!pickedToAdd.length" @click="addPeople">
          Add
        </button>
      </template>
    </BottomSheet>
  </template>
</template>

<style scoped>
/* --- Handle --- */

.drawer-handle {
  position: fixed;
  right: 0;
  z-index: 47; /* above the panel so it stays grabbable mid-drag */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.6rem;
  height: 3.4rem;
  padding: 0;
  border: none;
  border-radius: 14px 0 0 14px;
  /* Deliberately theme-independent (like the outcome colors): bright neon
   * orange so the chat handle is findable at a glance in any scheme/sun. */
  background: #ff6d00;
  color: #fff;
  box-shadow: -2px 2px 10px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  touch-action: none; /* we run the drag ourselves */
  -webkit-tap-highlight-color: transparent;
}

.handle-grip svg {
  width: 22px;
  height: 22px;
  display: block;
}

.handle-badge {
  position: absolute;
  top: -0.45rem;
  left: -0.55rem;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--danger);
  border: 2px solid #fff; /* separates the red badge from the orange handle */
  color: #fff;
  font-size: 0.7rem;
  font-weight: 800;
}

/* --- Drawer --- */

.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: rgba(15, 18, 30, 0.4);
}

.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 46;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: min(430px, 100vw);
  padding: 0.6rem 0.6rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  padding-top: calc(0.6rem + env(safe-area-inset-top, 0px));
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: -6px 0 24px rgba(0, 0, 0, 0.18);
  transform: translateX(100%);
  transition: transform 0.22s ease;
}

.drawer.open {
  transform: translateX(0);
}

.drawer-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
}

.head-title {
  flex: 1;
  font-weight: 800;
  font-size: 1.02rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-btn {
  min-height: 40px;
  padding: 0.3rem 0.6rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-weight: 700;
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}

.head-btn:hover {
  background: var(--surface-2);
}

.head-close {
  color: var(--text-muted);
  font-size: 1.05rem;
}

/* --- Room list --- */

.room-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  overflow-y: auto;
}

.room-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 60px;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.room-row:hover {
  background: var(--surface-2);
}

.room-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.4rem;
  height: 2.4rem;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--surface-2);
  font-size: 1.25rem;
  overflow: hidden;
}

.room-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.room-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.room-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-kind {
  font-size: 0.78rem;
}

.room-unread {
  min-width: 1.4rem;
  height: 1.4rem;
  padding: 0 0.35rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 800;
}

.room-empty {
  padding: 0.6rem 0.2rem;
}

.rooms-error {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.7rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  color: var(--danger);
  font-size: 0.88rem;
}

.rooms-error p {
  margin: 0;
}

.new-chat-btn {
  margin-top: 0.3rem;
  min-height: 52px;
}

/* --- Room view --- */

.widget-box {
  flex: 1;
  min-height: 0;
}

.composer-extras {
  display: flex;
  justify-content: flex-start;
}

.gif-btn {
  min-height: 36px;
  padding: 0.25rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: var(--accent);
  cursor: pointer;
}

.gif-btn:hover {
  background: var(--surface-2);
}

.send-error {
  font-size: 0.82rem;
  color: var(--danger);
  margin: 0;
}

/* --- Sheets (ported from the old chat page) --- */

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.hint {
  margin: 0;
  font-size: 0.88rem;
}

.joinable {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}

.joinable h4 {
  margin: 0;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.squad-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.squad-row:hover {
  background: var(--surface-2);
}

.squad-name {
  font-weight: 600;
}

.start-btn {
  min-height: 56px;
  font-size: 1.05rem;
}
</style>
