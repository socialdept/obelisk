import { sql, type SQL } from 'drizzle-orm'
import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'

/**
 * Link-based event filters. Unlike audiences (sets of DIDs), these match on
 * what a record LINKS TO — precise enough for feeds: "documents whose `site`
 * link is one of the publications user X subscribes to".
 */

/**
 * `link.<path>=<target>` query params → records with that exact link.
 * Written as `record_id IN (…)` rather than a correlated EXISTS so Postgres
 * resolves the (small, target_uri-indexed) link set first instead of probing
 * per event row.
 */
export function linkFilters(query: Record<string, string>, recordIdColumn: SQL): SQL[] {
  const filters: SQL[] = []
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('link.')) continue
    const path = key.slice('link.'.length)
    filters.push(sql`${recordIdColumn} IN (
      SELECT fl.record_id FROM record_links fl
      WHERE fl.path = ${path} AND fl.target_uri = ${value}
    )`)
  }
  return filters
}

/**
 * `feed=following:<did>` — records linking to any target that <did>'s
 * subscription records point at. Collection/path come from config so the
 * following semantics aren't hardcoded to Standard.site.
 *
 * Two-step on purpose: the followed-target list is resolved app-side first
 * and inlined as literals. Inlining it as a nested subquery let the planner
 * invert it into a per-event-row correlated re-evaluation (minutes on a 76k
 * event log); with literals it's one indexed lookup per target.
 */
export async function buildFeedFilter(
  db: Db,
  feed: string,
  config: ObeliskConfig,
  recordIdColumn: SQL,
): Promise<{ filter: SQL } | { error: string }> {
  if (!feed.startsWith('following:')) return { error: `unknown feed type: ${feed}` }

  const did = feed.slice('following:'.length)
  if (!did.startsWith('did:')) return { error: 'feed=following: requires a DID' }

  const following = config.feeds.following
  const targets = await db.execute<{ target_uri: string }>(sql`
    SELECT DISTINCT sl.target_uri FROM record_links sl
    JOIN records sr ON sr.id = sl.record_id
    WHERE sr.did = ${did}
      AND sr.collection = ${following.collection}
      AND sl.path = ${following.path}
      AND sr.deleted_at IS NULL
  `)

  if (targets.length === 0) return { filter: sql`false` }

  const items = sql.join(targets.map((t) => sql`${t.target_uri}`), sql`, `)
  return {
    filter: sql`${recordIdColumn} IN (
      SELECT fl.record_id FROM record_links fl
      WHERE fl.target_uri IN (${items})
    )`,
  }
}
