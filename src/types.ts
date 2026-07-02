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
