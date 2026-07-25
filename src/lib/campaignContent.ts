/**
 * "The Campaign" page (/campaign, More menu, every role) — the why behind the
 * knocking, plus what to actually SAY at the door.
 *
 * EVERYTHING BELOW IS PLACEHOLDER COPY. Forcefield is a demo, so this file
 * ships with example content that reads like a real petition drive's briefing
 * without claiming to be one — the page itself says so at the top. When a real
 * campaign takes this over, the whole page is edited here: swap the strings,
 * add or remove entries, and the view re-renders around them. Nothing in the
 * app derives behavior from this content; it's read-only briefing material.
 *
 * (Kept as a lib file, same as tutorialContent.ts, so copy edits never mean
 * touching a Vue component.)
 */

export interface CampaignSection {
  heading: string
  /** Paragraphs. Kept as an array so a section can breathe without <br>s. */
  body: string[]
}

export interface TalkingPoint {
  /** The point in a handful of words — this is what a canvasser scans for. */
  title: string
  /** Say-it-out-loud version. Written the way someone actually talks. */
  body: string
}

export interface Objection {
  /** What the person at the door says. */
  says: string
  /** A calm, short answer. Never argue someone into signing. */
  reply: string
}

export interface CampaignFact {
  label: string
  value: string
}

/** The one-line identity of the drive, shown at the top of the page. */
export const CAMPAIGN_HEADLINE = 'Why we’re out here'

/** The plain-English "this is a demo" note. Deliberately the first thing on
 * the page — nobody should mistake the example copy below for a real position. */
export const DEMO_NOTICE = [
  'Forcefield is a demo app. This page is where a real campaign would explain, in ' +
    'its own words, what the petition is for and how to talk about it.',
  'Everything below is placeholder text written to show the shape of that briefing — ' +
    'the goal, the ask, some talking points, and answers for the usual pushback. ' +
    'It isn’t a real campaign’s position on anything.',
]

/** The long-form "why" — a couple of short sections, not an essay. */
export const CAMPAIGN_SECTIONS: CampaignSection[] = [
  {
    heading: 'What the petition does',
    body: [
      'Placeholder: this petition asks for a measure to be placed on the ballot so voters — ' +
        'not just officials — get to decide it directly.',
      'A signature is not a vote for the measure. It’s a signature saying the question ' +
        'deserves to be on the ballot. That distinction is the single most useful thing to ' +
        'know at a door, and it turns a lot of "I’m not sure" into a signature.',
    ],
  },
  {
    heading: 'Why the signatures have to be gathered in person',
    body: [
      'Placeholder: petition signatures have to be collected by hand, with a witness, ' +
        'inside a filing window. There’s no online shortcut — which is why a few hundred ' +
        'people walking streets is the entire strategy.',
      'That’s also why the numbers on the boards matter. Every door logged is a door ' +
        'nobody has to walk twice, and every signature is one closer to filing.',
    ],
  },
  {
    heading: 'How we talk to people',
    body: [
      'Placeholder: short, friendly, honest. Say who you are, say what you’re asking, ' +
        'and take a no gracefully — a bad conversation costs more than a missed signature.',
      'Nobody has to be argued into signing. If someone is genuinely opposed, thank them ' +
        'and move on. Log the outcome honestly either way; the map is only useful if it’s true.',
    ],
  },
]

/** The 15-second version, for the moment the door actually opens. */
export const THE_ASK =
  'Placeholder: “Hi, I’m {name} with the campaign — we’re collecting signatures to get ' +
  'this on the ballot so people here get to vote on it themselves. It takes about a ' +
  'minute and you just need to be a registered voter in the county. Would you sign?”'

/** Scannable points. A canvasser reads these on the walk between doors. */
export const TALKING_POINTS: TalkingPoint[] = [
  {
    title: 'Signing ≠ agreeing',
    body:
      'Placeholder: “Signing just puts it on the ballot — you can still vote however you ' +
      'want in November.” This one answers half the hesitation you’ll hear.',
  },
  {
    title: 'It’s local',
    body:
      'Placeholder: “This is a Union County question, decided by people who live here.” ' +
      'Ground it in the neighborhood you’re standing in, not in national politics.',
  },
  {
    title: 'It’s fast',
    body:
      'Placeholder: “About a minute — name, address, signature, date.” People say yes to ' +
      'a minute far more often than to a conversation.',
  },
  {
    title: 'Who can sign',
    body:
      'Placeholder: “Registered to vote in the county — one signature per person.” If ' +
      'they’re not sure they’re registered, they can still sign; it gets verified later.',
  },
  {
    title: 'Deadline is real',
    body:
      'Placeholder: “We file by the deadline or it waits another cycle.” Urgency that’s ' +
      'actually true is the only kind worth using.',
  },
  {
    title: 'What happens next',
    body:
      'Placeholder: “Signatures get verified, the measure goes on the ballot, everyone votes.” ' +
      'People like knowing where their signature ends up.',
  },
]

/** The pushback you'll hear, and a short answer for each. */
export const OBJECTIONS: Objection[] = [
  {
    says: '“I don’t sign things at my door.”',
    reply:
      'Placeholder: “Totally fair. Everything about it is public — take a flyer and look ' +
      'it up, and we’ll be back through the neighborhood this week.”',
  },
  {
    says: '“I don’t know enough about it.”',
    reply:
      'Placeholder: “That’s kind of the point — signing puts it on the ballot so you have ' +
      'until November to decide how to vote on it.”',
  },
  {
    says: '“Is this going to get me on a list?”',
    reply:
      'Placeholder: “The petition is a public record, same as voter registration. We’re ' +
      'not selling anything and nobody’s going to call you.”',
  },
  {
    says: '“I already signed.”',
    reply:
      'Placeholder: “Great — thank you! One per person is all we can count.” Log it and ' +
      'move on; double signatures get tossed in verification.',
  },
  {
    says: '“I disagree with it.”',
    reply:
      'Placeholder: “Appreciate you telling me straight. Have a good one.” Log it, don’t ' +
      'debate it, and go to the next door.',
  },
]

/** The at-a-glance box: dates, rules, where things go. */
export const CAMPAIGN_FACTS: CampaignFact[] = [
  { label: 'Who can sign', value: 'Placeholder — registered voters in the county, one each' },
  { label: 'Filing deadline', value: 'Placeholder — set this to the real date' },
  { label: 'Turning in sheets', value: 'Placeholder — where and when petition sheets go' },
  { label: 'Questions', value: 'Placeholder — who to ask, and how to reach them' },
]
