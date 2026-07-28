/**
 * Per-screen help, shown from the "?" button in the app header (AppShell).
 * This is where explanatory copy lives INSTEAD of inline paragraphs on the
 * pages themselves — screens stay lean, the reference is one tap away.
 * Keyed by route path; screens without an entry simply don't show the button.
 *
 * The "?" plays these as a WALKTHROUGH (HelpTour.vue): one section per step,
 * Next/Back, and each step can point at the control it's talking about — set
 * `target` to a key that some element in the view carries as
 * `data-help="<key>"`. The page dims around it and the thing gets a ring;
 * because the dim is four panels AROUND the target, the highlighted control
 * stays tappable while the tour is open. A target that isn't on screen (wrong
 * tab, role without that button) costs nothing: the step just shows as a
 * plain card. Sections are written to read fine either way.
 *
 * REGISTER (2026-07-25, user call): dry manual, not prose. Fragments over
 * sentences, no second person where a label will do, no rationale. The app
 * is meant to be intuitive enough that help is a reference, not a lesson.
 * Bodies render with `white-space: pre-line`, so `\n` is a real line break
 * and a step can be a short list. Anything that is purely a color mapping
 * goes in `swatches`, not in words.
 */

export interface HelpSwatch {
  /** Main fill. */
  fill: string
  /** Band inside the fill: the partly-signed green-with-yellow door. */
  band?: string
  /** Ring outside the dot — the "knocked today" halo. */
  halo?: string
  label: string
}

export interface HelpSection {
  heading?: string
  body: string
  /** Matches `data-help="<key>"` in the view. Optional, see above. */
  target?: string
  /** Color key, rendered as labelled dots under the body. */
  swatches?: HelpSwatch[]
}

export interface HelpTopic {
  title: string
  sections: HelpSection[]
}

/** The door-pin color model, identical on Scout, Squad and the cutter, so
 * it's written once and shown wherever doors are painted. Hexes mirror
 * outcomes.ts (fixed literals, never themed). */
const DOOR_COLORS: HelpSwatch[] = [
  { fill: '#2f6fed', label: 'Not knocked' },
  { fill: '#2e9e5b', label: 'Everyone signed' },
  { fill: '#2e9e5b', band: '#e0a02e', label: 'Some signed, names left' },
  { fill: '#e0a02e', label: 'Return, nobody signed yet' },
  { fill: '#d64545', label: 'Not interested, skip or hostile' },
  { fill: '#8a90a5', label: 'Not home' },
  { fill: '#2f6fed', halo: '#111111', label: 'Dark ring: knocked today' },
]

