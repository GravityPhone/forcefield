import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})

/** PostgREST silently caps every response at the project's max_rows (1000),
 * no matter how big a .limit() the client asks for — a "load the whole set"
 * query stops being whole the moment the table outgrows a page. This pages
 * through with .range() until a short page. The factory is called once per
 * page and MUST apply a stable .order() (e.g. the primary key), or rows can
 * repeat/vanish across page boundaries. */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < pageSize) return all
  }
}
