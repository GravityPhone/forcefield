export type AppRole = 'canvasser' | 'team_lead' | 'admin'

export interface Profile {
  id: string
  username: string
  display_name: string | null
  role: AppRole
  team_id: string | null
  theme: { mode: 'light' | 'dark'; accent: string }
  created_at: string
  updated_at: string
}

export interface Team {
  id: string
  name: string
  created_at: string
}

export const ROLE_LABELS: Record<AppRole, string> = {
  canvasser: 'Canvasser',
  team_lead: 'Team Lead',
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

export type ChatKind = 'global' | 'squad' | 'dm'

export interface Chat {
  id: string
  kind: ChatKind
  name: string | null
  created_by: string | null
  created_at: string
}

export interface ChatMember {
  chat_id: string
  user_id: string
  added_by: string | null
  joined_at: string
}

export interface ChatMessage {
  id: string
  chat_id: string
  sender_id: string
  body: string
  created_at: string
}

/** Minimal profile info shown next to chat messages and in member pickers. */
export interface ChatProfile {
  id: string
  username: string
  display_name: string | null
}
