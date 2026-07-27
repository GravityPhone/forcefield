/**
 * What a day's crew is called before anyone renames it (2026-07-27, user call).
 *
 * One shape, everywhere: "<first name>'s squad". The app says "squad" in the
 * tab bar, the page title and every help deck, so the name a squad is born
 * with says it too — "crew" and "team" were floating around as third and
 * fourth words for the same thing.
 *
 * First name, not the whole display name: it rides in headers, chat room
 * lists and the leaderboard, where a two-word name wraps.
 */
export function defaultSquadName(who: { display_name?: string | null; username?: string | null } | null | undefined): string {
  const full = (who?.display_name || who?.username || '').trim()
  const first = full.split(/\s+/)[0]
  return first ? `${first}'s squad` : 'Today’s squad'
}
