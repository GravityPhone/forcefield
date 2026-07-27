import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})

/** How many times a single page is re-tried before the whole read gives up. */
const PAGE_ATTEMPTS = 3
/** First backoff step; doubles per attempt, plus jitter. */
const RETRY_BASE_MS = 250

/** One page, re-tried on failure.
 *
 * The point is the field, not the datacentre: these reads are 15 to 30 pages
 * wide, and they run on phones holding one bar at the edge of a village. A
 * single dropped page used to reject the whole Promise.all and take the
 * entire load down with it, so the canvasser got an empty map and a reload
 * button rather than the one page's worth of houses that actually failed.
 * Three attempts with backoff turns the overwhelmingly common failure — a
 * momentary blip — into a slightly slower load.
 *
 * Backoff is jittered because these pages go out four at a time: on a real
 * drop all four fail together, and a fixed delay would march them back into
 * the network in lockstep and collide again.
 *
 * A permanent failure (RLS refusal, a column that isn't there) still fails,
 * just ~1s later after exhausting its attempts. That's the right trade: those
 * surface in development, while blips only ever happen to somebody on a
 * porch. */
async function fetchPage<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  from: number,
  to: number,
): Promise<T[]> {
  let lastError: unknown
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BASE_MS * 2 ** (attempt - 1)
      await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff))
    }
    try {
      // Both failure shapes have to be caught here: PostgREST reports a query
      // it answered-but-refused in `error`, while a connection that never
      // completed rejects the promise outright.
      const { data, error } = await page(from, to)
      if (error) throw new Error(error.message)
      return data ?? []
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** PostgREST silently caps every response at the project's max_rows (1000),
 * no matter how big a .limit() the client asks for — a "load the whole set"
 * query stops being whole the moment the table outgrows a page. This pages
 * through with .range() until a short page, fetching pages in concurrent
 * batches so a 16-page view loads in ~4 round trips instead of 16. The
 * factory is called once per page and MUST apply a stable .order() (e.g.
 * the primary key), or rows can repeat/vanish across page boundaries.
 *
 * Individual pages retry on failure (see fetchPage) — the whole read only
 * fails once a page has genuinely given up. */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
  concurrency = 4,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += pageSize * concurrency) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        fetchPage(page, from + i * pageSize, from + (i + 1) * pageSize - 1),
      ),
    )
    for (const rows of batch) {
      all.push(...rows)
      if (rows.length < pageSize) return all
    }
  }
}
