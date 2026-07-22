<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { roleHome, useAuthStore } from '@/stores/auth'
import { hapticTap } from '@/lib/native'
import { TUTORIAL_CHAPTERS, TUTORIAL_STEPS } from '@/lib/tutorialContent'

// A full-screen retro "guided tour" deck. Deliberately theme-independent:
// the fixed arcade palette IS the look, on every scheme. One linear track —
// the demo's whole point is that anyone can Next their way from canvasser
// basics to campaign-manager tools.

const router = useRouter()
const auth = useAuthStore()

const index = ref(0)
const total = TUTORIAL_STEPS.length
const step = computed(() => TUTORIAL_STEPS[index.value])
const atStart = computed(() => index.value === 0)
const atEnd = computed(() => index.value === total - 1)
const progressPct = computed(() => ((index.value + 1) / total) * 100)

function next() {
  hapticTap('light')
  if (atEnd.value) {
    exit()
    return
  }
  index.value++
}

function back() {
  if (atStart.value) return
  hapticTap('light')
  index.value--
}

function jumpToChapter(id: string) {
  const i = TUTORIAL_STEPS.findIndex((s) => s.chapter.id === id)
  if (i !== -1) {
    hapticTap('light')
    index.value = i
  }
}

function exit() {
  const role = auth.profile?.role
  void router.push(role ? roleHome(role) : '/')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    back()
  } else if (e.key === 'Escape') {
    exit()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="tut-screen">
    <div class="tut-scanlines" aria-hidden="true" />

    <header class="tut-top">
      <span class="tut-sys">★ FORCEFIELD // GUIDED TOUR</span>
      <button class="tut-exit" aria-label="Exit tutorial" @click="exit">✕</button>
    </header>

    <nav class="tut-chapters" aria-label="Tutorial chapters">
      <button
        v-for="c in TUTORIAL_CHAPTERS"
        :key="c.id"
        class="tut-chip"
        :class="{ active: step.chapter.id === c.id }"
        @click="jumpToChapter(c.id)"
      >
        {{ c.label }}
      </button>
    </nav>

    <main class="tut-stage">
      <section :key="index" class="tut-box" aria-live="polite">
        <div class="tut-titlebar">
          <span class="tut-dot tut-dot-r" /><span class="tut-dot tut-dot-y" /><span class="tut-dot tut-dot-g" />
          <span class="tut-tag">{{ step.chapter.label.toUpperCase() }} · {{ step.chapter.audience }}</span>
        </div>
        <div class="tut-progress" aria-hidden="true">
          <div class="tut-progress-fill" :style="{ width: `${progressPct}%` }" />
        </div>
        <div class="tut-body">
          <div class="tut-emoji" aria-hidden="true">{{ step.emoji }}</div>
          <h1 class="tut-title">{{ step.title }}<span class="tut-cursor">▮</span></h1>
          <p class="tut-text">{{ step.body }}</p>
          <p v-if="step.tip" class="tut-tip">★ {{ step.tip }}</p>
        </div>
        <footer class="tut-controls">
          <button class="tut-btn tut-btn-ghost" :disabled="atStart" @click="back">◂ Back</button>
          <span class="tut-count">{{ String(index + 1).padStart(2, '0') }} / {{ String(total).padStart(2, '0') }}</span>
          <button class="tut-btn tut-btn-go" @click="next">{{ atEnd ? 'Finish ★' : 'Next ▸' }}</button>
        </footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* Fixed retro-arcade palette — the tour keeps this look on every theme. */
.tut-screen {
  --tut-bg1: #170f33;
  --tut-bg2: #2b1157;
  --tut-ink: #1a1533;
  --tut-paper: #fff6e3;
  --tut-pink: #ff3d8b;
  --tut-cyan: #29d6d6;
  --tut-yellow: #ffd23f;
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(ellipse at 50% -10%, #4b1d86 0%, transparent 55%),
    repeating-linear-gradient(0deg, transparent 0 46px, rgba(41, 214, 214, 0.07) 46px 47px),
    repeating-linear-gradient(90deg, transparent 0 46px, rgba(41, 214, 214, 0.07) 46px 47px),
    linear-gradient(180deg, var(--tut-bg1), var(--tut-bg2));
  color: var(--tut-paper);
  overflow: hidden;
}

.tut-scanlines {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.14) 0 1px, transparent 1px 3px);
  mix-blend-mode: multiply;
}

.tut-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: calc(0.6rem + env(safe-area-inset-top, 0px)) 0.9rem 0.4rem;
}

