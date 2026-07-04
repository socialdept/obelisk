import { and, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { columnFor } from '../xrpc/where'

const FACET_LIMIT = 20

/**
 * A `<mark>`-highlighted excerpt around the query match, over the same
 * extracted title/text the FTS `searchable` column is built from.
 */
export function highlightExpr(q: string): SQL {
  return sql`ts_headline('english',
    coalesce(records.extracted_title, '') || ' ' || coalesce(records.extracted_text, ''),
    websearch_to_tsquery('english', ${q}),
    'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=8,MaxWords=30')`
}

export interface FacetBucket {
  value: string | null
  count: number
}

/**
 * Facet counts for a search: group counts over the same keyword predicate + the
 * search's `where`/collection filters, one list per requested field (a system
 * field or a `record.<path>`). One round-trip powers a results list + a filter
 * sidebar. Reuses `columnFor` so faceting inherits the `where` DSL's field
 * resolution. Counts reflect keyword matches within the filter.
 */
export async function computeFacets(
  db: Db,
  q: string,
  filters: SQL[],
  fields: string[],
): Promise<{ facets: Record<string, FacetBucket[]> } | { error: string }> {
  const facets: Record<string, FacetBucket[]> = {}
  for (const field of fields) {
    if (typeof field !== 'string' || field === 'json') return { error: `cannot facet by "${field}"` }
    const column = columnFor(field)
    const rows = await db.execute<{ value: string | null; count: number }>(sql`
      SELECT ${column} AS value, count(*)::int AS count
      FROM records
      WHERE searchable @@ websearch_to_tsquery('english', ${q}) AND ${and(...filters)}
      GROUP BY 1
      ORDER BY count DESC, value ASC
      LIMIT ${FACET_LIMIT}
    `)
    facets[field] = rows.map((r) => ({ value: r.value, count: Number(r.count) }))
  }
  return { facets }
}
