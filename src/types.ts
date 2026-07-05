export type AppRole = 'canvasser' | 'team_lead' | 'admin'

/** Cosmetic color scheme, saved per account. Deliberately independent of
 * the knock-outcome colors (OUTCOMES in lib/outcomes.ts), the Hunt-mode
 * indicator grid, and map pins — those stay fixed across every scheme. */
export type ThemeId =
  | 'light'
  | 'dark'
  | 'highContrast'
  | 'eighties'
  | 'nineties'
  | 'forest'
  | 'ocean'
  | 'sunset'
  | 'solarized'
  | 'midnight'

export interface Profile {
  id: string
  username: string
  display_name: string | null
  /** Slug of a Fluent animal SVG in public/avatars/ (see lib/avatars.ts). */
  avatar: string | null
  role: AppRole
  team_id: string | null
  theme: { scheme: ThemeId }
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
 * set_turf_segments RPC), so lookup is a plain column read. */
export interface Turf {
  id: string
  name: string
  color: string
  squad_id: string | null
  assignee_id: string | null
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

export type ChatKind = 'global' | 'squad' | 'dm' | 'team'

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
