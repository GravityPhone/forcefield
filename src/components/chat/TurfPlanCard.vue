<script setup lang="ts">
/** Renders a ```turfplan block from the AI analyst as a tappable card.
 *
 * The assistant can't cut turf — this is a suggestion, and the card says so.
 * Tapping "Open in Turf" carries the plan over as a URL param; the cutter
 * pre-builds a draft from it and the human reviews, adjusts, and saves. Every
 * write still goes through the same Save button a hand-cut draft uses. */
import { useRouter } from 'vue-router'
import { encodeTurfPlan, planRangeLabel, type TurfPlanSpec } from '@/lib/turfPlan'

const props = defineProps<{ spec: TurfPlanSpec }>()
const router = useRouter()

function open() {
  void router.push({ path: '/turf', query: { plan: encodeTurfPlan(props.spec) } })
}
</script>

<template>
  <div class="plan-card">
    <div class="plan-head">
      <span class="plan-tag">Suggested turf</span>
      <h4 v-if="spec.name" class="plan-name">{{ spec.name }}</h4>
    </div>

    <p v-if="spec.note" class="plan-note">{{ spec.note }}</p>

    <ul class="plan-streets">
      <li v-for="(s, i) in spec.streets" :key="i">
        <span class="plan-street">{{ s.street }}</span>
        <span class="plan-range">{{ planRangeLabel(s) }}</span>
        <span v-if="s.city" class="plan-city">{{ s.city }}</span>
      </li>
    </ul>

    <button type="button" class="plan-open" @click="open">Open in Turf →</button>
    <p class="plan-foot">Opens a draft you can edit. Nothing is claimed until you save it.</p>
  </div>
</template>

<style scoped>
.plan-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  padding: 0.75rem;
  margin: 0.5rem 0;
}

.plan-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
}

.plan-tag {
  font-size: calc(0.7rem * var(--ui-scale));
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent);
}

.plan-name {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
}

.plan-note {
  margin: 0.35rem 0 0;
  font-size: 0.9rem;
  color: var(--muted);
}

.plan-streets {
  list-style: none;
  margin: 0.6rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.plan-streets li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.9rem;
}

.plan-street {
  font-weight: 600;
  color: var(--text);
}

.plan-range,
.plan-city {
  font-size: 0.82rem;
  color: var(--muted);
}

.plan-city::before {
  content: '·';
  margin-right: 0.4rem;
}

.plan-open {
  margin-top: 0.75rem;
  width: 100%;
  padding: 0.55rem 0.75rem;
  border: 0;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-ink, #fff);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.plan-open:active {
  transform: translateY(1px);
}

.plan-foot {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  color: var(--muted);
  text-align: center;
}
</style>
