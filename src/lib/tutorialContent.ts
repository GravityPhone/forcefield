/** The click-through app tour (/tutorial, reachable from More). One linear
 * deck for everyone: it starts with the basics every canvasser needs and
 * climbs to squad-leader and campaign-manager tools — because this is a
 * demo, anyone can keep tapping Next through all of it (and the header's
 * role badge lets them actually try each role). Copy rules: user-facing
 * names only ("Scout", "Squad Leader", "Leaders"), plain English, one idea
 * per card. */

export interface TutorialStep {
  emoji: string
  title: string
  body: string
  /** Optional one-line pro tip rendered below the body. */
  tip?: string
}

export interface TutorialChapter {
  id: string
  /** Short chip label ("Basics", "Managers"). */
  label: string
  /** Who this chapter is for — shown on the card's chapter tag. */
  audience: string
  steps: TutorialStep[]
}

export const TUTORIAL_CHAPTERS: TutorialChapter[] = [
  {
    id: 'welcome',
    label: 'Welcome',
    audience: 'Everyone',
    steps: [
      {
        emoji: '⚡',
        title: 'Welcome to Forcefield',
        body:
          'Forcefield is a door-to-door canvassing app. This demo runs a petition campaign for ' +
          'Universal Basic Income in Union County, Ohio — the goal is 8,000 signatures. ' +
          'Every knock, squad, and person you\'ll see is simulated demo data, so poke anything.',
        tip: 'This tour walks the whole app, simple to advanced. Just keep hitting Next.',
      },
      {
        emoji: '💡',
        title: 'The big idea',
        body:
          'One screen to log a knock in seconds while standing on a porch. Live maps so the team ' +
          'sees the ground move. Chat, a live activity feed, and leaderboards to keep it fun. ' +
          'And an AI analyst that answers the managers\' questions straight from the data.',
      },
      {
        emoji: '🎭',
        title: 'Four roles',
        body:
          'Canvassers knock doors. Squad Leaders run a day\'s crew and split doors among it. ' +
          'Campaign Managers cut turf, dispatch crews, and watch the numbers. Admins just manage ' +
          'accounts. Because this is a demo, the role badge in the top-right corner is a button — ' +
          'tap it to switch roles whenever you like.',
        tip: 'Everything in this tour is tappable in the app right after you finish.',
      },
      {
        emoji: '🧭',
        title: 'Finding your way',
        body:
          'On a phone, the tabs live along the bottom and the rest sits behind More. On a bigger ' +
          'screen they\'re along the top. Every screen has a "?" in the header that explains ' +
          'exactly what you\'re looking at — and the handle on the right edge pulls out team chat ' +
          'from anywhere.',
      },
    ],
  },
  {
    id: 'canvassing',
    label: 'Canvassing',
    audience: 'Everyone who knocks',
    steps: [
      {
        emoji: '🗺️',
        title: 'Canvass: Talk & Scout',
        body:
          'The Canvass tab is where the work happens, in two modes. Talk is the door you\'re ' +
          'standing at — the household, its people, and the outcome buttons. Scout is the map of ' +
          'every door. Flip between them freely; Scout even follows along to the street you\'re ' +
          'working in Talk.',
      },
      {
        emoji: '📍',
        title: 'Scout: read the map',
        body:
          'Every door is a pin colored by status: blue = never knocked, gray = nobody home yet, ' +
          'green = everyone there signed, yellow = somebody (but not everybody) signed, red = a ' +
          'no, a skip, or a hostile door. Zoomed out, pins collapse into density dots — tap one ' +
          'to dive in.',
        tip: '"Zoom to my turf" frames your assignment; the shading toggles show how the ground is cut.',
      },
      {
        emoji: '🚪',
        title: 'Talk: log a knock',
        body:
          'Pick a door in Scout (or search it), and Talk shows everyone who lives there. ' +
          'Signed, Didn\'t sign, and Maybe attach to a specific person — tap the person, then the ' +
          'outcome. Not home, Skip, and Hostile log against the whole door. Tapped the wrong ' +
          'thing? Tap it again to undo.',
      },
      {
        emoji: '👟',
        title: 'Keep walking',
        body:
          'Under the outcome buttons, Back and Next walk the street for you — Next moves to the ' +
          'right next door based on your walking preferences, Back retraces your own steps. The ' +
          '"Up next" grid at the bottom previews the next four doors so you can plan the block.',
        tip: 'No signal? Knocks queue on the phone and send themselves when coverage returns.',
      },
      {
        emoji: '📜',
        title: 'Every door remembers',
        body:
          'Talk shows the door\'s full visit history — who knocked, when, and how it went — so ' +
          'you never re-ask a fresh "no". Your own trail lives under More → My knocks: search ' +
          'it, filter it, and tap any row to jump straight back to that door.',
      },
    ],
  },
  {
    id: 'team',
    label: 'Team life',
    audience: 'Everyone',
    steps: [
      {
        emoji: '👥',
        title: 'Your squad',
        body:
          'Squads are day crews — they form in the morning and dissolve at midnight. The Squad ' +
          'page shows your crewmates\' cards, a live map of the squad\'s turf with door-status ' +
          'colors, and a running feed of the crew\'s knocks. Doors a squadmate knocked today wear ' +
          'their emoji on the pin.',
      },
      {
        emoji: '📣',
        title: 'Feed & Bulletin',
        body:
          'The Feed tab is the whole organization\'s day, live — knocks and signatures as they ' +
          'happen, plus milestone moments ("Field Ops just hit 100 doors!"). The Bulletin is ' +
          'where campaign managers post announcements everyone should read.',
      },
      {
        emoji: '🏆',
        title: 'Leaders',
        body:
          'The Leaders tab ranks canvassers and squads — by signatures or by doors, whichever ' +
          'the managers choose. Friendly rivalry moves petitions. Where you rank updates live as ' +
          'knocks come in.',
      },
      {
        emoji: '💬',
        title: 'Chat',
        body:
          'Pull the handle on the right edge of any screen: team rooms, your squad\'s room, ' +
          'and direct messages. Names show in each member\'s personal color, and a phone number ' +
          'on file becomes a call button.',
      },
      {
        emoji: '🎨',
        title: 'Make it yours',
        body:
          'About me holds your nickname, emoji, accent color, bio, and phone number — your color ' +
          'and emoji follow you onto squad cards, map pins, and chat. Appearance has 18 color ' +
          'schemes, background patterns, fonts, and a sunlight mode you can actually read on a ' +
          'bright porch.',
      },
    ],
  },
  {
    id: 'leaders',
    label: 'Squad Leaders',
    audience: 'Squad Leaders',
    steps: [
      {
        emoji: '🧢',
        title: 'Run the day crew',
        body:
          'A Squad Leader is a canvasser with a clipboard: you knock doors like everyone else, ' +
          'plus you form the day\'s squad and keep it moving. Create or join squads right on the ' +
          'Squad page — every squad gets its own chat room automatically.',
      },
      {
        emoji: '✂️',
        title: 'Assign doors',
        body:
          'On the Squad page, tap "Assign doors" on a member\'s card, then tap door pins on the ' +
          'map and save — that member gets their own named slice of the squad\'s turf, in their ' +
          'color. Tap door A then door B to sweep the whole stretch between them in two taps.',
        tip: 'Doors already assigned to a squadmate move over automatically — no double-covering a street.',
      },
    ],
  },
  {
    id: 'managers',
    label: 'Managers',
    audience: 'Campaign Managers',
    steps: [
      {
        emoji: '🎛️',
        title: 'The command center',
        body:
          'Campaign Managers get the full kit: a Dashboard for org setup (roles, campaigns & ' +
          'teams, voter import), plus Turf, Squads, Analytics, and the AI analyst. Day-to-day ' +
          'controls live on the screens they affect — leaderboard options on Leaders, feed ' +
          'options on Feed, the campaign goal on Campaigns.',
      },
      {
        emoji: '🔪',
        title: 'Cut turf',
        body:
          'Turf is the map divided into walkable chunks. On the Turf page, tap door A then door ' +
          'B to sweep every door between them — even around a corner. Double-tap a street to take ' +
          'all of it, hold a pin to add or remove one door, and Undo forgives everything. Assign ' +
          'each turf to a squad or a single canvasser.',
        tip: 'Cutting a turf also geocodes its doors, so the whole cut shows up as pins everywhere.',
      },
      {
        emoji: '📅',
        title: 'Dispatch every morning',
        body:
          'Squads last one day, but turf is forever — so each morning you point turf at that ' +
          'day\'s crews from the Turf page. Yesterday\'s assignments show a "Not out today" flag ' +
          'until you re-dispatch, and every hand-off is kept as history on the turf.',
      },
      {
        emoji: '📊',
        title: 'Analytics',
        body:
          'Six tabs: Overview for the campaign\'s pulse, Areas / Turfs / Squads / Canvassers to ' +
          'compare the ground game, and Odds for what actually predicts a signature (attempt ' +
          'number, time of day, area). Everything drills by tapping — a bar, a dot, a table row — ' +
          'and each tab\'s "?" explains how to read it.',
      },
      {
        emoji: '🤖',
        title: 'The AI analyst',
        body:
          'AI Chat answers plain-English questions with live SQL over the campaign database: ' +
          '"How are we doing against the goal?", "Where should we send crews?" It draws charts, ' +
          'checks the map, cites what it did, and always offers three next questions to tap. ' +
          'It\'s the fastest tour of your own data.',
        tip: 'It runs on a shared demo key — just open AI Chat and ask.',
      },
      {
        emoji: '🛡️',
        title: 'Roles & settings',
        body:
          'The Roles page moves people between canvasser, Squad Leader, and Campaign Manager, ' +
          'sets their team, and places them in today\'s squads. Settings holds the campaign-level ' +
          'switches, including your own Anthropic API key for the AI chat if you bring one.',
      },
    ],
  },
  {
    id: 'done',
    label: 'Go!',
    audience: 'You',
    steps: [
      {
        emoji: '🚀',
        title: 'That\'s the tour',
        body:
          '8,000 signatures is the hill. You\'ve seen the whole machine — now try it: switch ' +
          'roles from the badge in the header, knock a few demo doors in Talk, cut a turf, ask ' +
          'the AI analyst something. Re-run this tour anytime from More → Tutorial.',
        tip: 'Go knock some doors.',
      },
    ],
  },
]

/** Flattened deck with chapter back-references, for linear Next/Back. */
export interface FlatStep extends TutorialStep {
  chapter: TutorialChapter
  indexInChapter: number
}

export const TUTORIAL_STEPS: FlatStep[] = TUTORIAL_CHAPTERS.flatMap((chapter) =>
  chapter.steps.map((step, indexInChapter) => ({ ...step, chapter, indexInChapter })),
)
