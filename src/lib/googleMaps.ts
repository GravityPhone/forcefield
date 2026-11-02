import { importLibrary, setOptions } from '@googlemaps/js-api-loader'
import { computed, ref } from 'vue'
import { GOOGLE_MAPS_API_KEY } from './config'

/** Set when Google rejects the API key at runtime (quota, billing, referrer
 * restriction…) — the "This page can't load Google Maps correctly" dialog.
 * Google logs the specific reason code to the console; this just lets the
 * UI acknowledge it instead of leaving only the cryptic built-in dialog. */
export const mapsAuthError = ref(false)

/** The reason code Google gave (`RefererNotAllowedMapError`, `OverQuotaMapError`,
 * …), or null when the key was rejected without one. Google only ever prints
 * this to the browser console — which nobody can open on a phone — so the
 * console call is intercepted below and the code kept here for the UI. */
export const mapsErrorCode = ref<string | null>(null)

/** What each Google reason code means in practice and where to fix it. Codes
 * not listed here still show up verbatim in the message. Source:
 * https://developers.google.com/maps/documentation/javascript/error-messages */
const MAPS_ERROR_HELP: Record<string, string> = {
  NoApiKeys: 'this build has no Maps API key at all — VITE_GOOGLE_MAPS_API_KEY is not set (Netlify env var for the live site, .env for local dev)',
  MissingKeyMapError: 'the request went out without an API key — VITE_GOOGLE_MAPS_API_KEY is not set on this build',
  InvalidKeyMapError: 'the key is not valid (mistyped, deleted, or from a different Google Cloud project)',
  ExpiredKeyMapError: 'the key has expired — issue a new one in Google Cloud Console',
  RefererNotAllowedMapError: "this site's address is not on the key's allowed-referrer list in Google Cloud Console → Credentials",
  ApiNotActivatedMapError: "the Maps JavaScript API is not enabled on the key's Google Cloud project",
  ApiTargetBlockedMapError: "the key's API restrictions do not include the Maps JavaScript API",
  BillingNotEnabledMapError: "billing is not enabled on the key's Google Cloud project — Maps needs a billing account even on the free tier",
  OverQuotaMapError: 'the project is over its Maps quota or daily spending cap — check Quotas and Billing in Google Cloud Console',
  ProjectDeniedMapError: 'Google has denied the Google Cloud project access to Maps — check for a billing or policy notice in the Console',
  ApiProjectMapError: "the key's Google Cloud project could not be found — it may have been deleted or the key moved",
  DeletedApiProjectMapError: "the key's Google Cloud project has been deleted",
  InvalidVersion: 'the requested Maps JavaScript version no longer exists',
  UnauthorizedURLForClientIdMapError: "this site's address is not authorized for the client ID",
}

/** One sentence for the screen: what went wrong and where to fix it.
 * Empty until Google has actually rejected the key. */
export const mapsErrorMessage = computed(() => {
  if (!mapsAuthError.value) return ''
  const code = mapsErrorCode.value
  if (!code) {
    return 'Google rejected the Maps API key, without saying why. Check billing, quota and the key restrictions in Google Cloud Console.'
  }
  const why = MAPS_ERROR_HELP[code]
  return why
    ? `Google rejected the Maps API key (${code}): ${why}.`
    : `Google rejected the Maps API key (${code}). Look that code up on Google's Maps JavaScript API error-messages page.`
})

const GOOGLE_CONSOLE_CODE = /Google Maps JavaScript API (?:error|warning): (\w+)/

/** Google reports the reason for a failed load ONLY as a console line of the
 * form "Google Maps JavaScript API error: RefererNotAllowedMapError …" — and
 * it does so before calling gm_authFailure. Wrap console.error/warn so that
 * line also lands in `mapsErrorCode`; everything else passes straight through
 * to the real console untouched. */
function captureGoogleConsoleCodes() {
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      const first = args[0]
      if (typeof first === 'string') {
        const m = GOOGLE_CONSOLE_CODE.exec(first)
        if (m) {
          mapsErrorCode.value = m[1]
          // Warnings (NoApiKeys, a missing key) don't trigger gm_authFailure,
          // but the map is just as unusable, so flag them the same way.
          if (level === 'warn' && m[1] === 'NoApiKeys') mapsAuthError.value = true
        }
      }
      original(...args)
    }
  }
}

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
      `Forcefield: Google Maps rejected the API key${
        mapsErrorCode.value ? ` (${mapsErrorCode.value})` : ''
      }. See the error code logged above (quota/billing/referrer restriction) and check the key in Google Cloud Console.`,
    )
  }
  captureGoogleConsoleCodes()
  if (!GOOGLE_MAPS_API_KEY) {
    // Don't wait for Google to say so: a build with no key is wrong before a
    // single tile is requested, and the fix is an env var, not the console.
    mapsErrorCode.value = 'NoApiKeys'
    mapsAuthError.value = true
    console.error(
      'Forcefield: VITE_GOOGLE_MAPS_API_KEY is empty in this build — set it on Netlify (live site) or in .env (local dev).',
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
