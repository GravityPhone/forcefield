<script lang="ts">
export default { name: 'CanvasserHomeView' }
</script>

<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'
import TalkTab from '@/components/canvass/TalkTab.vue'
import HuntTab from '@/components/canvass/HuntTab.vue'
import { useTalkStore } from '@/stores/talk'

const talk = useTalkStore()
</script>

<template>
  <AppShell>
    <div class="tab-bar" role="tablist">
      <button
        class="tab"
        role="tab"
        :aria-selected="talk.activeTab === 'talk'"
        :class="{ active: talk.activeTab === 'talk' }"
        @click="talk.activeTab = 'talk'"
      >
        Talk
      </button>
      <button
        class="tab"
        role="tab"
        :aria-selected="talk.activeTab === 'hunt'"
        :class="{ active: talk.activeTab === 'hunt' }"
        @click="talk.activeTab = 'hunt'"
      >
        Scout
      </button>
    </div>

    <!-- v-show (not v-if) so Hunt's map backgrounds instead of unmounting
         when the canvasser flips to Talk mid-conversation. -->
    <div v-show="talk.activeTab === 'talk'">
      <TalkTab />
    </div>
    <div v-show="talk.activeTab === 'hunt'">
      <HuntTab />
    </div>
  </AppShell>
</template>

<style scoped>
.tab-bar {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.tab {
  flex: 1;
  min-height: 48px;
  font-size: 1rem;
  font-weight: 700;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.tab:not(.active):hover {
  background: var(--surface-2);
  color: var(--text);
}

.tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast);
}
</style>