export const HELP_TOPICS: Record<string, HelpTopic> = {
  '/canvass': {
    title: 'Canvassing',
    sections: [
      {
        heading: 'Modes',
        target: 'canvass-tabs',
        body: 'Scout: the map.\nTalk: the door. Roster, past visits, outcome buttons.\nTap a pin in Scout to open that door in Talk.',
      },
      {
        heading: 'Outcomes',
        target: 'talk-outcomes',
        body: 'Signed: pick a person first.\nAll others: the person picked, or the household if none.\nReturn: offers a window to come back in, when the campaign has appointments on. Optional: close it and the knock still logged.',
      },
      {
        heading: 'Wants to volunteer',
        target: 'talk-volunteer',
        body: 'Marks the picked person as willing to knock doors. Press again to remove.\nNeeds a person picked, like Signed.\nYes only. Nothing is recorded for a no.\nThe list is under More → Volunteers, for managers.',
      },
      {
        heading: 'Their number',
        target: 'talk-volunteer-phone',
        body: 'A number to call them back on. Optional.\nSave to store it, blank and Save to take it back off.\nSeen by you and by managers, not by the rest of the org.\nGoes when the volunteer mark goes.',
      },
      {
        heading: 'Come back',
        target: 'talk-appointment',
        body: 'Somebody promised to be back at this door. Whoever is on the street can take it.\nThe whole list is under More → Appointments.',
      },
      {
        heading: 'Next and Back',
        target: 'talk-advance',
        body: 'Next: next door on the walk.\nBack: doors you knocked, newest first.\nNeither needs an outcome logged first.\nMy turf: limits both to your crew’s turf today. On by default.',
      },
      {
        heading: 'My doors',
        target: 'talk-mydoors',
        body: 'Every door your crew holds today, grouped by street.\nTap a street for its houses, then a house to open it.',
      },
      {
        heading: 'Up next',
        target: 'talk-upnext',
        body: 'The next four doors on the walk. Tap one to jump.',
      },
      {
        heading: 'Pin colors',
        target: 'scout-map',
        body: 'An avatar on a pin: who knocked it today.\nThese colors are fixed. Themes never change them.',
        swatches: DOOR_COLORS,
      },
      {
        heading: 'Layers',
        target: 'scout-layers',
        body: 'Nothing lit: every door, status colors.\nMy doors: only doors assigned to you.\nMy turf: your crew’s ground, splits included.\nAll turf: every turf in its own color. Tap a door to see which crew has it.\nCity: village limits.\nTap a lit button to clear it. My doors and My turf also fly there.',
      },
      {
        heading: 'Search',
        target: 'scout-search',
        body: 'Streets first, then people.\nTap a street for its houses in walk order. Tap a person for their door.\nTapping the map searches the street you touched.',
      },
      {
        heading: 'No signal',
        body: 'Knocks queue on the phone and send themselves when signal returns.\nYour crew’s doors, who lives at each, and recent visits are kept on the phone automatically. Nothing to press.\nAppointments need signal. Book those before you lose it.',
      },
    ],
  },

  '/squad': {
    title: 'Your squad',
    sections: [
      {
        target: 'squad-map',
        body: 'A squad is one day of crew: shared chat, page and turf. Resets at midnight.\nOne squad at a time. Leave and join another whenever.',
      },
      {
        heading: 'The map',
        target: 'squad-layers',
        body: 'Fill: knock status, same colors as Scout.\nAvatar: who knocked that door today.\nNothing lit: every door, status colors.\nOur turf: only our doors.\nAll turf: every turf in its own color.\nTap a door to open it in Talk.',
        swatches: DOOR_COLORS,
      },
      {
        heading: 'Progress',
        target: 'squad-progress',
        body: 'The bar counts turf doors knocked today. All time counts doors ever reached.\nOur doors: the same colors, counted out.',
      },
      {
        heading: 'Who has what',
        target: 'squad-owners',
        body: 'Our doors rings each door in its owner’s color and puts their face on the ones nobody has knocked. Today’s knocker takes the middle.',
      },
      {
        heading: 'The crew',
        target: 'squad-members',
        body: 'One tile per member: emoji, color, doors knocked, today’s doors.\nTap a tile for the sheet: assign, profile, show on map, call.',
      },
      {
        heading: 'Adding people',
        target: 'squad-add',
        body: 'Squad leaders and managers only.\nLeaders add people who aren’t out with another crew today. Managers can move anyone.\nRemove is in the member’s sheet.',
      },
      {
        heading: 'Assign doors',
        target: 'squad-assign',
        body: 'Pick a person, then pick doors:\n• tap pins one at a time\n• ◯ Lasso: drag a loop\n• ☝ Streets: tap a door for its whole street\nAdd and Erase set direction. Undo reverts one sweep. Save.',
      },
      {
        heading: 'Sharing where you are',
        target: 'squad-share',
        body: 'Off until you switch it on. Your squad only. Nobody else, ever.\nRuns while this app is open and in front. Not in a pocket, not with the screen off.\nGreen ring: a fresh position. Faded: over 5 minutes old. Gone after 20. The pin falls back to your last knocked door.\nBattery saver 3 min · Balanced 1 min · Precise 20 sec.\nSwitching off deletes your position.',
      },
      {
        heading: 'Claiming',
        target: 'squad-claim',
        body: 'Leaders and managers hand out doors.\n"Squad members claim their own doors" lets each member cut their own share instead. Off by default, resets at midnight.',
      },
      {
        heading: 'Start or join',
        target: 'squad-start',
        body: 'Name a crew, add people or let them join. A squad chat comes with it.',
      },
    ],
  },

  '/squads': {
    title: 'All squads',
    sections: [
      {
        target: 'squads-card',
        body: 'Every crew out today. They reset at midnight.\nYour own sorts to the top. Open goes to the full squad page.',
      },
      {
        heading: 'Assigning people',
        target: 'squads-add',
        body: 'Add people puts them on that crew and in its chat.\nAlready out with another crew: they move.\nRemove is on the squad page, in the member’s sheet.',
      },
      {
        heading: 'Starting one',
        target: 'squads-new',
        body: 'Name the crew. Add people now or let them join. Chat is created with it.',
      },
    ],
  },

  '/activity': {
    title: 'Team feed',
    sections: [
      {
        heading: 'Deadline',
        target: 'campaign-pace',
        body: 'Days left to the filing deadline, and signatures of the goal so far.\nBoth are set on Campaigns & Teams.',
      },
      {
        target: 'feed-list',
        body: 'Today’s activity across the whole operation, newest first. Resets each morning.\nTap a name for that person’s profile.',
      },
      {
        heading: 'Milestones',
        target: 'feed-options',
        body: 'Personal doors and knocks, squad doors, knocks and signatures, whole-team totals.\nDoors count once per household. Signatures count once per person. Knocks count every attempt.\nManagers set the steps here. Zero switches a step off.',
      },
    ],
  },

  '/bulletin': {
    title: 'Bulletin',
    sections: [
      { target: 'bulletin-post', body: 'Announcements from leadership, newest first.' },
      { target: 'bulletin-composer', body: 'Managers post and delete from this screen.' },
    ],
  },

  '/leaderboard': {
    title: 'Leaderboard',
    sections: [
      {
        target: 'board-canvassers',
        body: 'Standings since midnight. Canvassers and squads rank separately.\nYour own row is highlighted. The chip beside each heading gives your place and jumps to it.',
      },
      {
        target: 'board-options',
        body: 'Managers choose whether the main board ranks signatures or doors.',
      },
      {
        heading: 'Other days',
        target: 'board-history',
        body: 'All time: career. Today: the day so far. Date picker: any past day.',
      },
    ],
  },

  '/roster': {
    title: 'Team roster',
    sections: [
      {
        target: 'roster-list',
        body: 'Your team, leadership first. Tap a person for their intro and recent knocks.',
      },
      {
        target: 'roster-call',
        body: 'Call shows when someone saved a number. Numbers are visible to their own team only.',
      },
    ],
  },

  '/history': {
    title: 'My knocks',
    sections: [
      { target: 'knocks-search', body: 'Your own knocks, newest first. Search by street or name.' },
      { target: 'knocks-filters', body: 'Chips filter to one outcome and carry its count.' },
      {
        target: 'knocks-list',
        body: 'Tap a visit to reopen that door in Talk.\nFix: change the outcome or who it was about, or delete the knock. Twice to delete.\nYour own knocks only.',
      },
    ],
  },

  '/volunteers': {
    title: 'Volunteers',
    sections: [
      {
        target: 'volunteers-count',
        body: 'Signers marked with Talk’s Wants to volunteer button.\nYes only. A missing name means no answer or no, which read the same.',
      },
      {
        target: 'volunteers-list',
        body: 'Newest first. Name, where they signed, who asked, when.\nTap the asker for their profile.',
      },
      {
        target: 'volunteers-call',
        body: 'Dials the number the canvasser took down at the door.\nNo button means no number was taken.\nSearch matches digits too.',
      },
    ],
  },

  '/appointments': {
    title: 'Appointments',
    sections: [
      {
        target: 'appt-scope',
        body: 'Every "come back at X" promised at a door, by day.\nUpcoming: windows still open. Past: the last two weeks.\nMine only: the ones you booked.',
      },
      {
        target: 'appt-list',
        body: 'Tap a row to open that door in Talk. ✕ cancels it.\nKept: a knock landed inside the window. Missed: nobody went back.',
      },
    ],
  },

  '/profile': {
    title: 'About me',
    sections: [
      {
        target: 'profile-identity',
        body: 'Your intro, shown on your roster entry. Every field is optional.\nUnder your role: how long you have been knocking, counted from your first knock.',
      },
      {
        heading: 'Display name',
        target: 'profile-name',
        body: 'What everyone sees. Blank: your username. Your login never changes.',
      },
      {
        heading: 'Emoji',
        target: 'profile-emoji',
        body: 'Your face in chat, on maps, and in member lists. Search by name or browse the groups.',
      },
      {
        heading: 'Color',
        target: 'profile-color',
        body: 'Your accent on squad cards, map markers, roster rows and your name in chat. Team palette or any hex.',
      },
      {
        heading: 'Phone',
        target: 'profile-phone',
        body: 'A saved number gives teammates a Call button. Your team only, enforced by the database. Blank: no button.',
      },
    ],
  },

  '/appearance': {
    title: 'Appearance',
    sections: [
      {
        target: 'appearance-schemes',
        body: 'Cosmetic, and only on your account. Outcome buttons and map pins keep their fixed colors.',
      },
      {
        target: 'appearance-patterns',
        body: 'Background pattern, inked from the scheme’s own colors.',
      },
      {
        target: 'appearance-sunlight',
        body: 'Raises contrast on text, labels and outlines. On by default.',
      },
      {
        target: 'appearance-text',
        body: 'Text size scales the app. Tabs, map buttons and typing fields stay put.',
      },
      {
        target: 'appearance-font',
        body: 'Every row in the list is set in the face it names.\nSystem, Serif and Typewriter use fonts already on the phone. The rest download once, then stay cached.\nLegible is Atkinson Hyperlegible, drawn so I, l and 1 cannot be confused.',
      },
    ],
  },

  '/turf': {
    title: 'Turf cutter',
    sections: [
      {
        heading: 'Cutting',
        target: 'turf-create',
        body: '+ Create new turf, take streets, assign to a squad or one canvasser.\nSave and Start over sit under the map. Cancel is on the map, top right.\nThe bar at the top names the turf and counts its doors.\nTurf lasts. Squads do not: re-point turf at today’s crew each morning.',
      },
      {
        heading: 'Search, then add',
        target: 'turf-search',
        body: 'Type a street, tap a match to zoom, narrow the house numbers if needed, Add.',
      },
      {
        heading: 'Map tools',
        target: 'turf-tools',
        body: 'A turf only changes through a tool. Arm one first.\n◯ Lasso: drag a loop. Catches dots inside it or under the line. Tap a single dot for that one door.\n☝ Streets: tap a road to take or drop the whole street.\nAdd and Erase set direction, on the row underneath.\nTake shows while a tool is set to Add: sweeps pull doors out of whoever holds them, with no prompt. The old turf gives them up when you save.\nTake stays on until you turn it off, from its button or the red chip at the top. Doors already taken stay taken.\nUndo steps back one gesture.',
      },
      {
        heading: 'Streets',
        target: 'turf-streets',
        body: 'One line per street: name, door count. A red count means the range matched no doors.\nTap a street for the rest: its stretches, from and to, both/even/odd, and Remove street.\nAn open street is the map’s trim target: its doors paint, and a map tap drops or restores a house.',
      },
      {
        heading: 'Reading the map',
        target: 'turf-map',
        body: 'Every door shows from the moment the page opens, colored by knock status.\nThe Turf layer adds ownership on top: one ring per door, in its turf’s color. Same in overview and while cutting.\nOne turf, one color. Per member shares are a Squad page matter and don’t show here.\nThe turf being cut rings its doors in its own color.\nTap a door at any zoom for its turf, residents and recent knocks. Taps never move a door. That takes a tool.',
        swatches: DOOR_COLORS,
      },
      {
        heading: 'Selected turf',
        target: 'turf-selected',
        body: 'Its doors light up, haloed in the turf’s color.\nEdit opens it for cutting. ? shows crew, doors, streets and history.\n✕ clears the selection.',
      },
      {
        heading: 'Dispatch',
        target: 'turf-dispatch',
        body: 'Every turf out today, with the crew on it. Closed until you open it.\nTap a turf to change its crew, or to show it on the map.',
      },
      {
        heading: 'One turf at a time',
        target: 'turf-list',
        body: 'The picker lists whole turf. Per member shares are cut on the Squad page.\nTo see one person’s doors, open them from the roster and tap View their doors.\nCombine moves this turf’s doors into another and deletes this one.',
      },
    ],
  },

  '/admin': {
    title: 'Dashboard',
    sections: [
      {
        target: 'admin-cards',
        body: 'Admin only. Campaigns, the teams under them, and voter import.\nCampaign managers run one campaign and open on Analytics instead.',
      },
    ],
  },

  '/admin/roles': {
    title: 'Roles',
    sections: [
      {
        target: 'roles-filters',
        body: 'Admin: the whole server. Campaign Manager: one campaign, day to day. Squad Leader and Canvasser: doors.\nNew sign-ups start as Canvasser.',
      },
      {
        target: 'roles-list',
        body: 'Set team and today’s squad here. Admins belong to no campaign, team or squad.',
      },
      { target: 'roles-search', body: 'For intros, knocks and phone numbers, use the Roster.' },
    ],
  },

  '/admin/campaigns': {
    title: 'Campaigns and teams',
    sections: [
      { target: 'campaigns-list', body: 'Each team works exactly one campaign.' },
      { target: 'campaigns-teams', body: 'People land on a team from the Roles page.' },
    ],
  },

  '/admin/settings': {
    title: 'Settings',
    sections: [
      {
        target: 'settings-key',
        body: 'A shared demo key is already configured. Your own Anthropic key is optional and follows your account.',
      },
      {
        target: 'settings-sources',
        body: 'CSV import and VAN sync are not built. Addresses come from the imported county subset.',
      },
      {
        heading: 'Appointments',
        target: 'settings-appointments',
        body: 'Off by default, and off means absent: no follow-up on the Return button, no Appointments tab, no analytics tab.\nOn: that button offers a window to come back in.\nWindow: how long one runs. Hours: the span they are offered across.',
      },
    ],
  },

  '/admin/chat': {
    title: 'Assistant',
    sections: [
      {
        target: 'aichat-input',
        body: 'Ask in plain English. Read-only database access, enforced at the database.\nStreet names in an answer are links. They open the turf cutter on that street.',
      },
      { target: 'aichat-suggestions', body: 'Three follow-ups after each answer. Tap to send.' },
      {
        target: 'aichat-history',
        body: 'Chats are kept, and this is the list of them: yours only, newest first.\nTap one to reopen it. ✎ renames. ✕ twice deletes.',
      },
      { target: 'aichat-new', body: 'Empty chat. The one you were in stays in the list.' },
    ],
  },
}

