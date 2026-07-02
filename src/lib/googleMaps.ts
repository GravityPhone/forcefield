import { importLibrary, setOptions } from '@googlemaps/js-api-loader'
import { GOOGLE_MAPS_API_KEY } from './config'

let configured = false

function configure() {
  if (configured) return
  setOptions({ key: GOOGLE_MAPS_API_KEY, v: 'weekly' })
  configured = true
}

/** Load the maps + marker libraries (classic google.maps.Marker lives in
 * 'marker'). The underlying loader injects the Maps script exactly once. */
export async function loadMaps(): Promise<google.maps.MapsLibrary> {
  configure()
  const [maps] = await Promise.all([importLibrary('maps'), importLibrary('marker')])
  return maps
}

/** Load the geocoding library — the browser Geocoder, not a raw REST call,
 * so it works from client code without CORS or a server proxy. */
export async function loadGeocoding(): Promise<google.maps.GeocodingLibrary> {
  configure()
  return importLibrary('geocoding')
}
