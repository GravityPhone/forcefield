// Who knocked this door today, drawn ON the door — the same badge on every
// map (2026-07-24, user call: "in both the scout page and the squad page it
// shows the icon of the person… their animal emoji plus the color of the
// outcome of what actually happened at that door… we want this to be the
// same for all of the maps").
//
// The two channels are deliberately separate: the door's FILL keeps saying
// what happened there (white/blue nobody home yet, green signed, red closed —
// the outcome colors, untouched), and the avatar rides in the middle saying
// who was there. Fun to look at, and it still answers both questions.
//
// Avatar bitmaps decode asynchronously, so a shared cache lives here with a
// repaint callback — the canvas repaints as each image lands, and until then
// the door shows the person's initial on their own accent color.

import { avatarUrl } from './avatars'
import { memberColor } from './memberColors'
import type { DoorBadge } from './doorCanvas'

/** The bits of a profile a badge needs — every map has at least this much. */
export interface BadgePerson {
  id: string
  username: string
  display_name?: string | null
  avatar?: string | null
  color?: string | null
}

/** One cache per map (they mount and unmount independently); `onLoad` is the
 * map's requestRepaint. Returns the badge builder plus the raw image loader,
 * for maps that draw an avatar in a shape of their own (the cutter's
 * taken-door symbol). */
export function createBadgeFactory(onLoad: () => void) {
  const cache = new Map<string, HTMLImageElement>()

  function image(slug: string | null | undefined): HTMLImageElement | null {
    const url = avatarUrl(slug ?? null)
    if (!slug || !url) return null
    let img = cache.get(slug)
    if (!img) {
      img = new Image()
      img.onload = onLoad
      img.src = url
      cache.set(slug, img)
    }
    return img
  }

  function badgeFor(person: BadgePerson): DoorBadge {
    const name = person.display_name || person.username
    return {
      initial: (name || '?').slice(0, 1).toUpperCase(),
      img: image(person.avatar),
      color: memberColor(person),
    }
  }

  return { badgeFor, image }
}