export function helpFor(path: string): HelpTopic | null {
  return HELP_TOPICS[path] ?? null
}

/**
 * Per-TAB help for /admin/analytics. The Analytics view passes the active
 * tab's topic into AppShell (helpTopic prop), so the header "?" always
 * teaches the tab on screen. This is the ONLY place analytics gets explained:
 * chart subtitles stay at two or three word hints, never sentences.
 *
 * REGISTER, and it differs from the rest of this file (2026-07-26, user call:
 * "really clear, simple tutorials for all of these that doesn't assume
 * understanding of statistics… plain English instead of technical terms, but
 * have the plain English be technically correct, and maybe a little
 * technical"). So: still dry and still fragments, but every term that carries
 * a number gets DEFINED rather than assumed, and nothing is described in
 * words a stats class owns. "Whisker: how sure the number is" beats "95%
 * confidence interval", and it is not less true.
 *
 * The definitions below are load-bearing and repeat across tabs on purpose:
 * a walkthrough starts on whichever tab you're standing on, so a term left
 * defined only under Overview is a term most readers never meet.
 */

/** Written once because it appears on four tabs. A rate chart is the shape
 * this page uses most, and neither of these two marks is guessable. */
const READING_A_RATE =
  'Hold a bar for the numbers behind it.\nWhisker, the thin line through a bar: how sure the number is. Short means plenty of knocks behind it. Long means few, so treat it as a guess.\nTwo bars whose whiskers overlap are not really different.\nDashed line: the whole campaign, for comparison.'

