/** Hierarchy: admin > campaign_manager > team_lead (shown as "Squad
 * Leader") > canvasser. Campaign managers hold the full day-to-day feature
 * set (turf, AI chat, settings, dashboards); admins manage users/teams and
 * view campaigns at a high level. */
export type AppRole = 'canvasser' | 'team_lead' | 'campaign_manager' | 'admin'

/** Cosmetic color scheme, saved per account. Deliberately independent of
 * the knock-outcome colors (OUTCOMES in lib/outcomes.ts), the Hunt-mode
 * indicator grid, and map pins — those stay fixed across every scheme. */
export type ThemeId =
  | 'light'
  | 'dark'
  | 'highContrast'
  | 'highContrastLight'
  | 'safetyVest'
  | 'eighties'
  | 'nineties'
  | 'seventies'
  | 'jazzCup'
  | 'diner'
  | 'handheld'
  | 'crtGreen'
  | 'crtAmber'
  | 'paperback'
  | 'nightVision'
  | 'forest'
  | 'ocean'
  | 'sunset'
  | 'solarized'
  | 'midnight'

/** Background flair drawn behind the page (lib/patterns.ts). Pure CSS
 * masks/gradients tinted from the active scheme — no image downloads. */
export type PatternId =
  | 'none'
  | 'jazz'
  | 'memphis'
  | 'waves'
  | 'zigzag'
  | 'grid'
  | 'scanlines'
  | 'stripes'
  | 'dots'

export type FontId = 'system' | 'rounded' | 'mono' | 'serif'

/** Per-account display preferences beyond the color scheme — all cosmetic,
 * all stored flat inside the same profiles.theme jsonb as `scheme`. */
export interface DisplayPrefs {
  /** Multiplies the app's fluid root font size — everything is rem-based,
   * so this scales text, buttons, and spacing together. */
  textScale: number
  /** Adds a hair of stroke to every glyph — bolder without flattening
   * weight hierarchy. */
  bold: boolean
  /** Sunlight boost: pulls muted text and borders hard toward full text
   * color for glare-proof contrast on any scheme. */
  sunlight: boolean
  font: FontId
  /** 'theme' defers to the scheme's own radius token. */
  corners: 'theme' | 'sharp' | 'round'
  compact: boolean
  reduceMotion: boolean
  pattern: PatternId
  patternBold: boolean
}

/** Shape of the profiles.theme jsonb: the scheme plus any saved display
 * prefs (older rows have only `scheme` — readers must fill defaults via
 * normalizeThemeSettings in lib/themes.ts). */
export type ThemeSettings = { scheme: ThemeId } & Partial<DisplayPrefs>

export interface Profile {
  id: string
  username: string
  display_name: string | null
  /** Slug of a Fluent emoji SVG in public/avatars/ (see lib/avatars.ts). */
  avatar: string | null
  /** Personal accent hex, picked on /appearance — colors this member's card
   * and marker on the Squad page. Null = deterministic palette fallback
   * (lib/memberColors.ts). */
  color: string | null
  role: AppRole
  team_id: string | null
  theme: ThemeSettings
  /** Self-written intro, shown on the roster/member pages ("About me"). */
  bio: string | null
  why_canvassing: string | null
  fun_fact: string | null
  created_at: string
  updated_at: string
}

export interface Team {
  id: string
  name: string
  campaign_id: string | null
  created_at: string
}

/** Long-lived effort (e.g. "UBI") that teams are assigned to. */
export interface Campaign {
  id: string
  name: string
  description: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
}

/** Day crew: formed by anyone, dissolves at midnight (squad_date scopes it
 * to one workday — the app only shows squads dated today). Each squad gets
 * its own squad chat, created alongside it. */
export interface Squad {
  id: string
  name: string
  chat_id: string | null
  created_by: string | null
  squad_date: string
  created_at: string
}

export interface SquadMember {
  squad_id: string
  user_id: string
  joined_at: string
}

export const ROLE_LABELS: Record<AppRole, string> = {
  canvasser: 'Canvasser',
  // Displayed as "Squad Leader" (user's preferred term) — the DB enum value
  // stays team_lead; renaming a Postgres enum isn't worth the migration.
  team_lead: 'Squad Leader',
  campaign_manager: 'Campaign Manager',
  admin: 'Admin',
}

export type KnockOutcome =
  | 'signed'
  | 'didnt_sign'
  | 'maybe'
  | 'not_home'
  | 'skip'
  | 'hostile'

export interface Address {
  id: string
  street: string
  unit: string | null
  city: string
  county: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  turf_id: string | null
  data_source: 'csv_import' | 'minivan' | 'demo' | 'manual'
  registered_voter: boolean
  created_at: string
  updated_at: string
}

export interface Person {
  id: string
  name: string
  household_id: string | null
  voter_file_id: string | null
  registered_voter: boolean
  created_at: string
  updated_at: string
}

export interface KnockLog {
  id: string
  client_id: string
  person_id: string | null
  household_id: string | null
  canvasser_id: string
  occurred_at: string
  outcome: KnockOutcome
  notes: string | null
  created_at: string
  /** Stamped by the DB at insert (20260714120000): which squad the canvasser
   * was crewing with that day, and the top-level turf the door sat in. Names
   * are snapshots — they outlive squad wipes and turf re-cuts. */
  squad_id: string | null
  squad_name: string | null
  turf_id: string | null
  turf_name: string | null
}

/** Insert shape for knock_logs — client_id is generated on the device so the
 * offline queue can replay idempotently. */
export interface NewKnock {
  client_id: string
  person_id: string | null
  household_id: string | null
  canvasser_id: string
  occurred_at: string
  outcome: KnockOutcome
  notes: string | null
}

