import { importLibrary, setOptions } from '@googlemaps/js-api-loader'
import { GOOGLE_MAPS_API_KEY } from './config'

let configured = false

/** Load the maps + marker libraries (classic google.maps.Marker lives in
 * 'marker'). The underlying loader injects the Maps script exactly once. */
export async function loadMaps(): Promise<google.maps.MapsLibrary> {
  if (!configured) {
    setOptions({ key: GOOGLE_MAPS_API_KEY, v: 'weekly' })
    configured = true
  }
  const [maps] = await Promise.all([importLibrary('maps'), importLibrary('marker')])
  return maps
}
