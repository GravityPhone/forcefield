// Downloads incorporated-place (city/village) boundary polygons around Union
// County, OH from the Census TIGERweb REST service and writes them to
// public/boundaries/union-city-limits.geojson, which the map's "City" layer
// renders. Re-run (node scripts/fetch-city-limits.mjs) if boundaries change
// (annexations happen — TIGERweb layer 4 is the current vintage).
//
// Why boundaries matter here: petition validity often hinges on city vs
// unincorporated township, and the borders are heavily gerrymandered —
// city, then county, then city again along one road.
import { mkdirSync, writeFileSync } from 'node:fs'

// Union County plus a margin so places spilling over the county line
// (Dublin, Plain City, Marysville edges) come in whole.
const BBOX = '-83.75,40.05,-82.95,40.60'

const params = new URLSearchParams({
  geometry: BBOX,
  geometryType: 'esriGeometryEnvelope',
  inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects',
  outFields: 'NAME,BASENAME,GEOID',
  returnGeometry: 'true',
  outSR: '4326',
  f: 'geojson',
})

const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query?${params}`
const res = await fetch(url)
if (!res.ok) throw new Error(`TIGERweb HTTP ${res.status}`)
const geojson = await res.json()
if (!geojson.features?.length) throw new Error('TIGERweb returned no features')

// Trim coordinate precision to ~1m (5 decimals) — halves the file size and
// is far below the visual error of a boundary line on a phone screen.
const round = (n) => Math.round(n * 1e5) / 1e5
const roundCoords = (c) => (typeof c[0] === 'number' ? c.map(round) : c.map(roundCoords))
for (const f of geojson.features) {
  f.geometry.coordinates = roundCoords(f.geometry.coordinates)
  f.properties = { name: f.properties.NAME ?? f.properties.BASENAME }
}

mkdirSync('public/boundaries', { recursive: true })
writeFileSync('public/boundaries/union-city-limits.geojson', JSON.stringify(geojson))
console.log(
  `Wrote ${geojson.features.length} places:`,
  geojson.features.map((f) => f.properties.name).join(', '),
)
