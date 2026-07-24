import { loadGeocoding } from './googleMaps'
import { supabase } from './supabase'
import { streetNameOf } from './streetWalk'
import type { Address } from '@/types'

let geocoder: google.maps.Geocoder | null = null

async function getGeocoder(): Promise<google.maps.Geocoder> {
  if (!geocoder) {
    const lib = await loadGeocoding()
    geocoder = new lib.Geocoder()
  }
  return geocoder
}

/** Union County plus a margin. Any geocode landing outside is a mismatch no
 * matter how confident Google sounds — the voter file is county-only. */
const COUNTY_BOUNDS = { north: 40.62, south: 40.05, east: -83.05, west: -83.72 }

function inCounty(lat: number, lng: number): boolean {
  return (
    lat >= COUNTY_BOUNDS.south &&
    lat <= COUNTY_BOUNDS.north &&
    lng >= COUNTY_BOUNDS.west &&
    lng <= COUNTY_BOUNDS.east
  )
}

// --- Street-name normalization ---
// The voter file stores USPS-abbreviated uppercase lines ("101 S CLINTON ST");
// Google's route components come back spelled out ("South Clinton Street") or
// as highway designations ("OH-4"). Both sides normalize to the voter-file
// style so they can be compared directly.

const TOKEN_ABBREV: Record<string, string> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', CIRCLE: 'CIR',
  COURT: 'CT', DRIVE: 'DR', LANE: 'LN', PARKWAY: 'PKWY', PLACE: 'PL',
  ROAD: 'RD', SQUARE: 'SQ', TERRACE: 'TER', TRAIL: 'TRL', HIGHWAY: 'HWY',
  POINT: 'PT', RIDGE: 'RDG', CROSSING: 'XING', EXTENSION: 'EXT',
}

