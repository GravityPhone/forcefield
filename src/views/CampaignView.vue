<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'
import CampaignProgress from '@/components/CampaignProgress.vue'
import {
  CAMPAIGN_FACTS,
  CAMPAIGN_HEADLINE,
  CAMPAIGN_SECTIONS,
  DEMO_NOTICE,
  OBJECTIONS,
  TALKING_POINTS,
  THE_ASK,
} from '@/lib/campaignContent'

/** "The Campaign" — the one screen in the app that isn't about logging or
 * measuring anything: why the signatures are being gathered, and what to say
 * at the door. Every role gets it (it's the same briefing for everyone), and
 * it's a pure render of src/lib/campaignContent.ts — all copy edits happen
 * there. The live progress card at the bottom is the only dynamic part.
 *
 * The content ships as clearly-labeled placeholder while Forcefield is a demo;
 * the demo notice at the top says so in plain English. */
</script>

<template>
  <AppShell title="The Campaign">
    <div class="campaign-page">
      <!-- Demo notice first, so nobody reads the example copy below as a real
           campaign's position. Remove this card when real content lands. -->
      <div class="card demo-note">
        <h3>This is a demo</h3>
        <p v-for="(p, i) in DEMO_NOTICE" :key="i">{{ p }}</p>
      </div>

      <div class="card">
        <h2 class="headline">{{ CAMPAIGN_HEADLINE }}</h2>
        <section v-for="s in CAMPAIGN_SECTIONS" :key="s.heading" class="section">
          <h3>{{ s.heading }}</h3>
          <p v-for="(p, i) in s.body" :key="i">{{ p }}</p>
        </section>
      </div>

      <!-- The ask: pulled out on its own so it's findable in two seconds on a
           porch. -->
      <div class="card ask-card">
        <h3>The ask, at the door</h3>
        <blockquote class="ask">{{ THE_ASK }}</blockquote>
      </div>

      <div class="card">
        <h3>Talking points</h3>
        <p class="muted section-sub">Short versions, for the walk between doors.</p>
        <div class="points">
          <article v-for="p in TALKING_POINTS" :key="p.title" class="point">
            <h4>{{ p.title }}</h4>
            <p>{{ p.body }}</p>
          </article>
        </div>
      </div>

      <div class="card">
        <h3>If they say…</h3>
        <p class="muted section-sub">
          Answer once, kindly, then log the outcome and move on. Nobody signs because they
          lost an argument.
        </p>
        <dl class="objections">
          <template v-for="o in OBJECTIONS" :key="o.says">
            <dt>{{ o.says }}</dt>
            <dd>{{ o.reply }}</dd>
          </template>
        </dl>
      </div>

      <div class="card">
        <h3>Good to know</h3>
        <dl class="facts">
          <template v-for="f in CAMPAIGN_FACTS" :key="f.label">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value }}</dd>
          </template>
        </dl>
      </div>

      <!-- Where the campaign actually stands — the same live card the
           dashboard shows. -->
      <CampaignProgress />
    </div>
  </AppShell>
</template>

<style scoped>
.campaign-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 720px;
}

.campaign-page h2,
.campaign-page h3,
.campaign-page h4 {
  margin: 0;
}

.campaign-page p {
  margin: 0.5rem 0 0;
}

.headline {
  font-size: 1.3rem;
}

.section {
  margin-top: 1rem;
}

.section-sub {
  margin-top: 0.3rem;
  font-size: 0.9rem;
}

/* The demo notice reads as an aside, not as campaign copy. */
.demo-note {
  border-left: 4px solid var(--accent);
}

.demo-note h3 {
  color: var(--accent);
}

.ask {
  margin: 0.6rem 0 0;
  padding: 0.75rem 0.9rem;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 1.02rem;
  line-height: 1.5;
}

.points {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.6rem;
  margin-top: 0.7rem;
}

.point {
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.point h4 {
  font-size: 0.95rem;
}

.point p {
  margin-top: 0.35rem;
  font-size: 0.9rem;
}

.objections,
.facts {
  margin: 0.7rem 0 0;
}

.objections dt,
.facts dt {
  font-weight: 700;
}

.objections dt {
  margin-top: 0.8rem;
}

.objections dt:first-child,
.facts dt:first-child {
  margin-top: 0;
}

.objections dd {
  margin: 0.25rem 0 0;
}

/* Facts read as a two-column list on anything wider than a phone. */
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.45rem 0.9rem;
}

.facts dd {
  margin: 0;
}

@media (max-width: 480px) {
  .facts {
    display: block;
  }

  .facts dt {
    margin-top: 0.7rem;
  }

  .facts dd {
    margin-top: 0.15rem;
  }
}
</style>
