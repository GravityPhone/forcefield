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
        body: 'Signed: pick a person first.\nAll others: the person picked, or the household if none.\nReturn: offers a window to come back in, when the campaign has appointments on. Optional — close it and the knock still logged.',
      },
      {
        heading: 'Wants to volunteer',
        target: 'talk-volunteer',
        body: 'Marks the picked person as willing to knock doors. Press again to remove.\nNeeds a person picked, like Signed.\nYes only — nothing is recorded for a no.\nThe list is under More → Volunteers, for managers.',
      },
      {
        heading: 'Someone else',
        target: 'talk-roll',
        body: 'Searches the whole county roll, not just this door.\nFor the spouse, the adult kid, the new tenant — anyone the roster missed.\nRegistered at another address: their signature counts for that address, and this door still records the visit.\nNobody can be added to the roll from here.',
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
        body: 'Every door your crew holds today, grouped by street.\nType letters to filter streets. Type digits to find a house number.\nTap a house to open it.',
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
        body: 'Knocks queue on the phone and send themselves when signal returns.',
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
        heading: 'Going offline',
        target: 'squad-offline',
        body: 'Downloads the crew’s doors, who lives at each, and recent visits.\nA door in a dead zone then opens for real instead of blank.\nKnocks already queue offline on their own. Appointments do not — book those with signal.\nSave again to refresh. Clear drops it.',
      },
      {
        heading: 'Sharing where you are',
        target: 'squad-share',
        body: 'Off until you switch it on. Your squad only — nobody else, ever.\nRuns while this app is open and in front. Not in a pocket, not with the screen off.\nGreen ring: a fresh position. Faded: over 5 minutes old. Gone after 20 — the pin falls back to your last knocked door.\nBattery saver 3 min · Balanced 1 min · Precise 20 sec.\nSwitching off deletes your position.',
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
        body: 'Signers marked with Talk’s Wants to volunteer button.\nYes only — a missing name means no answer or no, which read the same.',
      },
      {
        target: 'volunteers-list',
        body: 'Newest first. Name, where they signed, who asked, when.\nTap the asker for their profile.',
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
        body: 'Text size scales the app. Tabs, map buttons and typing fields stay put.\nEach font card is drawn in its own face. All of them ship with the device, so nothing downloads.',
      },
    ],
  },

  '/turf': {
    title: 'Turf cutter',
    sections: [
      {
        heading: 'Cutting',
        target: 'turf-create',
        body: '+ Create new turf, take streets, assign to a squad or one canvasser.\nSave, Start over and Cancel sit under the map. The bar at the top names the turf and counts its doors.\nTurf lasts. Squads do not: re-point turf at today’s crew each morning.',
      },
      {
        heading: 'Search, then add',
        target: 'turf-search',
        body: 'Type a street, tap a match to zoom, narrow the house numbers if needed, Add.',
      },
      {
        heading: 'Map tools',
        target: 'turf-tools',
        body: 'A turf only changes through a tool. Arm one first.\n◯ Lasso: drag a loop — catches dots inside it or under the line. Tap a single dot for that one door.\n☝ Streets: tap a road to take or drop the whole street.\nAdd and Erase set direction, on the row underneath.\nTake shows while a tool is set to Add: sweeps pull doors out of whoever holds them, with no prompt. The old turf gives them up when you save.\nTake stays on until you turn it off, from its button or the red chip at the top. Doors already taken stay taken.\nUndo steps back one gesture.',
      },
      {
        heading: 'Streets',
        target: 'turf-streets',
        body: 'One line per street: name, door count. A red count means the range matched no doors.\nTap a street for the rest — its stretches, from and to, both/even/odd, and Remove street.\nAn open street is the map’s trim target: its doors paint, and a map tap drops or restores a house.',
      },
      {
        heading: 'Reading the map',
        target: 'turf-map',
        body: 'Every door shows from the moment the page opens, colored by knock status.\nThe Turf layer adds ownership on top: one ring per door, in its turf’s color. Same in overview and while cutting.\nOne turf, one color — per-member shares are a Squad page matter and don’t show here.\nThe turf being cut rings its doors in its own color.\nTap a door at any zoom for its turf, residents and recent knocks. Taps never move a door — that takes a tool.',
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
        body: 'Every turf out today, with the crew on it. Change the crew from the row.\nTap a name to zoom the map to it. Tap it again to scroll up to the map.',
      },
      {
        heading: 'One turf at a time',
        target: 'turf-list',
        body: 'The picker lists whole turfs. Per-member shares are cut on the Squad page.\nTo see one person’s doors, open them from the roster and tap View their doors.\nCombine moves this turf’s doors into another and deletes this one.',
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
    title: 'AI assistant',
    sections: [
      {
        target: 'aichat-input',
        body: 'Ask in plain English. Read-only database access, enforced at the database.\nStreet names in an answer are links. They open the turf cutter on that street.',
      },
      { target: 'aichat-suggestions', body: 'Three follow-ups after each answer. Tap to send.' },
      {
        target: 'aichat-history',
        body: 'Chats are kept, and this is the list of them — yours only, newest first.\nTap one to reopen it. ✎ renames. ✕ twice deletes.',
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
 * chart subtitles stay at two or three word hints, never sentences. Same dry
 * register as above, definitions and interactions, no coaching.
 */
export const ANALYTICS_TAB_HELP: Record<string, HelpTopic> = {
  overview: {
    title: 'Overview tab',
    sections: [
      {
        target: 'analytics-tabs',
        body: 'Six cuts of the same knocks. Every tab carries its own help.',
      },
      {
        heading: 'Tiles',
        target: 'analytics-tiles',
        body: 'Doors: households, counted once.\nKnocks: every attempt.\nAnswer rate: knocks that opened.\nClose rate: conversations that signed.',
      },
      {
        heading: 'Bold dashed line',
        target: 'overview-trend',
        body: '7-day average. Needs a week of history, so it starts six days into any window.',
      },
      {
        heading: 'Interactions',
        target: 'analytics-scope',
        body: 'Day chips re-cut the tab.\nTap a legend name to hide that series. The chart re-scales.\nTable: the exact numbers.',
      },
    ],
  },

  areas: {
    title: 'Areas tab',
    sections: [
      {
        target: 'analytics-areachips',
        body: 'Tap a chip or a bar to focus one area. Turfs and canvassers inside link to their own tabs.',
      },
      {
        heading: 'Whiskers and marker',
        target: 'areas-rate',
        body: 'Whisker: 95% confidence range. Long whisker means a small sample.\nDashed line: campaign average.\nAreas below the knock floor are off the charts, on the table.',
      },
      {
        heading: 'The two rates',
        target: 'areas-coverage',
        body: 'Sign rate: signatures ÷ conversations.\nCoverage: doors knocked ÷ doors in the area.',
      },
    ],
  },

  turfs: {
    title: 'Turfs tab',
    sections: [
      {
        target: 'turfs-table',
        body: 'Each knock is stamped with the turf it sat in at the time. "No turf" is table-only.',
      },
      {
        target: 'turfs-coverage',
        body: 'Coverage: doors knocked ÷ doors in the turf as cut today.\nWhiskers are 95% confidence ranges.',
      },
      {
        target: 'turfs-rate',
        body: 'Tap a bar or row for one turf: crews, canvassers, daily signatures.',
      },
    ],
  },

  squads: {
    title: 'Squads tab',
    sections: [
      {
        target: 'squads-table',
        body: 'One row per squad name, across every day it ran. "No squad" means solo knocking.\nTap a row for its run, turf and members.',
      },
      {
        target: 'squads-chart',
        body: 'Close rate: signatures ÷ conversations.\nAnswer rate: opens ÷ knocks.\nWhiskers are 95% confidence ranges.',
      },
    ],
  },

  appointments: {
    title: 'Appointments tab',
    sections: [
      {
        target: 'appt-tiles',
        body: 'Kept: a knock landed at that door inside its window.\nBack late: the return came after the window closed.\nMissed: nobody ever went back.\nKept rate counts closed windows only — what is still to come can’t be missed yet.',
      },
      {
        target: 'appt-windows',
        body: 'Kept rate by time of day, in clock order. Whisker: 95% confidence range. Dashed line: overall kept rate.',
      },
      {
        target: 'appt-trend',
        body: 'Booked runs into the future; kept can’t. Nothing here is stored — it is read off the knock history.',
      },
    ],
  },

  odds: {
    title: 'Odds tab',
    sections: [
      {
        target: 'odds-attempts',
        body: 'Attempt N: the door’s Nth visit. Knocks within ten minutes count as one.\nAnswer odds usually rise with attempts. Dashed line: overall average.',
      },
      {
        target: 'odds-heatmap',
        body: 'Answer rate by weekday and hour. Tap a cell for its rate and sample size. Under 15 knocks: blank.',
      },
      {
        target: 'odds-funnel',
        body: 'Unique doors per stage: knocked, answered, conversation, signed. Each percentage is of the stage before it.',
      },
    ],
  },

  canvassers: {
    title: 'Canvassers tab',
    sections: [
      {
        target: 'canvassers-scatter',
        body: 'One dot per canvasser. Right: more knocks. Up: better close rate.\nFaint line: team trend. Floor: 20 or more conversations. The table has everyone.',
      },
      {
        target: 'canvassers-table',
        body: 'Tap a dot, bar or row for one person: daily signatures, outcome mix, turf and crews.',
      },
    ],
  },
}
