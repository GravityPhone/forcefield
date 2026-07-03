<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import AppShell from '@/components/AppShell.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type { Bulletin } from '@/types'

const auth = useAuthStore()
const isAdmin = auth.profile?.role === 'admin'

const bulletins = ref<Bulletin[]>([])
const loading = ref(true)
const title = ref('')
const body = ref('')
const posting = ref(false)
const postError = ref('')

let channel: RealtimeChannel | null = null

async function loadBulletins() {
  const { data, error } = await supabase
    .from('bulletins')
    .select('*, author:profiles(id, username, display_name)')
    .order('created_at', { ascending: false })
  loading.value = false
  if (!error && data) bulletins.value = data as Bulletin[]
}

async function post() {
  if (!auth.profile || !title.value.trim() || !body.value.trim()) return
  posting.value = true
  postError.value = ''
  // Refresh-token race guard, same as chat sends.
  await supabase.auth.getSession()
  const { error } = await supabase.from('bulletins').insert({
    author_id: auth.profile.id,
    title: title.value.trim(),
    body: body.value.trim(),
  })
  posting.value = false
  if (error) {
    postError.value = 'Could not post the announcement — try again.'
    return
  }
  title.value = ''
  body.value = ''
  await loadBulletins()
}

async function remove(bulletin: Bulletin) {
  if (!confirm(`Delete "${bulletin.title}"?`)) return
  const { error } = await supabase.from('bulletins').delete().eq('id', bulletin.id)
  if (!error) bulletins.value = bulletins.value.filter((b) => b.id !== bulletin.id)
}

function authorName(b: Bulletin): string {
  return b.author?.display_name || b.author?.username || 'Campaign HQ'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

onMounted(() => {
  void loadBulletins()
  // Announcements are low-volume; a full refetch keeps the author embed
  // correct without hand-stitching realtime payloads.
  channel = supabase
    .channel('bulletins')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bulletins' }, () =>
      void loadBulletins(),
    )
    .subscribe()
})

onUnmounted(() => {
  if (channel) void supabase.removeChannel(channel)
})
</script>

<template>
  <AppShell title="Campaign Bulletin">
    <div class="stack">
      <div v-if="isAdmin" class="card">
        <h3>Post an announcement</h3>
        <form @submit.prevent="post">
          <div class="field">
            <label for="bulletin-title">Title</label>
            <input
              id="bulletin-title"
              v-model="title"
              maxlength="200"
              placeholder="e.g. Saturday canvass launch — meet at the library, 10am"
            />
          </div>
          <div class="field">
            <label for="bulletin-body">Message</label>
            <textarea
              id="bulletin-body"
              v-model="body"
              rows="4"
              maxlength="8000"
              placeholder="Everything the team needs to know…"
            />
          </div>
          <button class="btn btn-primary" type="submit" :disabled="posting || !title.trim() || !body.trim()">
            {{ posting ? 'Posting…' : 'Post announcement' }}
          </button>
          <p v-if="postError" class="error">{{ postError }}</p>
        </form>
      </div>

      <p v-if="loading" class="muted">Loading announcements…</p>
      <p v-else-if="!bulletins.length" class="muted">
        No announcements yet{{ isAdmin ? ' — post the first one above.' : '.' }}
      </p>

      <article v-for="b in bulletins" :key="b.id" class="card bulletin">
        <div class="bulletin-head">
          <h3>{{ b.title }}</h3>
          <button v-if="isAdmin" class="btn btn-ghost btn-sm" @click="remove(b)">Delete</button>
        </div>
        <p class="muted meta">{{ authorName(b) }} · {{ formatDate(b.created_at) }}</p>
        <p class="body">{{ b.body }}</p>
      </article>
    </div>
  </AppShell>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.bulletin-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

.meta {
  font-size: 0.85rem;
  margin: 0.15rem 0 0.6rem;
}

.body {
  white-space: pre-wrap;
  margin: 0;
}

textarea {
  resize: vertical;
}

.error {
  color: var(--danger, #c0392b);
  margin: 0.5rem 0 0;
  font-size: 0.9rem;
}
</style>
