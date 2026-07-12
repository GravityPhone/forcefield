/** Teammates-can-call phone numbers (member_phones table).
 *
 * The table is RLS-scoped to the owner + their team, so an embedded
 * `member_phones(phone)` simply comes back empty for anyone not allowed to
 * see the number — the client's only job is "is it there or not". No number
 * means no call button, everywhere. */

/** Unwrap a PostgREST `member_phones(phone)` embed. user_id is the primary
 * key so PostgREST returns a one-to-one object, but tolerate the array
 * shape too in case detection ever changes. */
export function embeddedPhone(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed
  return (row as { phone?: string | null } | null | undefined)?.phone ?? null
}

/** tel: href for the native dialer — keep digits and a leading +, drop the
 * punctuation people type. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+0-9]/g, '')}`
}
