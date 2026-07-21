<script setup lang="ts">
// The "Pick my color" sheet on /profile — the 12-swatch team palette plus a
// hue/saturation/brightness mixer for any custom #rrggbb (the profiles.color
// CHECK allows the full hex range). The color accents your Squad card and
// map marker, your roster row, and your name in chat.
import { computed, ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import {
  MEMBER_COLORS,
  hexToHsl,
  hslToHex,
  inkOn,
  memberColor,
} from '@/lib/memberColors'
import { hapticTap } from '@/lib/native'

const open = defineModel<boolean>('open', { required: true })
const auth = useAuthStore()

const saving = ref(false)

const hue = ref(220)
const sat = ref(70)
const lig = ref(48)
const hexTyped = ref('')

// Seed the mixer from whatever color you currently show as (picked or
// auto-assigned) so nudging a slider starts from something familiar.
watch(open, (o) => {
  if (!o || !auth.profile) return
  hexTyped.value = ''
  const hsl = hexToHsl(memberColor(auth.profile))
  if (hsl) [hue.value, sat.value, lig.value] = hsl
})

const customHex = computed(() => hslToHex(hue.value, sat.value, lig.value))
const customInk = computed(() => inkOn(customHex.value))

/** Typing/pasting a full hex jumps the sliders to it. */
watch(hexTyped, (raw) => {
  const v = raw.trim().replace(/^([0-9a-f]{6})$/i, '#$1')
  const hsl = hexToHsl(v)
  if (hsl) [hue.value, sat.value, lig.value] = hsl
})

const satTrack = computed(
  () =>
    `linear-gradient(to right, hsl(${hue.value} 0% ${lig.value}%), hsl(${hue.value} 100% ${lig.value}%))`,
)
const ligTrack = computed(
  () =>
    `linear-gradient(to right, hsl(${hue.value} ${sat.value}% 6%), hsl(${hue.value} ${sat.value}% 50%), hsl(${hue.value} ${sat.value}% 94%))`,
)

const picked = computed(() => auth.profile?.color?.toLowerCase() ?? null)
/** The saved color is "custom" when it isn't one of the 12 swatches. */
const customActive = computed(
  () => !!picked.value && !MEMBER_COLORS.some((c) => c === picked.value),
)

const previewName = computed(
  () => auth.profile?.display_name || auth.profile?.username || 'You',
)

async function save(hex: string | null) {
  if (saving.value || !auth.profile) return
  saving.value = true
  hapticTap('light')
  await supabase.auth.getSession() // refresh-token race guard, same as theme saves
  const { error } = await supabase
    .from('profiles')
    .update({ color: hex, updated_at: new Date().toISOString() })
    .eq('id', auth.profile.id)
  if (!error) {
    auth.profile.color = hex
    open.value = false
  }
  saving.value = false
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Pick my color">
    <p class="muted intro">
      Tints your Squad card and map marker, your roster row, and your name in chat.
    </p>

    <section>
      <h3 class="section-heading">Team palette</h3>
      <div class="swatches" :class="{ busy: saving }">
        <button
          v-for="hex in MEMBER_COLORS"
          :key="hex"
          class="swatch"
          :class="{ active: picked === hex }"
          :style="{ background: hex }"
          :disabled="saving"
          :aria-label="`Pick ${hex}`"
          @click="save(hex)"
        >
          <span v-if="picked === hex" class="swatch-check">✓</span>
        </button>
      </div>
    </section>

    <section>
      <h3 class="section-heading">
        Mix your own
        <span v-if="customActive" class="badge">Active</span>
      </h3>

      <div class="mix-preview" :style="{ background: customHex, color: customInk }">
        <span class="mix-name">{{ previewName }}</span>
        <span class="mix-hex">{{ customHex }}</span>
      </div>

      <label class="slider-label" for="mix-hue">Hue</label>
      <input
        id="mix-hue"
        v-model.number="hue"
        class="slider hue-slider"
        type="range"
        min="0"
        max="360"
        step="1"
      />

      <label class="slider-label" for="mix-sat">Punch</label>
      <input
        id="mix-sat"
        v-model.number="sat"
        class="slider"
        type="range"
        min="0"
        max="100"
        step="1"
        :style="{ background: satTrack }"
      />

      <label class="slider-label" for="mix-lig">Brightness</label>
      <input
        id="mix-lig"
        v-model.number="lig"
        class="slider"
        type="range"
        min="12"
        max="88"
        step="1"
        :style="{ background: ligTrack }"
      />

      <div class="mix-row">
        <input
          v-model="hexTyped"
          class="hex-input"
          maxlength="7"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          :placeholder="customHex"
          aria-label="Type a hex color"
        />
        <button class="btn btn-primary use-btn" :disabled="saving" @click="save(customHex)">
          Use this color
        </button>
      </div>
    </section>

    <button
      v-if="auth.profile?.color"
      class="btn btn-ghost btn-sm reset-btn"
      :disabled="saving"
      @click="save(null)"
    >
      Back to automatic color
    </button>
    <p v-else-if="auth.profile" class="muted small auto-hint">
      No pick yet — you’re showing as
      <span class="auto-dot" :style="{ background: memberColor(auth.profile) }" aria-hidden="true"></span>
      (assigned automatically).
    </p>
  </BottomSheet>
</template>

<style scoped>
.intro {
  margin: -0.4rem 0 0;
  font-size: 0.88rem;
}

.section-heading {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.swatches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 0.5rem;
}

.swatches.busy {
  opacity: 0.7;
}

.swatch {
  aspect-ratio: 1;
  border: 2px solid var(--border);
  border-radius: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.swatch:not(:disabled):hover {
  transform: translateY(-1px);
}

.swatch.active {
  border-color: var(--text);
}

.swatch-check {
  color: #fff;
  font-weight: 800;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
}

/* --- Mixer --- */

.mix-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  min-height: 56px;
  padding: 0.6rem 0.9rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.7rem;
}

.mix-name {
  font-weight: 800;
  font-size: 1.05rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mix-hex {
  font-weight: 700;
  font-size: 0.85rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.slider-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text-muted);
  margin: 0.45rem 0 0.25rem;
}

.slider {
  -webkit-appearance: none;
  appearance: none;
  display: block;
  width: 100%;
  height: 18px;
  border-radius: 999px;
  border: 1px solid var(--border);
  outline: none;
  cursor: pointer;
}

.hue-slider {
  background: linear-gradient(
    to right,
    hsl(0 85% 55%),
    hsl(60 85% 55%),
    hsl(120 85% 45%),
    hsl(180 85% 45%),
    hsl(240 85% 60%),
    hsl(300 85% 55%),
    hsl(360 85% 55%)
  );
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}

.slider::-moz-range-thumb {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}

.slider::-moz-range-track {
  background: transparent;
}

.mix-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.8rem;
}

.hex-input {
  width: 7.5rem;
  min-height: 48px;
  padding: 0.45rem 0.6rem;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  font: inherit;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--text);
}

.hex-input:focus {
  outline: none;
  border-color: var(--accent);
}

.use-btn {
  flex: 1;
  min-height: 48px;
}

.reset-btn {
  align-self: flex-start;
}

.small {
  font-size: 0.85rem;
}

.auto-hint {
  margin: 0;
}

.auto-dot {
  display: inline-block;
  width: 0.85em;
  height: 0.85em;
  border-radius: 50%;
  vertical-align: -0.08em;
}
</style>
