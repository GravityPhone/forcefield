import { importLibrary, setOptions } from '@googlemaps/js-api-loader'
import { ref } from 'vue'
import { GOOGLE_MAPS_API_KEY } from './config'

/** Set when Google rejects the API key at runtime (quota, billing, referrer
 * restriction…) — the "This page can't load Google Maps correctly" dialog.
 * Google logs the specific reason code to the console; this just lets the
 * UI acknowledge it instead of leaving only the cryptic built-in dialog. */
export const mapsAuthError = ref(false)

/** Every app map must pass this as renderingType. The default (vector)
 * renderer stopped painting our cloud style entirely on 2026-07-13: the map
 * initializes, overlays and AdvancedMarkers draw, but the WebGL basemap
 * never produces a frame — on every device, on both the weekly and
 * quarterly API channels, with all config/tile RPCs returning 200. Raster
 * rendering with the SAME map ID paints fine, and AdvancedMarkers support
 * raster maps (they only require a mapId). String literal (not
 * google.maps.RenderingType.RASTER) so importing this file doesn't touch
 * the not-yet-loaded google global. */
export const MAP_RENDERING_TYPE = 'RASTER' as google.maps.RenderingType

/** Below this zoom, business POIs are shown but NOT tappable (2026-07-25,
 * user call: too easy to hit a shop by accident, and Google's place card is
 * fiddly to get back out of).
 *
 * `clickableIcons` controls tappability only — the icons and labels still
 * draw either way, so the businesses stay on the map as landmarks, which is
 * what they're actually useful for when you're finding a street. Zoomed in
 * past this, a tap on a business is deliberate, so it's allowed through.
 *
 * A suppressed POI tap falls through to the map's own click handler, which
 * is what every one of our maps wants anyway (locate the street, open the
 * door). */
export const POI_TAP_MIN_ZOOM = 18

/** Wires the zoom gate above onto a map. Call once, right after construction,
 * on every map that shows POIs. Returns nothing to unsubscribe: the listener
 * dies with the map. */
export function attachPoiTapGuard(map: google.maps.Map) {
  const sync = () => {
    map.setOptions({ clickableIcons: (map.getZoom() ?? 0) >= POI_TAP_MIN_ZOOM })
  }
  sync()
  map.addListener('zoom_changed', sync)
}

let configured = false

function configure() {
  if (configured) return
  // Google calls this global (if defined) instead of only showing its own
  // error dialog. The precise cause (OverQuotaMapError, RefererNotAllowed…)
  // is in the console right above this message.
  ;(window as Window & { gm_authFailure?: () => void }).gm_authFailure = () => {
    mapsAuthError.value = true
    console.error(
      'Forcefield: Google Maps rejected the API key — see the error code logged above ' +
        '(quota/billing/referrer restriction) and check the key in Google Cloud Console.',
    )
  }
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
