import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { audienceFilter, findAudience } from '../../audiences/definition'
import type { ObeliskConfig } from '../../config'
import type { Db } from '../../db/client'
import { records } from '../../db/schema'
import { buildFeedFilter, linkFilters } from '../../feeds/filter'
import type { RankingProfile } from '../../ranking/config'
import {
  compileRanking,
  decodeRankingCursor,
  encodeRankingCursor,
  rankingAnchor,
  rankingCursorFilter,
  type RankingCursor,
} from '../../ranking/compile'
import { localInteractionCount } from '../../ranking/interactions'
import { whereFilters, type WhereClause } from '../xrpc/where'
import { clampLimit } from './records'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

/** Chrono default: no active terms → score 0 → the compiler orders by id DESC. */
const CHRONO: RankingProfile = { signals: [{ kind: 'relevance', weight: 1 }] }

export interface RankedFeedInput {
  collection?: string
  audience?: string
  /** following-style link feed, e.g. `following:<did>`. */
  feed?: string
  where?: WhereClause
  /** Raw query record — carries `link.*` filters, same as getEvents. */
  link?: Record<string, string>
  ranking?: string
  cursor?: string
  limit?: number
}

export interface RankedFeedResult {
  feed: { post: string }[]
  cursor: string | null
}

/**
 * A ranked feed skeleton (LAB-44). Filters archived records by feed / audience /
 * where / link, orders them by a named ranking profile (chrono when none), and
 * returns `{ feed: [{ post: uri }], cursor }` — the app.bsky-`getFeedSkeleton`
 * shape. **Not** a public endpoint: this is served over Obelisk's authenticated
 * service plane; the consuming app relays it into its own feed generator (viewer
 * JWT / DID-doc service declaration stay app-side). Returns `{ error }` on a bad
 * ranking / audience / feed (all 400s upstream).
 */
export async function rankedFeed(
  db: Db,
  config: ObeliskConfig,
  input: RankedFeedInput,
): Promise<RankedFeedResult | { error: string }> {
  const profile = input.ranking ? config.rankings?.[input.ranking] : CHRONO
  if (!profile) return { error: `unknown ranking profile: ${input.ranking}` }

  const filters: SQL[] = [isNull(records.deletedAt)]
  if (input.collection) filters.push(eq(records.collection, input.collection))

  if (input.where) {
    const parsed = whereFilters(input.where)
    if ('error' in parsed) return { error: parsed.error }
    filters.push(...parsed)
  }

  if (input.audience) {
    const audience = await findAudience(db, input.audience)
    if (!audience) return { error: `unknown audience: ${input.audience}` }
    filters.push(audienceFilter(sql`${records.did}`, audience.definition))
  }

  if (input.feed) {
    const parsed = await buildFeedFilter(db, input.feed, config, sql`${records.id}`)
    if ('error' in parsed) return { error: parsed.error }
    filters.push(parsed.filter)
  }

  if (input.link) filters.push(...linkFilters(input.link, sql`${records.id}`))

  // Cursor carries the `now` anchor so recency scores are stable across pages.
  let prev: RankingCursor | undefined
  if (input.cursor) {
    const decoded = decodeRankingCursor(input.cursor)
    if ('error' in decoded) return { error: decoded.error }
    prev = decoded
  }
  const { anchorMs, anchor } = rankingAnchor(prev)

  const compiled = compileRanking(profile, {
    idColumn: sql`records.id`,
    now: anchor,
    interactionCount: localInteractionCount,
  })
  const cursorClause = prev ? rankingCursorFilter(compiled.score, sql`records.id`, prev.score, prev.id) : sql`TRUE`

  const rows = await db.execute<{ uri: string; id: number; score: number }>(sql`
    SELECT records.uri AS uri, records.id AS id, (${compiled.score})::double precision AS score
    FROM records
    WHERE ${and(...filters)} AND ${cursorClause}
    ORDER BY ${compiled.orderBy}
    LIMIT ${clampLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT)}
  `)

  const last = rows.at(-1)
  return {
    feed: rows.map((row) => ({ post: row.uri })),
    cursor: last ? encodeRankingCursor({ score: Number(last.score), id: last.id, anchorMs }) : null,
  }
}
