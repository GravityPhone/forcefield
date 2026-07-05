<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { register } from 'vue-advanced-chat'
import AppShell from '@/components/AppShell.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import ChatMemberList from '@/components/chat/ChatMemberList.vue'
import { useChatStore } from '@/stores/chat'
import { useSquadsStore } from '@/stores/squads'
import { useThemeStore } from '@/stores/theme'
import { vacStyles } from '@/lib/themes'
import type { ChatProfile } from '@/types'

register()

const chat = useChatStore()
const theme = useThemeStore()
const route = useRoute()

// Re-skins the (shadow-DOM) chat widget to match the account's chosen
// scheme — the library fills in anything not overridden from its own
// light/dark preset, picked via `dark` on the current theme definition.
const vacBaseTheme = computed(() => (theme.currentTheme.dark ? 'dark' : 'light'))
const vacThemeStyles = computed(() => vacStyles(theme.currentTheme))

// New-chat composer: pick people on the campaign, name it to make an open
// squad, or leave it unnamed for a PM. Reused for "add people" too.
const composing = ref(false)
const chatName = ref('')
const picked = ref<ChatProfile[]>([])
const creating = ref(false)
const addingPeople = ref(false)
const pickedToAdd = ref<ChatProfile[]>([])

const joinableSquads = computed(() => chat.chats.filter((c) => c.kind === 'squad' && !c.isMember))
const membersExpanded = ref(false)

// The global room has no chat_members rows (everyone's implicitly in it),
// so its member list is every org user instead of the room's own roster.
const currentMembers = computed(() =>
  chat.activeChat?.kind === 'global' ? chat.orgMembers : (chat.activeChat?.members ?? []),
)

onMounted(async () => {
  await chat.loadChats()
  void chat.loadOrgMembers()
  chat.subscribeToMembership()
  // Deep link from the Squads page ("Chat" on a squad card): /chat?chat=<id>
  // lands directly in that squad's room.
  const target = typeof route.query.chat === 'string' ? route.query.chat : null
  if (target && chat.chats.some((c) => c.id === target)) await chat.openChat(target)
})
onUnmounted(() => {
  chat.closeChat()
  chat.unsubscribeFromMembership()
})

// --- Adapt our data model to vue-advanced-chat's Room/Message shapes ---

const vacRooms = computed(() =>
  chat.chats
    .filter((c) => c.isMember)
    .map((c) => ({
      roomId: c.id,
      roomName: chat.chatTitle(c),
      avatar: '',
      users: c.members.map((m) => ({
        _id: m.id,
        username: m.display_name || m.username,
        avatar: '',
        status: { state: 'offline' as const, lastChanged: '' },
      })),
    })),
)

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
    date: formatDate(m.created_at),
    timestamp: formatTime(m.created_at),
    saved: true,
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
  const detail = (e as CustomEvent).detail?.[0] as { content?: string } | undefined
  if (detail?.content) await chat.sendMessage(detail.content)
}

function onAddRoom() {
  openComposer()
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
      await chat.openChat(squad.chat_id)
    }
  } else {
    await chat.createChat(
      'dm',
      null,
      picked.value.map((p) => p.id),
    )
  }
  creating.value = false
  composing.value = false
}

async function joinSquad(chatId: string) {
  await chat.joinSquad(chatId)
  composing.value = false
  await chat.openChat(chatId)
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
  <AppShell>
    <div class="chat-page">
      <div v-if="chat.activeChat && chat.activeChat.kind !== 'global'" class="active-bar">
        <span class="muted">{{ chat.chatTitle(chat.activeChat) }}</span>
        <button class="btn btn-sm" @click="addingPeople = true; pickedToAdd = []">
          + Add people
        </button>
      </div>

      <ChatMemberList
        v-if="chat.activeChat"
        v-model:expanded="membersExpanded"
        :members="currentMembers"
        :active-chat="chat.activeChat"
      />

      <vue-advanced-chat
        v-if="chat.myId"
        height="65dvh"
        :theme="vacBaseTheme"
        :styles.prop="vacThemeStyles"
        :current-user-id="chat.myId"
        :rooms.prop="vacRooms"
        :rooms-loaded="!chat.loadingChats"
        :messages.prop="vacMessages"
        :messages-loaded="!chat.loadingMessages"
        :usernameOptions.prop="{ minUsers: 0, currentUser: false }"
        :messageActions.prop="messageActions"
        :menuActions.prop="menuActions"
        :show-add-room="true"
        :single-room="false"
        @fetch-messages="onFetchMessages"
        @send-message="onSendMessage"
        @add-room="onAddRoom"
        @message-action-handler="onMessageAction"
        @menu-action-handler="onMenuAction"
      ></vue-advanced-chat>
    </div>

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
  </AppShell>
</template>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.active-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.hint {
  margin: 0;
  font-size: 0.88rem;
}

.send-error {
  font-size: 0.82rem;
  color: var(--danger);
  margin: 0;
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
