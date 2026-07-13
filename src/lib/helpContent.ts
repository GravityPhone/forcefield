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
          'Hunt is the map — see nearby doors, find your turf, and tap a pin to open that ' +
          'address. Talk is the door screen — the household roster, past visits, notes, and ' +
          'the outcome buttons for logging the knock.',
      },
      {
        heading: 'Logging outcomes',
        body:
          'Signed, Didn’t Sign, and Maybe need a specific person picked from the roster. ' +
          'Not Home, Skip, and Hostile log against the whole household — no person needed.',
      },
      {
        heading: 'Pin colors',
        body:
          'Blue means nobody has knocked yet. Other colors show the door’s latest ' +
          'outcome — green is a signature. These colors never change with your theme.',
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
          'Green pins are doors already knocked, blue ones aren’t yet. Tap a door pin to ' +
          'open it in Talk mode. Tap a squadmate’s card to zoom to the last door they knocked.',
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
          'Your card’s accent color and your avatar are yours to pick — both live on the ' +
          'Appearance page.',
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
          'Whether the main board ranks signatures or doors knocked is a campaign setting; ' +
          'past days are browsable with the date picker.',
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
        heading: 'Avatar & color',
        body:
          'Your animal shows next to your chat messages and on member lists; your color tints ' +
          'your card and knock marker on the Squad page. Until you pick a color, one is ' +
          'assigned automatically.',
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
          'The campaign manager’s home base: campaign progress up top, with shortcuts to ' +
          'the bulletin, campaigns, user management, turf cutting, and data import.',
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
