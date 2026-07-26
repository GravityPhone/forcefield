<script setup lang="ts">
/**
 * The pace line: how long the campaign has left, and — where nothing else on
 * the screen already says it — how many signatures of the goal are in.
 * Shown wherever the goal is (2026-07-26): the progress card, and so the
 * leaderboard and Campaign page that render it, plus its own strip on the
 * activity feed.
 *
 * Purely presentational. Renders NOTHING when the campaign has no goal or no
 * deadline, rather than a row of dashes.
 */
import { computed } from 'vue'
import { daysUntil, daysLeftLabel, type CampaignPaceInput } from '@/lib/pace'

const props = defineProps<
  CampaignPaceInput & {
    /** One tight line, for riding above a feed rather than sitting in a card. */
    compact?: boolean
    /** Add the signature count. The progress card's goal bar already says it
     *  directly above this line; the feed's strip stands alone and needs it. */
    withTotals?: boolean
  }
>()

/** Null — and so nothing rendered — unless the campaign has both halves. */
const daysLeft = computed(() =>
  props.goal && props.goal > 0 ? daysUntil(props.deadline) : null,
)
</script>

<template>
  <div v-if="daysLeft !== null" class="pace" :class="{ compact }" data-help="campaign-pace">
    <span class="fact days" :class="{ gone: daysLeft <= 0 }">{{ daysLeftLabel(daysLeft) }}</span>
    <span v-if="withTotals && goal" class="fact">
      <strong>{{ signatures.toLocaleString() }}</strong> of {{ goal.toLocaleString() }} signatures
    </span>
  </div>
</template>

<style scoped>
.pace {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.2rem 0.5rem;
  min-width: 0;
  font-size: 0.85rem;
}

.days {
  font-weight: 700;
}

/* The one state nothing can be done about. */
.gone {
  color: var(--danger);
}

/* Middot between facts, never a leading one. */
.fact + .fact::before {
  content: '·';
  margin-right: 0.5rem;
  color: var(--text-muted);
}

.fact strong {
  font-weight: 800;
}

.compact {
  font-size: 0.8rem;
}
</style>
