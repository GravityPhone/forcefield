<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/AppShell.vue'
import EmojiPickerSheet from '@/components/profile/EmojiPickerSheet.vue'
import ColorPickerSheet from '@/components/profile/ColorPickerSheet.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { avatarName, avatarUrl } from '@/lib/avatars'
import { memberColor } from '@/lib/memberColors'
import { hapticTap } from '@/lib/native'
import { canvassGameOpen, useTapStreak } from '@/lib/easterEgg'
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

// --- Easter egg: tap your own name 25 times in a row → Clipboard Canvass.
// The name is inert otherwise, so nothing can swallow a tap mid-streak (the
// old chat-handle version opened the drawer on tap 1 and lost the rest).
const NAME_TAP_GOAL = 25
const { streak: nameTaps, tap: tapName } = useTapStreak(NAME_TAP_GOAL, () => {
  hapticTap('medium')
  canvassGameOpen.value = true
})

function onNameTap() {
  tapName()
  if (nameTaps.value > 6) hapticTap('light')
}

/** A wobble that grows with the streak — the only hint you're getting warm.
 * Sign alternates per tap so consecutive taps read as a jiggle, and the
 * whole thing snaps back to nothing the moment the streak lapses. */
const nameWobble = computed(() => {
  const n = nameTaps.value
  if (n < 6) return undefined
  const tilt = (n % 2 ? 1 : -1) * Math.min(4, (n - 5) * 0.4)
  const pop = 1 + Math.min(0.14, (n - 5) * 0.012)
  return { transform: `rotate(${tilt}deg) scale(${pop})` }
})

// --- How long you've been at this (2026-07-25, user call). A value under
// the role, not a sentence. Anchored on your FIRST KNOCK when you have one —
// that's when you actually started canvassing — and on the account date
// otherwise, so a brand-new sign-up still gets a line. ---

const tenure = ref('')

/** "3 days" / "6 weeks" / "4 months" — one unit, no decimals. */
function spanLabel(from: Date): string {
  const days = Math.max(0, Math.floor((Date.now() - from.getTime()) / 86_400_000))
  if (days < 1) return 'today'
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`
  if (days < 60) {
    const w = Math.floor(days / 7)
    return `${w} week${w === 1 ? '' : 's'}`
  }
  const m = Math.floor(days / 30)
  return `${m} month${m === 1 ? '' : 's'}`
}

function shortDay(d: Date): string {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

async function loadTenure() {
  if (!auth.profile) return
  const { data } = await supabase
    .from('knock_logs')
    .select('occurred_at')
    .eq('canvasser_id', auth.profile.id)
    .order('occurred_at', { ascending: true })
    .limit(1)
  const firstKnock = data?.[0]?.occurred_at
  if (firstKnock) {
    const d = new Date(firstKnock)
    tenure.value = `Knocking since ${shortDay(d)} · ${spanLabel(d)}`
    return
  }
  const joined = new Date(auth.profile.created_at)
  if (!Number.isNaN(joined.getTime())) {
    tenure.value = `Joined ${shortDay(joined)} · ${spanLabel(joined)}`
  }
}

onMounted(async () => {
  if (!auth.profile) return
  displayName.value = auth.profile.display_name ?? ''
  bio.value = auth.profile.bio ?? ''
  whyCanvassing.value = auth.profile.why_canvassing ?? ''
  funFact.value = auth.profile.fun_fact ?? ''
  void loadTenure()
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
    error.value = 'That phone number doesn’t look right. At least 7 digits, plus spaces and ( ) . if you like.'
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
        ? 'Could not save. Check your connection and try again.'
        : profileError
          ? 'Saved your phone number, but the intro didn’t go through. Try again.'
          : 'Saved your intro, but the phone number didn’t go through. Try again.'
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
      <div class="card identity" data-help="profile-identity" :style="{ '--member-color': memberColor(auth.profile) }">
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
          <!-- Tapping this does nothing visible — 25 times in a row is the
               easter egg (see onNameTap). -->
          <span class="identity-name" :style="nameWobble" @click="onNameTap">{{ previewName }}</span>
          <span class="muted identity-role">{{ ROLE_LABELS[auth.profile.role] }}</span>
          <span v-if="tenure" class="muted identity-tenure">{{ tenure }}</span>
        </span>
      </div>

      <!-- The two identity submenus: emoji + color. -->
      <div class="picker-row">
        <button class="picker-btn" data-help="profile-emoji" @click="emojiOpen = true">
          <span class="picker-preview">
            <img v-if="avatarUrl(auth.profile.avatar)" :src="avatarUrl(auth.profile.avatar)" alt="" />
            <template v-else>🙂</template>
          </span>
          <span class="picker-copy">
            <span class="picker-title">Pick my emoji</span>
            <span class="muted picker-sub">
              {{ auth.profile.avatar ? avatarName(auth.profile.avatar) : 'None yet, go grab one' }}
            </span>
          </span>
          <span class="muted picker-chevron" aria-hidden="true">›</span>
        </button>
        <button class="picker-btn" data-help="profile-color" @click="colorOpen = true">
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

      <div class="field" data-help="profile-name">
        <label for="about-name">Display name</label>
        <input
          id="about-name"
          v-model="displayName"
          maxlength="40"
          autocomplete="nickname"
          :placeholder="auth.profile.username"
        />
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

      <div v-if="showPhone" class="field phone-field" data-help="profile-phone">
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
  /* Tap target for the easter egg: no selection flicker, no double-tap
   * pause, no highlight — it should feel like plain text right up until it
   * starts wobbling. Origin left so the wobble doesn't shove a long name. */
  transform-origin: left center;
  transition: transform 0.09s ease-out;
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.identity-role {
  font-size: 0.85rem;
}

/* How long you've been at it — a value, sized below the role. */
.identity-tenure {
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
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
