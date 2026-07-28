<script setup lang="ts">
/**
 * What the next knock at this door is likely to get, for a campaign manager.
 *
 * ONE component, three homes: Talk's door card, Scout's located card, and the
 * turf cutter's house bubble. They ask the same question and a second copy
 * would drift, which is the lesson doorPaint and myTurf were both written for.
 *
 * A SMALL SQUARE BUTTON THAT OPENS A SHEET (2026-07-27, user call: "put the
 * odds in a little bit of a hidden away thing where you just kind of tap a
 * little square button that says odds, and it pulls everything up"). It shipped
 * for an hour as an inline block inside the door card and that was wrong twice
 * over: it put a planning number in the middle of the screen a canvasser reads
 * at a porch, and the two map surfaces have no room for a block at all. A chip
 * costs one line of chrome and the sheet has room to say the whole thing
 * properly. The chip reads "%" rather than the word Odds (2026-07-28, user
 * call) — the aria-label still says what it is.
 *
 * THE FIRST TAP PAYS FOR THE MODEL. It needs the whole knock history: see the
 * header of lib/oddsData.ts. Every door after that is instant, and a canvasser
 * who is not a manager never sees the button at all.
 *
 * WHY THE RANGE IS NEVER HIDDEN. Out of sample this model tells two doors apart
 * about 60 times in 100, which is real but modest, and for a door nobody has
 * knocked its whole content is what the street has done. A number without its
 * range would read as knowledge it does not have. The range is the honest part,
 * so it is the part that stays.
 */
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { doorOdds, type DoorOdds, type EvidenceStep } from '@/lib/odds'
import { ensureOddsModel, oddsError, oddsLoading, oddsModel, useOddsAllowed } from '@/lib/oddsData'

const props = defineProps<{
  /** Household id. Null renders nothing. */
  householdId: string | null
  /** The address, for the sheet's own heading. */
  label?: string
  /** Roster size, when the screen already knows it. Only used to tell a fully
   *  signed door from a partly signed one. */
  residents?: number
}>()

const allowed = useOddsAllowed()
const open = ref(false)

// Moving to another door closes the sheet: it is titled with an address, and a
// sheet that quietly starts describing a different house is worse than one that
// asks to be opened again.
watch(
  () => props.householdId,
  () => {
    open.value = false
  },
)

const odds = computed<DoorOdds | null>(() => {
  const m = oddsModel.value
  if (!m || !props.householdId || !open.value) return null
  return doorOdds(m, props.householdId, props.residents)
})

async function show() {
  open.value = true
  await ensureOddsModel()
}

const pct = (p: number) => `${Math.round(p * 100)}%`
const band = (e: { lo: number; hi: number }) =>
  `${Math.round(e.lo * 100)} to ${Math.round(e.hi * 100)}%`

/** "8 points above average", or that it is not really different. */
const versus = computed(() => {
  const v = odds.value?.vsCampaign?.signature
  if (!v || v.verdict === 'typical') return 'About average for the campaign'
  return `${Math.abs(Math.round(v.lift))} points ${v.verdict} the campaign average`
})

const steps = computed<EvidenceStep[]>(() =>
  odds.value ? [...odds.value.answerWhy, ...odds.value.signWhy] : [],
)

const bestTime = computed(() => odds.value?.bestTimes[0] ?? null)
</script>

<template>
  <template v-if="allowed && householdId">
    <button type="button" class="odds-chip" aria-label="Odds for this door" @click="show">
      %
    </button>

    <BottomSheet v-model:open="open" :title="label || 'Odds for this door'">
      <div class="odds-sheet">
        <p v-if="oddsLoading" class="muted odds-note">Reading the campaign…</p>
        <p v-else-if="oddsError" class="error odds-note">Couldn't work out the odds.</p>

        <template v-else-if="odds">
          <p v-if="odds.closed" class="odds-note">
            <strong>No next knock here.</strong><br />
            <span class="muted">{{ odds.closedNote }}</span>
          </p>

          <template v-else-if="odds.answer && odds.sign && odds.signature">
            <!-- The one number, then the two it is made of. -->
            <div class="hero">
              <span class="hero-value">{{ pct(odds.signature.p) }}</span>
              <span class="hero-label">chance this knock ends in a signature</span>
              <span class="muted hero-versus">{{ versus }}</span>
            </div>

            <div class="pair">
              <div class="stat">
                <span class="stat-value">{{ pct(odds.answer.p) }}</span>
                <span class="muted stat-label">somebody answers</span>
                <span class="muted stat-band">{{ band(odds.answer) }}</span>
              </div>
              <div class="stat">
                <span class="stat-value">{{ pct(odds.sign.p) }}</span>
                <span class="muted stat-label">they sign, if they answer</span>
                <span class="muted stat-band">{{ band(odds.sign) }}</span>
              </div>
            </div>

            <p v-if="bestTime" class="best-time">
              <span class="muted">Best time here</span>
              {{ bestTime.label.toLowerCase() }}, {{ bestTime.hours }}, at {{ pct(bestTime.p) }}
            </p>

            <h4 class="why-title">Where this comes from</h4>
            <ul class="why">
              <li v-for="(s, i) in steps" :key="i">
                <span class="why-row">
                  <span class="why-label">{{ s.label }}</span>
                  <span class="why-p">{{ pct(s.p) }}</span>
                </span>
                <span class="muted why-detail">{{ s.detail }}</span>
              </li>
            </ul>

            <RouterLink
              class="btn odds-more"
              :to="{ path: '/admin/analytics', query: { tab: 'odds', door: householdId } }"
            >
              Open on the Odds page
            </RouterLink>
          </template>
        </template>
      </div>
    </BottomSheet>
  </template>
</template>

<style scoped>
/* Tucked away: a small square chip, never an outcome color, sized so it sits
   on one line of existing chrome rather than claiming a row. */
.odds-chip {
  appearance: none;
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 30px;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.odds-chip:hover {
  color: var(--text);
  border-color: var(--accent);
}

.odds-sheet {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding-bottom: 0.5rem;
}
.odds-note {
  margin: 0;
  font-size: 0.9rem;
}
.error {
  color: var(--danger);
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  padding: 1rem 0 0.6rem;
}
.hero-value {
  font-size: 3rem;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.hero-label {
  font-size: 0.85rem;
  text-align: center;
}
.hero-versus {
  font-size: 0.75rem;
}

.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.stat-value {
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 0.75rem;
}
.stat-band {
  font-size: 0.68rem;
}

.best-time {
  margin: 0;
  font-size: 0.85rem;
}
.best-time .muted {
  margin-right: 0.35rem;
}

.why-title {
  margin: 0.2rem 0 0;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.why {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.why-row {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.why-label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.85rem;
  font-weight: 600;
}
.why-p {
  flex: 0 0 auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.why-detail {
  display: block;
  font-size: 0.75rem;
}

.odds-more {
  display: block;
  text-align: center;
  text-decoration: none;
  margin-top: 0.2rem;
}
</style>
