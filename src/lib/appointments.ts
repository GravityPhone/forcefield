/**
 * Appointments (2026-07-26) — the follow-up behind the "Come back another
 * time" outcome button.
 *
 * Two jobs live here: the shared settings singleton (is the feature on, how
 * long is a window, which hours does the day run) and the window arithmetic
 * the door sheet offers. Everything is LOCAL time — a canvasser saying "come
 * back between four and six" means four o'clock where they're standing, so
 * windows are built from local Date parts and only become ISO on the way to
 * the database.
 *
 * The settings ref is a module singleton rather than a Pinia store because
 * four unrelated places need the same answer (the nav, the outcome button,
 * /appointments, the Analytics tab) and none of them owns it — same shape as
 * lib/appChrome.ts and lib/myTurf.ts.
 */

import { ref } from 'vue'
import { supabase } from './supabase'
import { DEFAULT_APPOINTMENT_SETTINGS, type AppointmentSettings } from '@/types'

/** Live settings. Reads the DB defaults until the row lands, so nothing
 * renders an appointment affordance the campaign hasn't turned on. */
export const appointmentSettings = ref<AppointmentSettings>({ ...DEFAULT_APPOINTMENT_SETTINGS })

let settingsPromise: Promise<void> | null = null

async function loadSettings(): Promise<void> {
  const { data, error } = await supabase
    .from('appointment_settings')
    .select('*')
    .eq('id', true)
    .maybeSingle()
  if (error) {
    // Leave the defaults (feature off) and let the next caller retry — a
    // failed read must never look like "a manager enabled this".
    settingsPromise = null
    return
  }
  if (data) appointmentSettings.value = data as AppointmentSettings
}

/** Fetch the settings once per session; concurrent callers share the flight. */
export function ensureAppointmentSettings(): Promise<void> {
  if (!settingsPromise) settingsPromise = loadSettings()
  return settingsPromise
}

/** Re-read after a manager saves (the options card writes then calls this). */
export function refreshAppointmentSettings(): Promise<void> {
  settingsPromise = loadSettings()
  return settingsPromise
}

// ------------------------------------------------------------------ windows

export interface ApptWindow {
  start: Date
  end: Date
  /** "4–6 PM" — what the chip says. */
  label: string
}

/** "4 PM" / "4:30 PM" — the :00 is noise on a chip. */
export function timeLabel(d: Date): string {
  const mins = d.getMinutes()
  return d.toLocaleTimeString([], {
    hour: 'numeric',
    ...(mins ? { minute: '2-digit' } : {}),
  })
}

/** "4–6 PM", collapsing the shared meridiem: "4–6 PM" not "4 PM–6 PM", but
 * "11 AM–1 PM" keeps both because they differ. */
export function windowLabel(start: Date, end: Date): string {
  const a = timeLabel(start)
  const b = timeLabel(end)
  const sameHalf = start.getHours() < 12 === end.getHours() < 12
  // Both labels end in " AM"/" PM" in en-US; other locales just keep both.
  const suffix = b.slice(-3)
  if (sameHalf && a.endsWith(suffix)) return `${a.slice(0, -3).trim()}–${b}`
  return `${a}–${b}`
}

/** YYYY-MM-DD (local) for a Date — matches lib/day.ts's localToday(). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local Date at a given YYYY-MM-DD and minute-of-day. Built from parts on
 * purpose: `new Date('2026-07-26')` parses as UTC midnight and lands on the
 * wrong day for US timezones. */
export function localAt(dateKey: string, minuteOfDay: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d, 0, minuteOfDay, 0, 0)
}

/** The come-back windows offered for one day: the campaign's hours sliced
 * into window_minutes chunks. Windows that have already ended are dropped —
 * nobody schedules a visit for this morning. A chunk that would run past the
 * day's end hour is dropped too, so the last window is a real one. */
export function buildWindows(
  dateKey: string,
  settings: AppointmentSettings = appointmentSettings.value,
  now: Date = new Date(),
): ApptWindow[] {
  const step = Math.max(15, Math.round(settings.window_minutes))
  const from = settings.day_start_hour * 60
  const until = settings.day_end_hour * 60
  const out: ApptWindow[] = []
  for (let m = from; m + step <= until; m += step) {
    const start = localAt(dateKey, m)
    const end = localAt(dateKey, m + step)
    if (end.getTime() <= now.getTime()) continue
    out.push({ start, end, label: windowLabel(start, end) })
  }
  return out
}

/** "Sat, Jul 26" — the day heading on /appointments and the door chip. */
export function dayLabel(d: Date, now: Date = new Date()): string {
  const key = localDateKey(d)
  if (key === localDateKey(now)) return 'Today'
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  if (key === localDateKey(tomorrow)) return 'Tomorrow'
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** "Tomorrow 4–6 PM" — one appointment in one line. */
export function appointmentLabel(startsAt: string, endsAt: string, now?: Date): string {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  return `${dayLabel(start, now)} ${windowLabel(start, end)}`
}
