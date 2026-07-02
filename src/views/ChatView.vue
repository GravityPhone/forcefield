<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { register } from 'vue-advanced-chat'
import AppShell from '@/components/AppShell.vue'
import UserPicker from '@/components/chat/UserPicker.vue'
import { useChatStore } from '@/stores/chat'
import type { ChatProfile } from '@/types'

register()

const chat = useChatStore()

// New-chat composer: pick people on the campaign, name it to make an open
// squad, or leave it unnamed for a PM. Reused for "add people" too.
const composing = ref(false)
const chatName = ref('')
const picked = ref<ChatProfile[]>([])
const creating = ref(false)
const addingPeople = ref(false)
const pickedToAdd = ref<ChatProfile[]>([])

const joinableSquads = computed(() => chat.chats.filter((c) => c.kind === 'squad' && !c.isMember))

onMounted(() => void chat.loadChats())
onUnmounted(() => chat.closeChat())

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
  if (roomId && roomId !== chat.activeChatId) await chat.openChat(roomId)
}

async function onSendMessage(e: Event) {
  const detail = (e as CustomEvent).detail?.[0] as { content?: string } | undefined
  if (detail?.content) await chat.sendMessage(detail.content)
}

function onAddRoom() {
  openComposer()
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
  await chat.createChat(
    name ? 'squad' : 'dm',
    name || null,
    picked.value.map((p) => p.id),
  )
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
  <AppShell title="Chat">
    <div class="chat-page">
      <div v-if="chat.activeChat && chat.activeChat.kind !== 'global'" class="active-bar">
        <span class="muted">{{ chat.chatTitle(chat.activeChat) }}</span>
        <button class="btn btn-sm" @click="addingPeople = true; pickedToAdd = []">
          + Add people
        </button>
      </div>

      <vue-advanced-chat
        v-if="chat.myId"
        height="65dvh"
        :current-user-id="chat.myId"
        :rooms.prop="vacRooms"
        :rooms-loaded="!chat.loadingChats"
        :messages.prop="vacMessages"
        :messages-loaded="!chat.loadingMessages"
        :show-add-room="true"
        :single-room="false"
        @fetch-messages="onFetchMessages"
        @send-message="onSendMessage"
        @add-room="onAddRoom"
      ></vue-advanced-chat>
    </div>

    <!-- New chat / join squad dialog -->
    <div v-if="composing" class="overlay" @click.self="composing = false">
      <div class="dialog card">
        <h3>Start a chat</h3>
        <p class="muted hint">
          Pick one or more people on your campaign (UBI). Give it a name to make it an open
          squad anyone can join; leave the name off for a private message.
        </p>
        <UserPicker v-model="picked" />
        <div class="field">
          <label for="chat-name">Squad name (optional)</label>
          <input id="chat-name" v-model="chatName" placeholder="e.g. Richwood crew" />
        </div>
        <p v-if="chat.sendError" class="send-error">{{ chat.sendError }}</p>
        <div class="dialog-actions">
          <button class="btn" @click="composing = false">Cancel</button>
          <button class="btn btn-primary" :disabled="creating || !picked.length" @click="createChat">
            {{ creating ? 'Starting…' : 'Start chat' }}
          </button>
        </div>

        <div v-if="joinableSquads.length" class="joinable">
          <h4 class="muted">Open squads you can join</h4>
          <button v-for="c in joinableSquads" :key="c.id" class="squad-row" @click="joinSquad(c.id)">
            <span class="squad-name">👥 {{ chat.chatTitle(c) }}</span>
            <span class="muted">
              {{ c.members.length }} member{{ c.members.length === 1 ? '' : 's' }} · tap to join
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Add people dialog -->
    <div v-if="addingPeople && chat.activeChat" class="overlay" @click.self="addingPeople = false">
      <div class="dialog card">
        <h3>Add people to {{ chat.chatTitle(chat.activeChat) }}</h3>
        <UserPicker v-model="pickedToAdd" :exclude="chat.activeChat.members.map((m) => m.id)" />
        <div class="dialog-actions">
          <button class="btn" @click="addingPeople = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!pickedToAdd.length" @click="addPeople">
            Add
          </button>
        </div>
      </div>
    </div>
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

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 18, 30, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 50;
}

.dialog {
  width: min(440px, 100%);
  max-height: 85dvh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