export interface HouseholdLatestKnock {
  household_id: string
  outcome: KnockOutcome
  occurred_at: string
  /** Distinct residents who have EVER signed — feeds the all/partly-signed
   * door colors (see doorStatusOutcome in lib/outcomes.ts). */
  signed_count: number
  /** Roster size (persons at this address). */
  person_count: number
}

export interface HouseholdKnockSummary {
  household_id: string
  total_knocks: number
  signed_count: number
  didnt_sign_count: number
  maybe_count: number
  not_home_count: number
  skip_count: number
  hostile_count: number
  reached: boolean
}

/** Which side(s) of the street a turf segment covers. */
export type TurfParity = 'both' | 'even' | 'odd'

export const PARITY_LABELS: Record<TurfParity, string> = {
  both: 'Both sides',
  even: 'Even side',
  odd: 'Odd side',
}

/** Named cut of geography, assigned to a squad or an individual canvasser
 * (never both). Its member addresses carry turf_id (stamped by the
 * set_turf_segments RPC), so lookup is a plain column read.
 *
 * Cutting top-level turf is a campaign-manager job. A row with
 * parent_turf_id set is a SUB-TURF — a squad leader's cut inside a turf
 * assigned to them, its doors carved out of (and returned to) the parent.
 *
 * Turf is durable but squads last one day, so squad_id is a DISPATCH: the
 * campaign manager re-points turf at each day's crews from /turf. Turf left
 * on a past day's squad hides from Squad/Hunt until re-dispatched;
 * re-dispatching dissolves the old crew's sub-turfs (DB trigger) and appends
 * to the turf_assignments history. */
export interface Turf {
  id: string
  name: string
  color: string
  squad_id: string | null
  assignee_id: string | null
  parent_turf_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** One street range inside a turf — "100–298 of WALNUT ST, even side".
 * street_name is normalized like streetNameOf() (no house number, uppercase). */
export interface TurfSegment {
  id: string
  turf_id: string
  street_name: string
  city: string | null
  range_start: number
  range_end: number
  parity: TurfParity
  created_at: string
}

export type ChatKind = 'global' | 'squad' | 'dm' | 'team' | 'team_leads' | 'team_managers'

export interface Chat {
  id: string
  kind: ChatKind
  name: string | null
  /** Set on kind 'team' only — membership is profiles.team_id, no member rows. */
  team_id?: string | null
  created_by: string | null
  created_at: string
}

export interface ChatMember {
  chat_id: string
  user_id: string
  added_by: string | null
  joined_at: string
}

/** Attachment descriptor stored in chat_messages.files — mirrors the shape
 * vue-advanced-chat renders ({ type } is the extension, e.g. 'png'). */
export interface ChatFile {
  name: string
  size: number
  type: string
  url: string
  preview?: string
}

export interface ChatMessage {
  id: string
  chat_id: string
  sender_id: string
  body: string
  files: ChatFile[] | null
  created_at: string
}

/** One user's emoji reaction to a message. */
export interface MessageReaction {
  message_id: string
  chat_id: string
  user_id: string
  emoji: string
}

/** Minimal profile info shown next to chat messages and in member pickers. */
export interface ChatProfile {
  id: string
  username: string
  display_name: string | null
  avatar: string | null
  /** Present where member accent colors matter (Squad page). */
  color?: string | null
  /** Present where role matters (leadership-room member lists). */
  role?: AppRole
  /** Present where team scoping matters (team-room member lists, pickers). */
  team_id?: string | null
  /** Present where tap-to-call matters (squad cards, chat member lists).
   * Only ever non-null for your own teammates — member_phones RLS. */
  phone?: string | null
}

export interface Bulletin {
  id: string
  author_id: string | null
  title: string
  body: string
  created_at: string
  /** PostgREST embed via the author_id FK. */
  author?: ChatProfile | null
}

export type LeaderboardMetric = 'signatures' | 'doors'

export const METRIC_LABELS: Record<LeaderboardMetric, string> = {
  signatures: 'Signatures',
  doors: 'Doors knocked',
}

export interface LeaderboardSettings {
  id: boolean
  primary_metric: LeaderboardMetric
  doors_board_enabled: boolean
  updated_at: string
}

export interface CanvasserLeaderboardRow {
  canvasser_id: string
  username: string
  display_name: string | null
  doors_knocked: number
  signatures: number
}

/** Singleton knobs for the team activity feed (/activity): which per-event
 * rows show, and where the milestone lines fall. Doors are DISTINCT
 * households and signatures DISTINCT signed persons (the squad-progress /
 * door-status semantics, not the leaderboard's every-log count). Managed
 * from the campaign manager's dashboard. */
export interface ActivityFeedSettings {
  id: boolean
  show_knocks: boolean
  show_signatures: boolean
  person_milestones: boolean
  person_door_step: number
  squad_milestones: boolean
  squad_door_step: number
  squad_signature_step: number
  team_milestones: boolean
  team_door_step: number
  team_signature_step: number
  updated_at: string
}

/** Client-side fallback while the settings row loads (or if it can't) —
 * mirrors the DB defaults in 20260720130000_activity_feed_settings.sql. */
export const DEFAULT_FEED_SETTINGS: ActivityFeedSettings = {
  id: true,
  show_knocks: true,
  show_signatures: true,
  person_milestones: true,
  person_door_step: 5,
  squad_milestones: true,
  squad_door_step: 25,
  squad_signature_step: 10,
  team_milestones: true,
  team_door_step: 100,
  team_signature_step: 25,
  updated_at: '',
}
