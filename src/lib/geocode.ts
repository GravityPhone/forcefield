import { loadGeocoding } from './googleMaps'
import { supabase } from './supabase'
import type { Address } from '@/types'

let geocoder: google.maps.Geocoder | null = null

async function getGeocoder(): Promise<google.maps.Geocoder> {
  if (!geocoder) {
    const lib = await loadGeocoding()
    geocoder = new lib.Geocoder()
  }
  return geocoder
}

/** The slice of Address geocoding actually needs — lets callers pass slim
 * row shapes (e.g. the turf cutter's AddressLite) without faking a full row. */
export type GeocodableAddress = Pick<Address, 'id' | 'street' | 'unit' | 'city' | 'zip' | 'lat' | 'lng'>

/** Geocode one address in the browser (Maps JS Geocoder — no CORS issue,
 * no server proxy needed) and persist the result via a narrow RPC that only
 * a security-definer function is allowed to write (see migration
 * 20260702140000_geocode_on_view.sql). No-ops if already geocoded. */
export async function geocodeAndCache(address: GeocodableAddress): Promise<{ lat: number; lng: number } | null> {
  if (address.lat != null && address.lng != null) return { lat: address.lat, lng: address.lng }

  try {
    const g = await getGeocoder()
    const line = `${address.street}${address.unit ? ' ' + address.unit : ''}, ${address.city}, OH ${address.zip ?? ''}`
    const { results } = await g.geocode({ address: line })
    if (!results.length) return null
    const loc = results[0].geometry.location
    const lat = loc.lat()
    const lng = loc.lng()

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

/** Reverse-geocode a spread of map points to the streets under them — how
 * "Place pins" discovers streets in view even when none of their doors are
 * pinned yet (an unpinned door has no coordinates to test against the
 * viewport, but the viewport itself knows what ground it's over). Returns
 * street names in the DB's format ("N MAIN ST") with the locality when
 * Google reports one. Failures on individual points are skipped. */
export async function streetsAtPoints(
  points: { lat: number; lng: number }[],
): Promise<{ name: string; city: string | null }[]> {
  const found = new Map<string, { name: string; city: string | null }>()
  try {
    const g = await getGeocoder()
    for (const p of points) {
      try {
        const { results } = await g.geocode({ location: p })
        const hit = results.find((r) =>
          r.address_components.some((c) => c.types.includes('route')),
        )
        const route = hit?.address_components.find((c) => c.types.includes('route'))
        if (!route) continue
        const locality = hit!.address_components.find((c) => c.types.includes('locality'))
        const name = route.short_name.toUpperCase()
        found.set(`${name}|${locality?.long_name.toUpperCase() ?? ''}`, {
          name,
          city: locality?.long_name ?? null,
        })
      } catch {
        // No result / momentary rate limit — this sample point just misses.
      }
    }
  } catch {
    // Geocoder itself unavailable — caller falls back to pinned streets only.
  }
  return [...found.values()]
}

/** Geocode a batch of addresses one at a time (the Maps JS Geocoder has no
 * batch call and rate-limits hard on bursts, so sequential-with-await is the
 * safe cadence). Already-located rows are skipped for free. `onLocated` fires
 * as each door resolves so callers can drop its pin incrementally; `shouldStop`
 * is polled before each door so a long sweep can bail when the caller navigates
 * away. Every result caches to the DB — this is a one-time cost per address. */
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
