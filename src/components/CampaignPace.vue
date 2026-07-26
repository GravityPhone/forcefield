<script setup lang="ts">
/**
 * The pace line: days left, signatures a day needed, and whether the campaign
 * is making that rate. Shown wherever the goal is (2026-07-26) — the progress
 * card, and so the leaderboard and Campaign page that render it, plus its own
 * strip on the activity feed.
 *
 * Purely presentational: every caller already knows the campaign's numbers,
 * or loads them through lib/pace.ts. Renders NOTHING when the campaign has no
 * goal or no deadline, rather than a row of dashes.
 */
import { computed } from 'vue'
import {
  campaignPace,
  daysLeftLabel,
  PACE_STATUS_LABELS,
  PACE_STATUS_TOKENS,
  type CampaignPaceInput,
} from '@/lib/pace'

const props = defineProps<
  CampaignPaceInput & {
    /** One tight line, for riding above a feed rather than sitting in a card. */
    compact?: boolean
  }
>()

const pace = computed(() =>
  campaignPace({
    signatures: props.signatures,
    goal: props.goal,
    deadline: props.deadline,
    signatures7d: props.signatures7d,
  }),
)
</script>

<template>
  <div
    v-if="pace"
    class="pace"
    :class="{ compact }"
    :style="{ '--pace-color': PACE_STATUS_TOKENS[pace.status] }"
    data-help="campaign-pace"
  >
    <span class="pace-chip">{{ PACE_STATUS_LABELS[pace.status] }}</span>
    <span class="pace-facts">
      <!-- Past the deadline the chip already says so, so the count stands
           down and what's left to collect takes its place. -->
      <span v-if="pace.daysLeft > 0" class="fact">{{ daysLeftLabel(pace.daysLeft) }}</span>
      <span v-if="pace.perDayNeeded > 0" class="fact">
        <strong>{{ pace.perDayNeeded.toLocaleString() }}</strong>/day needed
      </span>
      <span v-else-if="pace.remaining > 0" class="fact">
        <strong>{{ pace.remaining.toLocaleString() }}</strong> to go
      </span>
      <!-- The rate behind the verdict. Dropped when compact — the feed's strip
           is one line and the chip carries the answer. -->
      <span v-if="!compact && pace.remaining > 0" class="fact muted">
        now {{ Math.round(pace.recentPerDay).toLocaleString() }}/day
      </span>
    </span>
  </div>
</template>

<style scoped>
.pace {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem 0.55rem;
}

/* Mixed from the status token rather than set flat, so it reads on dark
   schemes too — same construction as .error in style.css. */
.pace-chip {
  flex-shrink: 0;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--pace-color) 38%, var(--surface));
  background: color-mix(in srgb, var(--pace-color) 14%, var(--surface));
  color: var(--pace-color);
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.pace-facts {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.2rem 0.5rem;
  min-width: 0;
  font-size: 0.85rem;
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

.compact .pace-facts {
  font-size: 0.8rem;
}

.compact .pace-chip {
  font-size: 0.7rem;
}
</style>
