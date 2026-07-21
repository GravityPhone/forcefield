/**
 * Per-screen help, shown from the "?" button in the app header (AppShell).
 * This is where explanatory copy lives INSTEAD of inline paragraphs on the
 * pages themselves — screens stay lean, the full story is one tap away.
 * Keyed by route path; screens without an entry simply don't show the button.
 */

export interface HelpSection {
  heading?: string
  body: string
}

export interface HelpTopic {
  title: string
  sections: HelpSection[]
}

export const HELP_TOPICS: Record<string, HelpTopic> = {
  '/canvass': {
    title: 'Canvassing',
    sections: [
      {
        heading: 'Two modes',
        body:
          'Scout is the map — see nearby doors, find your turf, and tap a pin to open that ' +
          'address. Talk is the door screen — the household roster, past visits, notes, and ' +
          'the outcome buttons for logging the knock. Flip back to Scout and it lands on the ' +
          'door Talk was working, with that street filled into the search below the map.',
      },
      {
        heading: 'Logging outcomes',
        body:
          'Signed, Didn’t Sign, and Maybe need a specific person picked from the roster. ' +
          'Not Home, Skip, and Hostile log against the whole household — no person needed. ' +
          'Right below the outcomes: Next moves you along the street per your walk pattern, ' +
          'and ‹ Back steps back through the doors YOU’ve knocked, newest first — ' +
          'neither needs an outcome logged first.',
      },
      {
        heading: 'Walking the street',
        body:
          'The walk pattern (direction, side of the street, partly-signed doors) drives ' +
          'the Up next grid at the bottom of the screen — the next four doors worth ' +
          'knocking, each with its status color. Tap one to jump straight to that door.',
      },
      {
        heading: 'Pin colors',
        body:
          'Blue means nobody has knocked yet. Green means everyone in the household ' +
          'signed. Yellow means take another look — someone signed but not everybody, ' +
          'or the door was a maybe. Red means done, don’t go back: didn’t sign, skip, ' +
          'or hostile. Gray is not home. If a yellow door’s remaining names look stale ' +
          '(people who moved away), log Skip to retire it. These colors never change ' +
          'with your theme.',
      },
      {
        heading: 'Spotty signal',
        body:
          'Knocks logged without signal queue on your phone and send themselves the moment ' +
          'you’re back online. Keep knocking.',
      },
    ],
  },

  '/squad': {
    title: 'Your squad',
    sections: [
      {
        heading: 'What a squad is',
        body:
          'Squads are today’s door-knocking crews — everyone in one shares a chat, this ' +
          'page, and turf. They reset at midnight, so start or join a fresh one each day.',
      },
      {
        heading: 'The map',
        body:
          'Door pins wear the same status colors as the Scout map — blue means nobody has ' +
          'knocked yet, green means everyone there signed, yellow means partly signed, red ' +
          'means a closed no. Doors knocked today also wear the knocker’s avatar, so the map ' +
          'doubles as a live picture of who covered what. Tap a door pin to open it in Talk ' +
          'mode. Tap a squadmate’s card to zoom to the last door they knocked. The Our turf / ' +
          'All turf buttons shade turf areas — just your crew’s ground, or the whole ' +
          'campaign’s cut (tap the lit one to turn shading off).',
      },
      {
        heading: 'Assign doors',
        body:
          'If you can split turf, tap "Assign doors" on a member’s card, tap door pins on ' +
          'the map (two taps take the whole stretch between them), and save — that member gets ' +
          'their own share of the turf in their color.',
      },
      {
        heading: 'Starting or joining',
        body:
          'No squad yet? Start one — name the crew, optionally add people, and a squad chat ' +
          'is created automatically. Anyone can also join an existing squad on their own.',
      },
      {
        heading: 'Cards and colors',
        body:
          'Your card’s accent color and your emoji are yours to pick — both live on the ' +
          'About me page.',
      },
    ],
  },

  '/squads': {
    title: 'Squads',
    sections: [
      {
        body:
          'Squads are today’s door-knocking crews — everyone in one shares a squad chat ' +
          'and shows up together on the leaderboard. They reset at midnight, so start a fresh ' +
          'one each day.',
      },
      {
        heading: 'Starting one',
        body:
          'Name the crew and optionally add people right away — anyone can also join on their ' +
          'own from this page. A squad chat is created automatically.',
      },
      {
        heading: 'Your own squad',
        body:
          'Squads you’re in sort to the top with an Open button — it goes to the full squad ' +
          'page: the turf map with live knock progress, member cards, door assignment, and ' +
          'leaving the crew.',
      },
    ],
  },

  '/activity': {
    title: 'Team feed',
    sections: [
      {
        body:
          'Live activity from the whole operation, today only, newest first — every ' +
          'signature as it lands (and every knock, if the campaign manager left those on). ' +
          'It resets each morning, like squads do.',
      },
      {
        heading: 'Milestones',
        body:
          'Along the way the feed celebrates progress: personal door counts (every 5 by ' +
          'default), squads heating up (doors and signatures for the day), and whole-team ' +
          'moments like passing 100 doors. Doors count once per household; signatures once ' +
          'per person. Campaign managers pick what shows and where the lines fall right ' +
          'here — the Feed options card at the top.',
      },
    ],
  },

  '/bulletin': {
    title: 'Bulletin',
    sections: [
      {
        body:
          'Announcements from leadership, newest first. Check here for meetup spots, turf ' +
          'plans, and anything else the whole team should see.',
      },
      {
        heading: 'Posting',
        body:
          'Campaign managers write announcements right on this screen — the composer at ' +
          'the top posts to everyone, and Delete retires stale ones.',
      },
    ],
  },

  '/leaderboard': {
    title: 'Leaderboard',
    sections: [
      {
        body:
          'Standings count knocks logged since midnight — canvassers and squads each get a ' +
          'board. Squads reset daily, so every morning is a clean slate.',
      },
      {
        body:
          'Whether the main board ranks signatures or doors knocked is a campaign setting — ' +
          'campaign managers set it right here in the Board options card. Past days are ' +
          'browsable with the date picker.',
      },
    ],
  },

  '/roster': {
    title: 'Team roster',
    sections: [
      {
        body:
          'Everyone on your team, leadership first. Tap a person to see their intro and ' +
          'the doors they’ve knocked lately.',
      },
      {
        heading: 'Calling teammates',
        body:
          'A Call button appears next to anyone who saved a phone number on their About me ' +
          'page — one tap opens your dialer. No number saved means no button, and numbers ' +
          'are only ever visible inside your own team.',
      },
    ],
  },

  '/history': {
    title: 'My knocks',
    sections: [
      {
        body:
          'Every door you’ve knocked, newest first — your own trail, for when you’re ' +
          'wondering "did I already hit that street?" Search by street or name, or filter ' +
          'to one outcome.',
      },
      {
        heading: 'Jump back to a door',
        body:
          'Tap any visit to open that door in Talk mode — handy for following up on a ' +
          'Maybe or a Not Home.',
      },
      {
        heading: 'Teammates',
        body:
          'Curious where someone else has been? Their recent knocks are on their Roster page.',
      },
    ],
  },

  '/profile': {
    title: 'About me',
    sections: [
      {
        body:
          'A short intro your teammates can read — it shows when someone opens your entry ' +
          'in the team roster. Every field is optional; fill in whatever feels right.',
      },
      {
        heading: 'Display name',
        body:
          'The name everyone sees next to you — chat, squad page, leaderboard, all of it. ' +
          'Handy if you go by a nickname. Leave it blank to show your username; your login ' +
          'name never changes either way.',
      },
      {
        heading: 'Pick my emoji',
        body:
          'Your emoji is your face on the squad map, in chat, and on member lists — 260+ to ' +
          'choose from, each with its name shown so the crew knows what to call you. Search ' +
          'by name (“dragon”, “taco”, “disco”) or browse the groups.',
      },
      {
        heading: 'Pick my color',
        body:
          'Your accent color tints your Squad-page card and map marker, your roster row, and ' +
          'your name in chat. Grab one from the team palette or mix your own — hue, punch, ' +
          'and brightness sliders, or type any hex code. Until you pick, one is assigned ' +
          'automatically.',
      },
      {
        heading: 'Phone number',
        body:
          'Save a number and teammates get a one-tap Call button next to your name on the ' +
          'roster and squad pages. Only people on YOUR team can ever see it — that’s enforced ' +
          'by the database, not just hidden. Leave it blank and no one can call you.',
      },
    ],
  },

  '/appearance': {
    title: 'Appearance',
    sections: [
      {
        body:
          'Everything here is purely cosmetic and only changes how the app looks on YOUR ' +
          'account. The knock-outcome buttons and map pins always keep their own fixed colors ' +
          'so they stay readable no matter what you choose. The High visibility schemes are ' +
          'built for hard conditions — glare, direct sunlight, tired eyes — with maximum ' +
          'contrast everywhere.',
      },
      {
        heading: 'Background flair',
        body:
          'Streaks, squiggles, and grids behind the page — drawn from your scheme’s own ' +
          'colors and kept faint enough to never fight the text. Weighs nothing, downloads nothing.',
      },
      {
        heading: 'Text & readability',
        body:
          'Sunlight boost pushes faint text up to near-full contrast for canvassing in direct ' +
          'sun. Text size scales the whole app. Fonts are system faces only — nothing to ' +
          'download, so nothing gets slower.',
      },
      {
        heading: 'Emoji & color',
        body:
          'Your personal emoji and accent color moved to the About me page — they’re part ' +
          'of who you are, not how the app looks.',
      },
    ],
  },

  '/turf': {
    title: 'Turf cutter',
    sections: [
      {
        heading: 'What cutting does',
        body:
          'Sweep street ranges on the map into a turf, then assign it to a squad or a single ' +
          'canvasser. Squads last one day but turf is durable — re-point it at today’s ' +
          'crew each morning ("Not out today" flags turf still aimed at a past day’s squad).',
      },
      {
        heading: 'Map gestures',
        body:
          'Tap two doors to take the whole walk between them — even around a corner. If both ' +
          'taps land on doors already in the draft, the stretch between them is erased instead. ' +
          'Hold a pin to add or remove just that door; double-tap a street name to take or drop ' +
          'the entire street. Undo steps back one gesture at a time.',
      },
      {
        heading: 'Reading the pins',
        body:
          'The fill color is the door’s knock status (blue = never knocked); the ring ' +
          'around it shows which turf it belongs to. No ring means unclaimed.',
      },
      {
        heading: 'Sub-turfs',
        body:
          'Squad leaders split their own assigned turf into per-member shares — easiest from ' +
          'the Squad page’s "Assign doors" mode. Re-dispatching a turf to a new squad ' +
          'dissolves yesterday’s splits back into the parent.',
      },
    ],
  },

  '/admin': {
    title: 'Dashboard',
    sections: [
      {
        body:
          'Org-level setup: role and team placement, campaigns, and (soon) the voter-data ' +
          'import. Everything day-to-day lives on its own screen now — post on the ' +
          'Bulletin, tune the boards and team feed from their pages, cut turf from the ' +
          'Turf tab.',
      },
    ],
  },

  '/admin/roles': {
    title: 'Roles',
    sections: [
      {
        heading: 'The roles',
        body:
          'Admin runs the org; Campaign Managers run the day-to-day (turf, squads, AI chat, ' +
          'settings); Squad Leaders and Canvassers knock doors. New sign-ups start as Canvasser.',
      },
      {
        heading: 'Placement',
        body:
          'Assign each person to a team here, and drop them into one of today’s squads. ' +
          'Squads form on the Squads page and reset at midnight. Admins belong to no campaign, ' +
          'team, or squad — they oversee, they don’t participate.',
      },
      {
        heading: 'Just looking for someone?',
        body:
          'This page is for changing roles and placement. To browse people — intros, recent ' +
          'knocks, phone numbers — use the Roster instead.',
      },
    ],
  },

  '/admin/campaigns': {
    title: 'Campaigns & teams',
    sections: [
      {
        body:
          'Campaigns are the big efforts your org runs; each team works exactly one campaign. ' +
          'Day-to-day crews (squads) aren’t managed here — they form themselves on the ' +
          'Squads page and reset daily.',
      },
    ],
  },

  '/admin/settings': {
    title: 'Settings',
    sections: [
      {
        heading: 'AI assistant key',
        body:
          'A shared demo key is already configured — the AI assistant works out of the box. ' +
          'Optionally save your own Anthropic API key; it follows your account across devices.',
      },
      {
        heading: 'Data sources',
        body:
          'Voter-roll CSV import and direct VAN/Minivan sync are both on the roadmap — ' +
          'addresses currently come from the imported county subset.',
      },
    ],
  },

  '/admin/chat': {
    title: 'AI assistant',
    sections: [
      {
        body:
          'Ask questions about the campaign in plain English — signatures by day, hot streets, ' +
          'canvasser pace. The assistant reads the live database directly (read-only, enforced ' +
          'at the database level) and can look up addresses on the map.',
      },
    ],
  },
}

