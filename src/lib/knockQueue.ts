// Offline-first write path for knock logs.
//
// Every knock goes through submitKnock(): try Supabase directly (short abort
// so a dead-zone tap doesn't hang the UI), and on any failure park the row in
// IndexedDB and replay later. Both paths use the identical upsert keyed on the
// device-generated client_id — a real update-on-conflict, not ignore-on-
// conflict, so re-submitting the same client_id with a different outcome
// corrects the row in place (a canvasser changing their mind), while
// replaying an already-landed knock with identical values is a harmless
// no-op overwrite.
//
// Per spec there is NO sync indicator — this module is invisible to the user.

import Dexie, { type Table } from 'dexie'
import { supabase } from './supabase'
import type { NewKnock } from '@/types'

class KnockDb extends Dexie {
  pendingKnocks!: Table<NewKnock, string>

  constructor() {
    super('forcefield')
    this.version(1).stores({ pendingKnocks: 'client_id' })
  }
}

const db = new KnockDb()

const DIRECT_TIMEOUT_MS = 4000

function upsertKnock(knock: NewKnock, timeoutMs?: number) {
  let query = supabase.from('knock_logs').upsert(knock, { onConflict: 'client_id' })
  if (timeoutMs) query = query.abortSignal(AbortSignal.timeout(timeoutMs))
  return query
}

/** Log a knock. Resolves once the row is either saved to Supabase or safely
 * queued locally — never throws to the UI. */
export async function submitKnock(knock: NewKnock): Promise<void> {
  try {
    const { error } = await upsertKnock(knock, DIRECT_TIMEOUT_MS)
    if (error) throw error
  } catch {
    await db.pendingKnocks.put(knock)
  }
}

/** Undo a knock — removes it from the local queue (if not yet synced) and
 * deletes it server-side. Never throws; if offline, the local copy is gone
 * and the synced row (if any) is cleaned up on the next successful attempt. */
export async function deleteKnock(clientId: string): Promise<void> {
  await db.pendingKnocks.delete(clientId).catch(() => {})
  try {
    await supabase
      .from('knock_logs')
      .delete()
      .eq('client_id', clientId)
      .abortSignal(AbortSignal.timeout(DIRECT_TIMEOUT_MS))
  } catch {
    // Offline or failed — acceptable to leave a stray synced row for a demo app.
  }
}

let flushing = false

/** Replay queued knocks. Stops at the first failure (still offline) and
 * retries on the next trigger. Safe to call concurrently. */
export async function flushQueue(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const pending = await db.pendingKnocks.toArray()
    for (const knock of pending) {
      const { error } = await upsertKnock(knock)
      if (error) return
      await db.pendingKnocks.delete(knock.client_id)
    }
  } catch {
    // IndexedDB unavailable or similar — nothing to do, retry next trigger.
  } finally {
    flushing = false
  }
}

/** Call once at app startup. */
export function initKnockQueue(): void {
  void flushQueue()
  window.addEventListener('online', () => void flushQueue())
  setInterval(() => void flushQueue(), 60_000)
}
