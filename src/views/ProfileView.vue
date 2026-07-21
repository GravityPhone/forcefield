<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import EmojiPickerSheet from '@/components/profile/EmojiPickerSheet.vue'
import ColorPickerSheet from '@/components/profile/ColorPickerSheet.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { avatarName, avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { ROLE_LABELS } from '@/types'

const auth = useAuthStore()

// The emoji + color pickers live HERE (moved off /appearance 2026-07-21) —
// identity is About-me business; /appearance keeps schemes & readability.
const emojiOpen = ref(false)
const colorOpen = ref(false)

// Admins aren't on a team (guard_profile_privileges nulls team_id), so a
// saved number would be visible to no one — hide the field rather than
// offer a dead control.
const showPhone = auth.profile?.role !== 'admin'

const displayName = ref('')
const bio = ref('')
const whyCanvassing = ref('')
const funFact = ref('')
const phone = ref('')
/** What's currently in member_phones — blank save only issues a DELETE when
 * there's actually a row to remove. */
const savedPhone = ref('')

const saving = ref(false)
const savedFlash = ref(false)
const error = ref('')

// Matches the member_phones CHECK constraint — reject locally with a human
// message instead of surfacing a Postgres error.
const PHONE_RE = /^\+?[0-9() .-]{7,20}$/

/** Live preview in the identity card while typing — what teammates will see. */
const previewName = computed(
  () => displayName.value.trim() || auth.profile?.username || '',
)

onMounted(async () => {
  if (!auth.profile) return
  displayName.value = auth.profile.display_name ?? ''
  bio.value = auth.profile.bio ?? ''
  whyCanvassing.value = auth.profile.why_canvassing ?? ''
  funFact.value = auth.profile.fun_fact ?? ''
  if (showPhone) {
    const { data } = await supabase
      .from('member_phones')
      .select('phone')
      .eq('user_id', auth.profile.id)
      .maybeSingle()
    phone.value = data?.phone ?? ''
    savedPhone.value = phone.value
  }
})

async function save() {
  if (saving.value || !auth.profile) return
  error.value = ''
  const p = phone.value.trim()
  const digits = p.replace(/\D/g, '').length
  if (p && (!PHONE_RE.test(p) || digits < 7 || digits > 15)) {
    error.value = 'That phone number doesn’t look right — at least 7 digits, plus spaces and ( ) . - if you like.'
    return
  }
  saving.value = true
  await supabase.auth.getSession() // refresh-token race guard, same as theme saves
  const patch = {
    // Blank = go by your username again (every consumer renders
    // display_name || username).
    display_name: displayName.value.trim() || null,
    bio: bio.value.trim() || null,
    why_canvassing: whyCanvassing.value.trim() || null,
    fun_fact: funFact.value.trim() || null,
    updated_at: new Date().toISOString(),
  }
  const { error: profileError } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', auth.profile.id)

  let phoneError = null
  if (showPhone && p !== savedPhone.value) {
    if (p) {
      const { error: e } = await supabase
        .from('member_phones')
        .upsert({ user_id: auth.profile.id, phone: p, updated_at: new Date().toISOString() })
      phoneError = e
    } else {
      // Blank = withdraw the number entirely — no row, no call button, anywhere.
      const { error: e } = await supabase
        .from('member_phones')
        .delete()
        .eq('user_id', auth.profile.id)
      phoneError = e
    }
  }

  // Sync the store per write, not on all-or-nothing — a bio that actually
  // persisted must be reflected even when the phone write failed, or a later
  // save from a stale remount would silently revert it.
  if (!profileError) {
    auth.profile.display_name = patch.display_name
    auth.profile.bio = patch.bio
    auth.profile.why_canvassing = patch.why_canvassing
    auth.profile.fun_fact = patch.fun_fact
  }
  if (!phoneError) savedPhone.value = p

  if (profileError || phoneError) {
    error.value =
      profileError && phoneError
        ? 'Could not save — check your connection and try again.'
        : profileError
          ? 'Saved your phone number, but the intro didn’t go through — try again.'
          : 'Saved your intro, but the phone number didn’t go through — try again.'
  } else {
    savedFlash.value = true
    setTimeout(() => (savedFlash.value = false), 2000)
  }
  saving.value = false
}
</script>

