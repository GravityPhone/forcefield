/**
 * "Campaign" page (/campaign, More menu, every role) — the why behind the
 * knocking, plus what to actually SAY at the door. (The switcher at the top of
 * that page is separate: which campaign you're on, see lib/campaigns.ts.)
 *
 * THE COPY HERE IS LOREM IPSUM ON PURPOSE (2026-07-24, user call). Forcefield
 * is a demo, and writing a plausible-sounding petition briefing meant shipping
 * pages of invented advocacy nobody asked for. So the page keeps its SHAPE —
 * the ask, the talking points, the facts box, the live progress card — and
 * fills it with the standard printer's placeholder, which is what a real
 * campaign would replace with its own words.
 *
 * When a real campaign takes this over: swap the strings below, add or remove
 * entries, and the view re-renders around them. Nothing in the app derives
 * behavior from this file.
 *
 * (Kept as a lib file, same as helpContent.ts, so copy edits never mean
 * touching a Vue component.)
 */

export interface TalkingPoint {
  /** The point in a handful of words — this is what a canvasser scans for. */
  title: string
  /** Say-it-out-loud version. */
  body: string
}

export interface CampaignFact {
  label: string
  value: string
}

/** The one-line identity of the drive, shown at the top of the page. */
export const CAMPAIGN_HEADLINE = 'Why we’re out here'

/** The plain-English "this is a demo" note — the one thing on this page that
 * is NOT placeholder, because it's the honest label on everything that is. */
export const DEMO_NOTICE =
  'Forcefield is a demo. This is where a campaign would say what the petition ' +
  'is for and how to talk about it — the text below is placeholder.'

/** The long-form "why", as placeholder prose. Deliberately headerless: it's a
 * short block of filler showing where a campaign's own words go, not a
 * structure worth naming sections in. */
export const CAMPAIGN_BODY: string[] = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
    'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis ' +
    'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu ' +
    'fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in ' +
    'culpa qui officia deserunt mollit anim id est laborum.',
]

/** The 15-second version, for the moment the door actually opens. */
export const THE_ASK =
  '“Lorem ipsum dolor sit amet, consectetur adipiscing elit — sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam?”'

/** Scannable points. A canvasser reads these on the walk between doors. */
export const TALKING_POINTS: TalkingPoint[] = [
  {
    title: 'Lorem ipsum',
    body: 'Dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.',
  },
  {
    title: 'Consectetur adipiscing',
    body: 'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.',
  },
  {
    title: 'Sed do eiusmod',
    body: 'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat.',
  },
  {
    title: 'Tempor incididunt',
    body: 'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt.',
  },
  {
    title: 'Ut labore et dolore',
    body: 'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.',
  },
  {
    title: 'Magna aliqua',
    body: 'Neque porro quisquam est qui dolorem ipsum quia dolor sit amet, consectetur.',
  },
]

/** The at-a-glance box: dates, rules, where things go. Example values — made
 * up, not instructions to go fill something in. */
export const CAMPAIGN_FACTS: CampaignFact[] = [
  { label: 'Who can sign', value: 'Registered voters in the county, one each' },
  { label: 'Filing deadline', value: 'September 12' },
  { label: 'Turning in sheets', value: 'Lorem ipsum dolor sit amet' },
  { label: 'Questions', value: 'Consectetur adipiscing elit' },
]