export function normalizeStreetName(raw: string): string {
  const s = raw.toUpperCase().replace(/[.,']/g, ' ').replace(/\s+/g, ' ').trim()
  // Numbered routes: many spellings, one voter-file form.
  const sr = s.match(/^(?:OH|SR|OHIO|STATE ROUTE|STATE RTE|STATE HIGHWAY)[ -]?(\d+)$/)
  if (sr) return `STATE ROUTE ${sr[1]}`
  const us = s.match(/^(?:US|U S|US HIGHWAY|US HWY|US ROUTE|US RTE)[ -]?(\d+)$/)
  if (us) return `US HIGHWAY ${us[1]}`
  const cr = s.match(/^(?:CR|CO RD|CO ROAD|COUNTY RD|COUNTY ROAD)[ -]?(\d+)$/)
  if (cr) return `COUNTY ROAD ${cr[1]}`
  return s
    .split(' ')
    .map((t) => TOKEN_ABBREV[t] ?? t)
    .join(' ')
}

/** "S CLINTON ST" -> "CLINTON ST" — the loosest match tier (Google sometimes
 * drops the directional; E vs W on the same corridor is still the right
 * street for our purposes). */
export function stripLeadingDirectional(name: string): string {
  return name.replace(/^(?:N|S|E|W|NE|NW|SE|SW) /, '')
}

/** Every normalized route name a geocoder result carries (short + long). */
function routeNamesOf(result: google.maps.GeocoderResult): string[] {
  const out: string[] = []
  for (const c of result.address_components) {
    if (!c.types.includes('route')) continue
    for (const n of [c.short_name, c.long_name]) {
      if (!n) continue
      const norm = normalizeStreetName(n)
      if (norm && !out.includes(norm)) out.push(norm)
    }
  }
  return out
}

// --- Forward geocoding with validation (2026-07-24) ---
// Google NEVER admits failure: an address it can't find comes back as an
// APPROXIMATE locality/ZIP centroid or a same-named street elsewhere, and we
// used to cache that permanently — 83 doors across 11 Marysville streets sat
// stacked on the town centroid. A result is cached only when it is
// street-level, on the right street, and inside the county; anything else
// returns null and caches NOTHING (the door just stays unmapped and can
// retry another day).

const STREET_LEVEL_TYPES = ['street_address', 'premise', 'subpremise']

function trustworthy(result: google.maps.GeocoderResult, queriedStreetLine: string): boolean {
  const loc = result.geometry.location
  if (!inCounty(loc.lat(), loc.lng())) return false
  const locationType = String(result.geometry.location_type)
  const streetLevel =
    locationType === 'ROOFTOP' ||
    locationType === 'RANGE_INTERPOLATED' ||
    (result.types ?? []).some((t) => STREET_LEVEL_TYPES.includes(t))
  if (!streetLevel) return false
  const queried = normalizeStreetName(streetNameOf(queriedStreetLine))
  if (!queried) return false
  return routeNamesOf(result).some(
    (r) => r === queried || stripLeadingDirectional(r) === stripLeadingDirectional(queried),
  )
}

/** The slice of Address geocoding actually needs — lets callers pass slim
 * row shapes (e.g. the turf cutter's AddressLite) without faking a full row. */
export type GeocodableAddress = Pick<Address, 'id' | 'street' | 'unit' | 'city' | 'zip' | 'lat' | 'lng'>

/** Geocode one address in the browser (Maps JS Geocoder — no CORS issue,
 * no server proxy needed) and persist the result via a narrow RPC that only
 * a security-definer function is allowed to write (see migration
 * 20260702140000_geocode_on_view.sql). No-ops if already geocoded. Results
 * that fail validation (wrong street, not street-level, out of county) are
 * discarded without caching. */
export async function geocodeAndCache(address: GeocodableAddress): Promise<{ lat: number; lng: number } | null> {
  if (address.lat != null && address.lng != null) return { lat: address.lat, lng: address.lng }

  try {
    const g = await getGeocoder()
    const line = `${address.street}${address.unit ? ' ' + address.unit : ''}, ${address.city}, OH ${address.zip ?? ''}`
    const { results } = await g.geocode({ address: line, bounds: COUNTY_BOUNDS, region: 'us' })
    const hit = results.find((r) => trustworthy(r, address.street))
    if (!hit) return null
    const lat = hit.geometry.location.lat()
    const lng = hit.geometry.location.lng()

    await supabase.rpc('set_address_location', {
      address_id: address.id,
      new_lat: lat,
      new_lng: lng,
    })
    return { lat, lng }
  } catch {
    return null // best-effort — Talk mode still works without a pin
  }
}

/** Geocode a batch of addresses one at a time (the Maps JS Geocoder has no
 * batch call and rate-limits hard on bursts, so sequential-with-await is the
 * safe cadence). Already-located rows are skipped for free. `onLocated` fires
 * as each door resolves so callers can drop its pin incrementally; `shouldStop`
 * is polled before each door so a long sweep can bail when the caller navigates
 * away. Every VALIDATED result caches to the DB — a one-time cost per address. */
export async function geocodeMissing(
  addresses: GeocodableAddress[],
  onLocated?: (id: string, loc: { lat: number; lng: number }) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  for (const a of addresses) {
    if (shouldStop?.()) return
    if (a.lat != null && a.lng != null) continue
    const loc = await geocodeAndCache(a)
    if (loc) onLocated?.(a.id, loc)
  }
}

// --- Reverse geocoding: the street under a map point ---

export interface StreetAtPoint {
  /** Normalized route-name candidates (short + long form). */
  names: string[]
  /** Google's locality (town) at the point, when it names one. */
  city: string | null
}

/** The street at a map point — how the turf cutter's armed "☝ Streets" tool
 * resolves a tap on the bare basemap to a street NAME even when none of that
 * street's doors have coordinates yet (nearest-mapped-door guessing added
 * whole wrong streets in sparsely geocoded towns). One Geocoder call per
 * deliberate tap of an armed tool — no background sweeps. */
export async function streetAtPoint(lat: number, lng: number): Promise<StreetAtPoint | null> {
  try {
    const g = await getGeocoder()
    const { results } = await g.geocode({ location: { lat, lng } })
    for (const r of results) {
      const names = routeNamesOf(r)
      if (!names.length) continue
      const city = r.address_components.find((c) => c.types.includes('locality'))?.long_name ?? null
      return { names, city }
    }
    return null
  } catch {
    return null
  }
}
