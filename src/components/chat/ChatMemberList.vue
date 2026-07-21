<script setup lang="ts">
import { ref } from 'vue'
import { useChatStore, type ChatListItem } from '@/stores/chat'
import { avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { telHref } from '@/lib/phone'
import type { ChatProfile } from '@/types'

const props = defineProps<{ members: ChatProfile[]; activeChat: ChatListItem | null }>()

const chat = useChatStore()
// v-model so the chat header's own "Show members" menu action can toggle
// this from outside, in addition to the toggle button below.
const expanded = defineModel<boolean>('expanded', { default: false })
const openMenuFor = ref<string | null>(null)

function toggleMenu(id: string) {
  if (id === chat.myId) return // no actions on yourself
  openMenuFor.value = openMenuFor.value === id ? null : id
}

async function message(member: ChatProfile) {
  openMenuFor.value = null
  await chat.createChat('dm', null, [member.id])
}

async function addToSquad(member: ChatProfile) {
  openMenuFor.value = null
  if (!props.activeChat) return
  await chat.addMembers(props.activeChat.id, [member.id])
}

/** Only offer "add to squad/PM" when there's an actual membership list to
 * add them to (squads/DMs — every other kind is implicit membership) and
 * they're not already in it. */
function canAdd(member: ChatProfile): boolean {
  if (!props.activeChat || (props.activeChat.kind !== 'squad' && props.activeChat.kind !== 'dm'))
    return false
  return !props.activeChat.members.some((m) => m.id === member.id)
}
</script>

<template>
  <div class="member-panel">
    <button class="member-toggle" @click="expanded = !expanded; openMenuFor = null">
      <span>{{ expanded ? '▾' : '▸' }} Members ({{ members.length }})</span>
    </button>
    <div v-if="expanded" class="member-list">
      <div v-for="m in members" :key="m.id" class="member-item">
        <button
          class="member-name-btn"
          :class="{ me: m.id === chat.myId }"
          :style="{ color: memberColor(m) }"
          @click="toggleMenu(m.id)"
        >
          <img v-if="avatarUrl(m.avatar)" class="member-avatar" :src="avatarUrl(m.avatar)" alt="" />
          <span v-else class="member-dot" :style="{ background: memberColor(m) }" aria-hidden="true"></span>
          {{ m.display_name || m.username }}{{ m.id === chat.myId ? ' (you)' : '' }}
        </button>
        <div v-if="openMenuFor === m.id" class="member-menu">
          <button class="menu-action" @click="message(m)">Message</button>
          <a
            v-if="m.phone"
            class="menu-action"
            :href="telHref(m.phone)"
            @click="openMenuFor = null"
          >
            Call
          </a>
          <button v-if="canAdd(m)" class="menu-action" @click="addToSquad(m)">
            Add to {{ activeChat?.kind === 'squad' ? 'squad' : 'chat' }}
          </button>
        </div>
      </div>
      <p v-if="!members.length" class="muted empty">No one here yet.</p>
    </div>
  </div>
</template>

<style scoped>
.member-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.member-toggle {
  display: block;
  width: 100%;
  min-height: 40px;
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  text-align: left;
  font: inherit;
  font-weight: 600;
  font-size: 0.88rem;
  color: var(--text);
  cursor: pointer;
}

.member-toggle:hover {
  background: var(--surface-2);
}

.member-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0 0.5rem 0.5rem;
  max-height: 30dvh;
  overflow-y: auto;
}

.member-item {
  position: relative;
}

.member-avatar {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}

.member-dot {
  width: 12px;
  height: 12px;
  margin: 0 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Names wear each member's accent color (inline style) — same hue as their
 * Squad card, roster row, and chat-message username. */
.member-name-btn {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  min-height: 36px;
  padding: 0.4rem 0.6rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
}

.member-name-btn:hover {
  background: var(--surface-2);
}

.member-name-btn.me {
  cursor: default;
}

.member-name-btn.me:hover {
  background: transparent;
}

.member-menu {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin: 0.15rem 0 0.35rem 0.6rem;
  padding: 0.3rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}

.menu-action {
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0.35rem 0.6rem;
  border: none;
  border-radius: 6px;
  background: var(--surface);
  text-align: left;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  text-decoration: none;
}

.menu-action:hover {
  background: var(--accent);
  color: var(--accent-contrast);
}

.empty {
  font-size: 0.85rem;
  padding: 0.3rem 0.6rem;
}
</style>
