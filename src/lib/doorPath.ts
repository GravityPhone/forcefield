import { houseNumber, streetNameOf } from './streetWalk'

/** The slice of an address row the walk math needs — callers pass whatever
 * richer shape they already hold (TurfDoor, AddressLite, …). */
export interface WalkDoor {
  street: string
  city: string | null
  lat: number | null
  lng: number | null
}

export interface WalkRange {
  street_name: string
  city: string | null
  lo: number
  hi: number
}

function flatMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(s))
}

function onStreet(d: WalkDoor, name: string, city: string | null): boolean {
  if (streetNameOf(d.street) !== name) return false
  if (!city || !d.city) return true
  return d.city.toUpperCase() === city.toUpperCase()
}

export function rangeCovers(r: WalkRange, d: WalkDoor): boolean {
  if (!onStreet(d, r.street_name, r.city)) return false
  const n = houseNumber(d.street)
  return n >= r.lo && n <= r.hi
}

/**
 * Two-tap sweep from door `a` to door `b`, "as though walking" between them.
 *
 * Same street → one house-number range spanning the two taps. Different
 * streets → a range on EACH street: up `a`'s street to the corner where the
 * two streets come closest, around it, and along `b`'s street to `b`. The
 * corner is found geometrically — the closest located pair of doors across
 * the two streets in `all` (whatever doors the caller knows about) — since
 * the address data carries no street topology.
 */
export function walkRanges(a: WalkDoor, b: WalkDoor, all: Iterable<WalkDoor>): WalkRange[] {
  const nameA = streetNameOf(a.street)
  const nameB = streetNameOf(b.street)
  const nA = houseNumber(a.street)
  const nB = houseNumber(b.street)

  if (nameA === nameB && (!a.city || !b.city || a.city.toUpperCase() === b.city.toUpperCase())) {
    return [
      { street_name: nameA, city: a.city ?? b.city, lo: Math.min(nA, nB), hi: Math.max(nA, nB) },
    ]
  }

  const locA: WalkDoor[] = []
  const locB: WalkDoor[] = []
  for (const d of all) {
    if (d.lat == null || d.lng == null) continue
    if (onStreet(d, nameA, a.city)) locA.push(d)
    else if (onStreet(d, nameB, b.city)) locB.push(d)
  }
  // Streets hold tens of doors, so the brute-force closest pair is cheap.
  let cornerA: WalkDoor = a
  let cornerB: WalkDoor = b
  let best = Infinity
  for (const da of locA) {
    for (const db of locB) {
      const dist = flatMeters(da.lat!, da.lng!, db.lat!, db.lng!)
      if (dist < best) {
        best = dist
        cornerA = da
        cornerB = db
      }
    }
  }
  const nCA = houseNumber(cornerA.street)
  const nCB = houseNumber(cornerB.street)
  return [
    { street_name: nameA, city: a.city, lo: Math.min(nA, nCA), hi: Math.max(nA, nCA) },
    { street_name: nameB, city: b.city, lo: Math.min(nB, nCB), hi: Math.max(nB, nCB) },
  ]
}