export function helpFor(path: string): HelpTopic | null {
  return HELP_TOPICS[path] ?? null
}

/**
 * Per-TAB help for /admin/analytics. The Analytics view passes the active
 * tab's topic into AppShell (helpTopic prop), so the header "?" always
 * teaches the tab on screen. This is the ONLY place analytics gets explained
 * — chart subtitles stay at 2–3 word hints, never sentences. Written for
 * someone with a working-but-not-expert grasp of statistics: whiskers,
 * averages, and floors get plain-language treatment, and every hidden
 * interaction (tap a bar, tap a legend, day chips) is called out so the page
 * can be learned by poking at it.
 */
export const ANALYTICS_TAB_HELP: Record<string, HelpTopic> = {
  overview: {
    title: 'Overview tab',
    sections: [
      {
        heading: 'The tiles',
        body:
          'Campaign totals for the day window picked on the chips. Doors counts each ' +
          'household once no matter how many visits; knocks counts every attempt. Answer ' +
          'rate: of all knocks, how often anyone opened. Close rate: of all real ' +
          'conversations (signed, didn’t sign, or maybe), how many signed.',
      },
      {
        heading: 'The bold dashed line',
        body:
          'That’s the 7-day average — each point averages the last week, smoothing out ' +
          'weekend spikes and rainy Tuesdays so the real direction shows. Rising means the ' +
          'campaign is speeding up. It needs a week of history before it can start, so it ' +
          'skips the first six days of any window.',
      },
      {
        heading: 'Learn by poking',
        body:
          'The day chips re-cut every number on the tab. Tap a name in a chart’s legend to ' +
          'hide that line — the chart re-zooms to what’s left, which is the trick for ' +
          'reading a small line squeezed under a big one. Every chart has a Table button ' +
          'with the exact numbers behind the picture.',
      },
    ],
  },

  areas: {
    title: 'Areas tab',
    sections: [
      {
        heading: 'One question',
        body:
          'Which parts of the county deserve more knocking? Tap an area chip — or any bar — ' +
          'to zoom into one area: its own totals, daily trend, outcomes, plus the turfs and ' +
          'canvassers working it. Inside, tapping a turf or a canvasser jumps straight to ' +
          'their tab.',
      },
      {
        heading: 'Whiskers, plainly',
        body:
          'The thin line through a bar is a 95% confidence range: given how many knocks the ' +
          'area has, its TRUE rate very likely sits somewhere on that whisker. Short whisker ' +
          '= lots of data, trust the bar. Long whisker = small sample, could be luck. When ' +
          'two bars’ whiskers overlap a lot, don’t crown a winner.',
      },
      {
        heading: 'The dashed avg marker',
        body:
          'On rate charts, the dashed line is the whole campaign’s average — bars reaching ' +
          'past it are above-average ground, at a glance.',
      },
      {
        heading: 'Sign rate vs coverage',
        body:
          'Sign rate is signatures per conversation — how persuadable an area is. Coverage ' +
          'is the share of its doors knocked at least once — how much ground is left. High ' +
          'sign rate plus low coverage is where the next crew should go.',
      },
      {
        heading: 'Missing areas',
        body:
          'Areas with too few knocks are left off the rate charts on purpose — a 2-for-3 ' +
          'afternoon would chart like a jackpot. The Table button shows everything.',
      },
    ],
  },

  turfs: {
    title: 'Turfs tab',
    sections: [
      {
        heading: 'What counts here',
        body:
          'Every knock is stamped with the turf its door sat in at that moment, so history ' +
          'stays honest even after turf gets re-cut. Knocks at doors that weren’t in any ' +
          'turf gather in the "No turf" row of the table and stay off the charts — that ' +
          'bucket would dwarf the real bars.',
      },
      {
        heading: 'Coverage',
        body:
          'Doors knocked divided by the doors in the turf as it’s cut today. Whiskers on ' +
          'the rate chart are 95% confidence ranges — a long whisker means a small sample, ' +
          'so treat that bar as a rough guess.',
      },
      {
        heading: 'Dig in',
        body:
          'Tap any bar or table row to open one turf: its totals, daily signatures, the ' +
          'crews that worked it, and the canvassers who knocked it. Crews and canvassers in ' +
          'there are tappable too — the whole page cross-links.',
      },
    ],
  },

  squads: {
    title: 'Squads tab',
    sections: [
      {
        heading: 'Day crews',
        body:
          'A squad lives one day. But a crew that keeps the same name day after day ' +
          'accumulates here as one row — its whole run, not just today. Solo knocking with ' +
          'no squad that day lands in the table’s "No squad" row.',
      },
      {
        heading: 'The rates',
        body:
          'Close rate is signatures per conversation; answer rate is doors opened per ' +
          'knock. Whiskers are 95% confidence ranges — a hot-looking crew with a long ' +
          'whisker may just be a small sample having a good day.',
      },
      {
        heading: 'Dig in',
        body:
          'Tap a squad to see its run: signatures across the days it went out, the turf it ' +
          'worked, and its members ranked. Members and turf are tappable — jump to a ' +
          'person or a turf from right there.',
      },
    ],
  },

  odds: {
    title: 'Odds tab',
    sections: [
      {
        heading: 'Attempts',
        body:
          'Attempt 2 means a door’s second visit (knocks within ten minutes of each other ' +
          'count as one visit). Answer odds usually RISE with attempts — the people you ' +
          'catch on visit three are the ones nobody catches on visit one. That’s the case ' +
          'for going back. The dashed marker is the overall average, so you can see which ' +
          'attempts beat it.',
      },
      {
        heading: 'When doors answer',
        body:
          'The grid is answer rate by weekday and hour — darker means more doors opened. ' +
          'Tap a cell for its exact rate and how many knocks it’s based on. Cells with ' +
          'under 15 knocks stay blank rather than show noise.',
      },
      {
        heading: 'The funnel',
        body:
          'Unique doors surviving each stage: knocked → answered → conversation → signed. ' +
          'Each stage’s percentage is of the stage before it, so it points at exactly ' +
          'where doors fall out of the pipeline.',
      },
    ],
  },

  canvassers: {
    title: 'Canvassers tab',
    sections: [
      {
        heading: 'The dots',
        body:
          'Each dot is one canvasser: further right = more knocks, higher up = better ' +
          'close rate. The faint line is the team-wide trend — flat means knocking a lot ' +
          'doesn’t cost closing quality. Tap a dot (or an earner bar, or a table row) to ' +
          'open that person.',
      },
      {
        heading: 'Fair floors',
        body:
          'Dots only show for people with 20+ conversations — below that, one lucky ' +
          'afternoon charts like talent. The table has everyone regardless.',
      },
      {
        heading: 'One person’s page',
        body:
          'A canvasser’s view shows their daily signatures with the 7-day average, their ' +
          'outcome mix, and the turf and crews they worked — tap those to keep exploring.',
      },
    ],
  },
}