.tut-sys {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.14em;
  color: var(--tut-cyan);
  text-shadow: 0 0 8px rgba(41, 214, 214, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tut-exit {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 2px solid var(--tut-pink);
  border-radius: 8px;
  background: transparent;
  color: var(--tut-pink);
  font: inherit;
  font-weight: 800;
  cursor: pointer;
  box-shadow: 3px 3px 0 rgba(255, 61, 139, 0.35);
}

.tut-exit:hover {
  background: rgba(255, 61, 139, 0.15);
}

.tut-chapters {
  display: flex;
  gap: 0.35rem;
  padding: 0.2rem 0.9rem 0.5rem;
  overflow-x: auto;
  scrollbar-width: none;
}

.tut-chapters::-webkit-scrollbar {
  display: none;
}

.tut-chip {
  flex-shrink: 0;
  border: 2px solid rgba(255, 246, 227, 0.4);
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 246, 227, 0.75);
  font: inherit;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  padding: 0.24rem 0.7rem;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.tut-chip.active {
  border-color: var(--tut-yellow);
  color: var(--tut-yellow);
  box-shadow: 0 0 10px rgba(255, 210, 63, 0.4);
}

.tut-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.6rem 1rem calc(1.2rem + env(safe-area-inset-bottom, 0px));
  min-height: 0;
}

.tut-box {
  width: min(600px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--tut-paper);
  color: var(--tut-ink);
  border: 3px solid var(--tut-ink);
  border-radius: 10px;
  box-shadow:
    8px 8px 0 var(--tut-pink),
    16px 16px 0 rgba(41, 214, 214, 0.35);
  animation: tut-pop 0.22s ease-out;
}

@keyframes tut-pop {
  from {
    transform: translateY(10px) scale(0.98);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tut-box {
    animation: none;
  }
  .tut-cursor {
    animation: none;
  }
}

.tut-titlebar {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 0.8rem;
  border-bottom: 3px solid var(--tut-ink);
  background: repeating-linear-gradient(135deg, var(--tut-yellow) 0 10px, #ffc61a 10px 20px);
  border-radius: 7px 7px 0 0;
}

.tut-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 2px solid var(--tut-ink);
}

.tut-dot-r { background: var(--tut-pink); }
.tut-dot-y { background: var(--tut-paper); }
.tut-dot-g { background: var(--tut-cyan); }

.tut-tag {
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tut-progress {
  height: 8px;
  border-bottom: 3px solid var(--tut-ink);
  background: rgba(26, 21, 51, 0.12);
}

.tut-progress-fill {
  height: 100%;
  background: repeating-linear-gradient(90deg, var(--tut-pink) 0 12px, var(--tut-cyan) 12px 24px);
  transition: width 0.25s ease;
}

.tut-body {
  padding: 1.1rem 1.2rem 0.9rem;
  overflow-y: auto;
}

.tut-emoji {
  font-size: 2.6rem;
  line-height: 1;
  filter: drop-shadow(3px 3px 0 rgba(26, 21, 51, 0.2));
}

.tut-title {
  margin: 0.5rem 0 0.5rem;
  font-size: 1.35rem;
  font-weight: 900;
  letter-spacing: 0.01em;
  text-transform: uppercase;
}

.tut-cursor {
  display: inline-block;
  margin-left: 0.2rem;
  color: var(--tut-pink);
  animation: tut-blink 1.1s steps(1) infinite;
}

@keyframes tut-blink {
  50% {
    opacity: 0;
  }
}

.tut-text {
  margin: 0;
  font-size: 0.98rem;
  line-height: 1.55;
}

.tut-tip {
  margin: 0.8rem 0 0;
  padding: 0.55rem 0.7rem;
  border: 2px dashed var(--tut-ink);
  border-radius: 8px;
  background: rgba(41, 214, 214, 0.14);
  font-size: 0.88rem;
  font-weight: 600;
  line-height: 1.45;
}

.tut-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.7rem 0.9rem;
  border-top: 3px solid var(--tut-ink);
}

.tut-count {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}

.tut-btn {
  border: 3px solid var(--tut-ink);
  border-radius: 8px;
  font: inherit;
  font-weight: 900;
  font-size: 0.95rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.08s ease, box-shadow 0.08s ease;
}

.tut-btn:active:not(:disabled) {
  transform: translate(2px, 2px);
  box-shadow: none !important;
}

.tut-btn-ghost {
  background: var(--tut-paper);
  color: var(--tut-ink);
  box-shadow: 3px 3px 0 var(--tut-ink);
}

.tut-btn-ghost:disabled {
  opacity: 0.35;
  cursor: default;
  box-shadow: none;
}

.tut-btn-go {
  background: var(--tut-pink);
  color: #fff;
  box-shadow: 4px 4px 0 var(--tut-ink);
}

.tut-btn-go:hover {
  filter: brightness(1.06);
}
</style>