<template>
  <AppShell title="About me">
    <div v-if="auth.profile" class="about-page">
      <!-- Who this is — the avatar doubles as a shortcut into the picker. -->
      <div class="card identity" :style="{ '--member-color': memberColor(auth.profile) }">
        <button
          class="identity-avatar"
          :style="!avatarUrl(auth.profile.avatar) ? { background: memberColor(auth.profile) } : {}"
          aria-label="Pick my emoji"
          @click="emojiOpen = true"
        >
          <img v-if="avatarUrl(auth.profile.avatar)" :src="avatarUrl(auth.profile.avatar)" alt="" />
          <template v-else>{{ previewName.slice(0, 1).toUpperCase() }}</template>
        </button>
        <span class="identity-text">
          <span class="identity-name">{{ previewName }}</span>
          <span class="muted identity-role">{{ ROLE_LABELS[auth.profile.role] }}</span>
        </span>
      </div>

      <!-- The two identity submenus: emoji + color. -->
      <div class="picker-row">
        <button class="picker-btn" @click="emojiOpen = true">
          <span class="picker-preview">
            <img v-if="avatarUrl(auth.profile.avatar)" :src="avatarUrl(auth.profile.avatar)" alt="" />
            <template v-else>🙂</template>
          </span>
          <span class="picker-copy">
            <span class="picker-title">Pick my emoji</span>
            <span class="muted picker-sub">
              {{ auth.profile.avatar ? avatarName(auth.profile.avatar) : 'None yet — go grab one' }}
            </span>
          </span>
          <span class="muted picker-chevron" aria-hidden="true">›</span>
        </button>
        <button class="picker-btn" @click="colorOpen = true">
          <span
            class="picker-preview picker-color"
            :style="{ background: memberColor(auth.profile) }"
          ></span>
          <span class="picker-copy">
            <span class="picker-title">Pick my color</span>
            <span class="muted picker-sub">
              {{ auth.profile.color ? auth.profile.color.toUpperCase() : 'Automatic' }}
            </span>
          </span>
          <span class="muted picker-chevron" aria-hidden="true">›</span>
        </button>
      </div>

      <div class="field">
        <label for="about-name">Display name</label>
        <input
          id="about-name"
          v-model="displayName"
          maxlength="40"
          autocomplete="nickname"
          :placeholder="auth.profile.username"
        />
        <p class="muted field-note">
          What teammates see everywhere — chat, squad page, leaderboard. Leave it
          blank to go by your username ({{ auth.profile.username }}).
        </p>
      </div>

      <div class="field">
        <label for="about-bio">A little about you</label>
        <textarea
          id="about-bio"
          v-model="bio"
          rows="4"
          maxlength="500"
          placeholder="Whatever you'd tell a new squadmate on the walk to the first door…"
        ></textarea>
      </div>

      <div class="field">
        <label for="about-why">Why I’m canvassing</label>
        <input
          id="about-why"
          v-model="whyCanvassing"
          maxlength="300"
          placeholder="What gets you out the door"
        />
      </div>

      <div class="field">
        <label for="about-fun">Fun fact</label>
        <input
          id="about-fun"
          v-model="funFact"
          maxlength="300"
          placeholder="Something nobody would guess"
        />
      </div>

      <div v-if="showPhone" class="field phone-field">
        <label for="about-phone">Phone number (optional)</label>
        <input
          id="about-phone"
          v-model="phone"
          type="tel"
          inputmode="tel"
          maxlength="20"
          autocomplete="tel"
          placeholder="e.g. (937) 555-0123"
        />
        <p class="muted field-note">
          Teammates will see this number and can call you with one tap.
          Leave it blank and no one can call you.
        </p>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="save-row">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <span v-if="savedFlash" class="saved-flash">Saved ✓</span>
      </div>

      <EmojiPickerSheet v-model:open="emojiOpen" />
      <ColorPickerSheet v-model:open="colorOpen" />
    </div>
  </AppShell>
</template>

<style scoped>
.about-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 640px;
}

.identity {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.9rem 1rem;
}

.identity-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  padding: 0;
  border-radius: 50%;
  border: 2.5px solid var(--member-color);
  background: transparent;
  overflow: hidden;
  flex-shrink: 0;
  font: inherit;
  font-weight: 800;
  font-size: 1.3rem;
  color: #fff;
  cursor: pointer;
}

.identity-avatar img {
  width: 80%;
  height: 80%;
  object-fit: contain;
}

.identity-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.identity-name {
  font-weight: 700;
  font-size: 1.05rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.identity-role {
  font-size: 0.85rem;
}

/* --- Emoji / color picker buttons --- */

.picker-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

@media (max-width: 420px) {
  .picker-row {
    grid-template-columns: 1fr;
  }
}

.picker-btn {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 64px;
  padding: 0.6rem 0.75rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font: inherit;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.picker-btn:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  transform: translateY(-1px);
}

.picker-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  font-size: 1.5rem;
}

.picker-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.picker-color {
  border-radius: 50%;
  border: 2px solid var(--border);
}

.picker-copy {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.picker-title {
  font-weight: 800;
  font-size: 0.98rem;
}

.picker-sub {
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-chevron {
  font-size: 1.3rem;
  flex-shrink: 0;
}

.field-note {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  line-height: 1.4;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 0.9rem;
}

.save-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.saved-flash {
  color: var(--success, #2e9e5b);
  font-weight: 700;
  font-size: 0.92rem;
}
</style>