/** How the cards themselves behave. Repeated on every tab, for the same reason
 * WHAT_COUNTS is: a walkthrough starts on whichever tab you are standing on. */
const FOLDING_CARDS = 'Tap a card heading to fold it away. It stays folded next time.'
const CARD_CONTROLS =
  'Two taps to open something. The first lights it up and shows its numbers, the second goes there. Tapping a different bar just moves the highlight.\n' +
  FOLDING_CARDS +
  '\nLong lists show the first 12. "Show all" opens the rest.'

/** The one paragraph the whole page rests on. */
const WHAT_COUNTS =
  'Knock: one logged visit. The same door twice is two knocks.\nDoor: one household, counted once however often it is knocked.\nInteraction: a knock that tried the door. Every outcome counts except Skip, Not Home included.\nConversation: an interaction somebody answered. Signed, Not Interested, Return and Hostile count. Not Home does not.'

export const ANALYTICS_TAB_HELP: Record<string, HelpTopic> = {
  overview: {
    title: 'Overview tab',
    sections: [
      {
        target: 'analytics-tabs',
        body: 'The same knocks, cut a few different ways. Each tab has its own help under this button.',
      },
      {
        heading: 'What counts as what',
        target: 'analytics-tiles',
        body: WHAT_COUNTS,
      },
      {
        heading: 'The two rates',
        target: 'analytics-tiles',
        body: 'Answer rate: out of 100 interactions, how many had somebody come to the door.\nSign rate: out of 100 conversations, how many signed.\nSo answer rate is how often you get a conversation. Sign rate is what you do with one.',
      },
      {
        heading: 'Setting the window',
        target: 'analytics-scope',
        body: 'The day chips re-cut every number on the tab. Every one of them counts back from today and includes today, so 3 days is today and the two days before it. All time is the whole campaign.\nCustom: a first and last day, both included. Leave one blank for no limit at that end.\nThe count on the right is how many knocks are in view.',
      },
      { heading: 'Folding cards away', target: 'overview-trend', body: FOLDING_CARDS },
      {
        heading: 'Reading a line chart',
        target: 'overview-trend',
        body: 'Hold anywhere on the chart for that day, every line at once.\nThe bold dashed line is the average of the last 7 days. It smooths out big Saturdays and quiet Tuesdays. It cannot start until there are 7 days, so the first six of any window are blank.\nTap a name in the legend to hide that line. The chart rescales to what is left.\nTable swaps any chart for the exact numbers.',
      },
    ],
  },

  // An "Areas tab" deck sat here until 2026-07-27. The tab went with it: the
  // demo canvasses one town, so every chart on it was a single bar. See the
  // note above ALL_TABS in AdminAnalyticsView.vue.

  turfs: {
    title: 'Turf tab',
    sections: [
      {
        heading: 'How turf is counted',
        target: 'turfs-table',
        body: 'Every knock is stamped with the turf it sat in at the time, so re cutting turf later never rewrites history.\nSub turf cut for one crew member counts under its parent turf.\n"No turf" is knocks on ground nobody had cut yet. Table only, since it would dwarf every real bar.',
      },
      { heading: 'What counts as what', target: 'turfs-rate', body: WHAT_COUNTS },
      { heading: 'Reading these charts', target: 'turfs-rate', body: READING_A_RATE },
      {
        heading: 'Coverage',
        target: 'turfs-coverage',
        body: 'Share of the doors currently in that turf knocked at least once.\nMeasured against the turf as it is cut today, so a turf re cut since is measured against its new size.',
      },
      {
        heading: 'Going deeper',
        target: 'turfs-rate',
        body: 'Open a bar or a table row for one turf on its own: which crews worked it, who knocked it, signatures by day.\n' +
          CARD_CONTROLS,
      },
    ],
  },

  squads: {
    title: 'Squads tab',
    sections: [
      {
        heading: 'How squads are counted',
        target: 'squads-table',
        body: 'A squad lasts one day, but a crew that goes out under the same name day after day adds up here as one row.\n"Days out" is how many days that name ran.\n"No squad" is somebody knocking on their own.',
      },
      { heading: 'What counts as what', target: 'squads-chart', body: WHAT_COUNTS },
      { heading: 'Reading these charts', target: 'squads-chart', body: READING_A_RATE },
      {
        heading: 'Going deeper',
        target: 'squads-table',
        body: 'Open a bar or a row for one crew: the turf it worked, its members, its signatures by day.\n' +
          CARD_CONTROLS,
      },
    ],
  },

  appointments: {
    title: 'Appointments tab',
    sections: [
      {
        heading: 'What each word means',
        target: 'appt-tiles',
        body: 'Kept: somebody knocked that door inside the promised window.\nBack late: somebody went back, after the window closed.\nMissed: nobody ever went back.\nStill to come: the window has not opened or closed yet.\nKept rate counts closed windows only. Something still to come cannot have been missed.',
      },
      {
        heading: 'Which windows work',
        target: 'appt-windows',
        body: 'Kept rate by time of day, in clock order. The window people actually get back to is the one worth offering.\n' +
          READING_A_RATE,
      },
      {
        heading: 'Where this comes from',
        target: 'appt-trend',
        body: 'None of it is recorded by anyone. Kept and missed are worked out by checking the knock history against each promised window.\nBooked runs into the future. Kept cannot.',
      },
      { heading: 'Getting around', target: 'appt-tiles', body: CARD_CONTROLS },
    ],
  },

  odds: {
    title: 'Odds tab',
    sections: [
      {
        heading: 'What this tab does',
        target: 'odds-scope',
        body: 'One box. Type a house, a street or a turf, and tap it. It works out what the NEXT knock there is likely to get.\nTwo numbers, always in this order: the chance somebody comes to the door, and the chance they sign once somebody does. Multiply them and you have the chance one knock ends in a signature.\nFor a set of doors it also gives a total: knock all of these once, expect about this many conversations and this many signatures.\nPlaces only, not people. What one canvasser should get is on the Canvassers tab, on the panel that opens when you tap somebody.\nType nothing and it shows the average door: every door in the campaign at once, which is what everything else here gets compared against.',
      },
      { heading: 'What counts as what', target: 'odds-scope', body: WHAT_COUNTS },
      {
        heading: 'A visit, not a knock',
        target: 'odds-scope',
        body: 'A visit is one trip to a door. Knocks there within ten minutes are one visit, so a couple both signing is one visit that signed, not two.\nEverything on this tab is per visit. "Visit 3" means the next trip would be the third.',
      },
      {
        heading: 'Where the number comes from',
        target: 'odds-why',
        body: 'Three steps, and the card lists them with the running estimate after each.\nStart: what the whole campaign has got at doors in the SAME situation. Which visit it would be, and whether anybody has ever answered there.\nThen the streets that connect to this one.\nThen this street itself.\nEach step moves the number by an amount set by how many knocks are behind it. Nine knocks move it barely at all. Two hundred move it a long way. Nothing is hand set: the campaign\'s own spread between streets decides.',
      },
      {
        heading: 'Which things move which number',
        target: 'odds-why',
        body: 'Whether somebody is HOME depends on the door\'s own history and the time of day. Not on the street: measured on this campaign, a street\'s answer rate does not carry to the next day once you take out the crew that walked it.\nWhether they SIGN depends on the street, and on very little else. Not the visit number, not how many people live there.\nSo a street with a good record raises the sign half and leaves the answer half alone. That is not a simplification, it is what the numbers do.',
      },
      {
        heading: 'Comparing it to something',
        target: 'odds-house',
        body: 'Every figure is shown against the campaign average, and a house also gets its place among every door still on the walk.\nIt only says above or below when the difference is bigger than the uncertainty. Otherwise it says about average, however different the two numbers look.',
      },
      {
        heading: 'The range',
        target: 'odds-house',
        body: 'How sure the RATE is, not what this one door will do. A door either answers or it does not.\n40% means four doors in ten, not a door that is 40% open.\nWide range means little evidence: a street nobody has knocked leans entirely on the campaign average, and the range says so.',
      },
      {
        heading: 'Totals over a set of doors',
        target: 'odds-set',
        body: 'Doors the walk would not send anybody back to are left out of the totals. That is why "137 doors" can be "84 still on the walk". The totals are about the 84.\nTwo different reasons a door is out, and only one of them is final. Everybody signed: nothing left to get. Not Interested, Skip or Hostile: a rule about the WALK, so nobody wastes a trip. That is not the same as the door being dead, and a single house says so when you open it.\n"The same doors, average ground" is what that many doors would be worth on an ordinary street. It is the comparison worth making before spending a morning.',
      },
      {
        heading: 'How much the neighbourhood counts',
        target: 'odds-near',
        body: 'A street with little record of its own borrows from the streets that connect to it. Two sliders set how much of that happens, and the numbers above them move as you drag.\nNeighbourhood reaches: how close a street has to come before it counts as connecting. Wider takes in more streets, and less relevant ones.\nHow much it counts: nothing at all, through to trusting a neighbour as much as the street itself.\nBoth start where the campaign\'s own data puts them, worked out by checking how well each street\'s record actually matches its neighbours\'. "Put them back" appears whenever they are off it, so a tuned number always says so.\nIf the numbers barely move, that is an answer. Either this ground has enough record of its own, or nobody has knocked near it and there is nothing to borrow.\nWhy these are sliders and not fixed numbers: smoothing a map towards its neighbours can create the smoothness it shows, and how you define a neighbour changes the answer as much as how much you weight one. Better to see how much rides on both than to bury the choice.',
      },
      {
        heading: 'Refusals spread',
        target: 'odds-why',
        body: 'A refusal at one door does predict refusals at its neighbours, and that is most of what the street line does.\nSign rate is signatures out of conversations, so every refusal drags a street down and that lowered rate is what the next door on it inherits.\nMeasured here, splitting each street\'s doors in half: streets where under a fifth of conversations refused saw the other half sign at 66%. Streets where over three fifths refused saw 34%.\nNearby streets carry a much weaker version of the same thing.\nWhat it is NOT: logging a refusal does not change the door. The knock recorded what was already true, and the model reads it as evidence about the ground, never as a penalty.',
      },
      {
        heading: 'When to go',
        target: 'odds-times',
        body: 'Two grids, weekday against weekend, by part of the day. Darker means better. Hold a square for its number and how many interactions are behind it.\nThe first is the chance somebody answers. The second is the chance a knock ends in a signature, which is the two chances multiplied.\nOnly answering moves with the clock. Signing, once somebody has answered, does not measurably change by time of day, so the second grid moves only because the first one does.\nA description of what the campaign has recorded, not advice: crews were not sent out at random times, so some of the gap is where they went and who was on.\nOn this campaign weekday mornings are the worst block by a wide margin and weekends are much the same all day.',
      },
      {
        heading: 'How much to trust it',
        target: 'odds-quality',
        body: 'Measured, not claimed, and measured across the whole campaign rather than its last week.\nIt walks forward: fit on everything before a day, predict that day, move on, refitting each week. So every knock in the test was scored by a model that had not seen it.\n"Picked the one that got a signature 53 times out of 100" is how often, given two knocks, it put the right one ahead. Fifty is a coin toss.\nThe table is the more useful half, and the better result: rows are equal-sized groups from the knocks it was least hopeful about to the ones it liked most. When it said 17%, 17 in 100 signed. That is what makes a total over a street worth having even though single doors are close to a coin toss.',
      },
      {
        heading: 'When not to trust it',
        target: 'odds-quality',
        body: 'Most doors have been knocked once or not at all, so for an ordinary house there is nothing specific to go on and every unknocked door on a street gets nearly the same number. Treat a single house as a reading of its street.\nIt is much better at totals than at single doors. Errors cancel over a hundred doors; they do not over one.\nDoors that answered before and are still on the list are mostly doors that asked us back, so that group flatters itself.\nMost of this history is simulated for the demo. The numbers are real arithmetic on it, and they will change when real knocks replace it.',
      },
      {
        heading: 'The day chips',
        target: 'analytics-scope',
        body: 'This tab has none. It reads every knock on record, because a door\'s odds are a fact about the door rather than about a window.',
      },
      { heading: 'Getting around', target: 'odds-streets', body: FOLDING_CARDS },
    ],
  },

  canvassers: {
    title: 'Canvassers tab',
    sections: [
      { heading: 'What counts as what', target: 'canvassers-table', body: WHAT_COUNTS },
      {
        heading: 'The dot chart',
        target: 'canvassers-scatter',
        body: 'One dot per canvasser. Further right: more knocks. Higher up: a better sign rate.\nTop right is both. Bottom right is somebody knocking plenty and closing little, which is usually a coaching conversation, not a numbers one.\nThe faint line is the campaign trend across everybody.\nOnly people with 20 or more conversations are plotted. Fewer than that and the dot would move on one good afternoon. The table has everyone.',
      },
      {
        heading: 'Going deeper',
        target: 'canvassers-table',
        body: 'Open a dot, a bar or a row for one person: signatures by day, what their knocks turned into, the turf and crews they worked.\n' +
          CARD_CONTROLS,
      },
      {
        heading: 'What they should get next',
        target: 'canvassers-projection',
        body: 'The bottom card on one person\'s panel. Everything above it is what they have already done; this is the one part that looks forward.\nTwo halves multiplied. How many doors they get through on a day out, from their own history. What a door on their ground is worth, from the odds model.\nA day OUT, not a calendar day. "A week" is how many days a week they have actually been going, not seven.\nThe typical day is their middle day and the range is their own middle half, so a rained-off evening and a full Saturday are both in there.\nWhich doors: turf assigned to them by name if there is any, else turf dispatched to a crew they were out with, else the doors they have knocked. The card says which one it used.\nIt is their observed pace, not a target, and nobody should be held to it.',
      },
      {
        heading: 'A fair reading',
        target: 'canvassers-scatter',
        body: 'Sign rate depends heavily on the ground. Somebody sent to a hostile street will trail somebody sent to a friendly one, whoever they are.\nCompare people against the turf they walked, on the Turf tab, before drawing conclusions.',
      },
    ],
  },
}
