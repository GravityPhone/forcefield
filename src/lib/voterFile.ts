// Pure parsing core for Ohio SOS voter-roll exports (quoted CSV).
// No Node/browser APIs here — this module is the reusable precursor to the
// future admin CSV-import feature; scripts/import-union-subset.ts drives it
// today from the command line.

export interface VoterRecord {
  voterId: string
  name: string
  status: string
  address1: string
  secondaryAddr: string
  city: string
  state: string
  zip: string
  county: string
}

export interface Household {
  address1: string
  secondaryAddr: string
  city: string
  state: string
  zip: string
  county: string
  persons: VoterRecord[]
}

/** Split one line of a quoted CSV (fields may contain commas; quotes escape
 * as ""). Ohio SOS exports quote every field, but unquoted fields work too. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s\-'])[a-z]/g, (m) => m.toUpperCase())
    .trim()
}

/** Column lookup built from the header row, so column order changes in future
 * exports don't silently corrupt the mapping. */
export function buildColumnIndex(headerFields: string[]): Map<string, number> {
  return new Map(headerFields.map((name, i) => [name.trim().toUpperCase(), i]))
}

const REQUIRED_COLUMNS = [
  'SOS_VOTERID',
  'LAST_NAME',
  'FIRST_NAME',
  'VOTER_STATUS',
  'RESIDENTIAL_ADDRESS1',
  'RESIDENTIAL_CITY',
] as const

export function validateHeader(columns: Map<string, number>): string[] {
  return REQUIRED_COLUMNS.filter((c) => !columns.has(c))
}

export function rowToVoter(columns: Map<string, number>, fields: string[]): VoterRecord | null {
  const get = (name: string) => fields[columns.get(name) ?? -1]?.trim() ?? ''
  const voterId = get('SOS_VOTERID')
  const last = get('LAST_NAME')
  const first = get('FIRST_NAME')
  const address1 = get('RESIDENTIAL_ADDRESS1')
  if (!voterId || !last || !first) return null

  const middle = get('MIDDLE_NAME')
  const suffix = get('SUFFIX')
  const name = titleCase([first, middle, last].filter(Boolean).join(' ')) + (suffix ? ` ${suffix}` : '')

  return {
    voterId,
    name,
    status: get('VOTER_STATUS').toUpperCase(),
    address1,
    secondaryAddr: get('RESIDENTIAL_SECONDARY_ADDR'),
    city: titleCase(get('RESIDENTIAL_CITY')),
    state: get('RESIDENTIAL_STATE') || 'OH',
    zip: get('RESIDENTIAL_ZIP'),
    county: 'Union',
  }
}

export function householdKey(v: VoterRecord): string {
  return [v.address1, v.secondaryAddr, v.city, v.zip].join('|').toUpperCase()
}

/** Group voters into households (persons sharing a residential address —
 * the roster Talk mode shows at a glance). */
export function groupIntoHouseholds(voters: VoterRecord[]): Map<string, Household> {
  const households = new Map<string, Household>()
  for (const v of voters) {
    if (!v.address1) continue // no usable address → skip (can't be knocked)
    const key = householdKey(v)
    const existing = households.get(key)
    if (existing) {
      existing.persons.push(v)
    } else {
      households.set(key, {
        address1: v.address1,
        secondaryAddr: v.secondaryAddr,
        city: v.city,
        state: v.state,
        zip: v.zip,
        county: v.county,
        persons: [v],
      })
    }
  }
  return households
}
