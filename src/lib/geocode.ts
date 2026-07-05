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
