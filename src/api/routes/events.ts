import { Hono } from 'hono'
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm'
import { audienceFilter, findAudience } from '../../audiences/definition'
import type { ObeliskConfig } from '../../config'
import type { Db } from '../../db/client'
import { events, records } from '../../db/schema'
import { buildFeedFilter, linkFilters } from '../../feeds/filter'
import { recordJsonFilters } from './records'

const MAX_LIMIT = 500

export interface EventsResult {
  events: unknown[]
  cursor: string | null
}

/**
 * Cursor-paged change log query shared by GET /api/v1/events and the
 * social.dept.obelisk.getEvents XRPC method. `query` is the raw query-param
 * record (same param vocabulary on both planes). Returns `{ error }` on a
 * client mistake (bad cursor / unknown audience / bad feed) — all 400s.
 */
export async function queryEvents(
  db: Db,
  config: ObeliskConfig,
  query: Record<string, string | undefined>,
): Promise<EventsResult | { error: string }> {
  const limit = parseEventLimit(query.limit)

  const filters: SQL[] = []
  if (query.cursor) {
    const cursorId = Number(query.cursor)
    if (!Number.isInteger(cursorId) || cursorId < 0) return { error: 'invalid cursor' }
    filters.push(gt(events.id, cursorId))
  }
  if (query.collection) filters.push(eq(events.collection, query.collection))
  if (query.did) filters.push(eq(events.did, query.did))
  if (query.action) filters.push(eq(events.action, query.action))
  filters.push(...recordJsonFilters(query as Record<string, string>))

  if (query.audience) {
    const audience = await findAudience(db, query.audience)
    if (!audience) return { error: `unknown audience: ${query.audience}` }
    filters.push(audienceFilter(sql`${events.did}`, audience.definition))
  }

  filters.push(...linkFilters(query as Record<string, string>, sql`${events.recordId}`))

  if (query.feed) {
    const parsed = await buildFeedFilter(db, query.feed, config, sql`${events.recordId}`)
    if ('error' in parsed) return { error: parsed.error }
    filters.push(parsed.filter)
  }

  const includeRecord = query.include_record === '1'

  const rows = await db
    .select({ event: events, record: records })
    .from(events)
    .innerJoin(records, eq(records.id, events.recordId))
    .where(and(...filters))
    .orderBy(asc(events.id))
    .limit(limit)

  const last = rows.at(-1)
  return {
    events: rows.map(({ event, record }) => ({
      cursor: String(event.id),
      uri: record.uri,
      did: event.did,
      collection: event.collection,
      rkey: event.rkey,
      action: event.action,
      rev: event.rev,
      live: event.live,
      createdAt: event.createdAt,
      ...(includeRecord && { record: event.action === 'delete' ? null : record.record }),
    })),
    cursor: last ? String(last.event.id) : null,
  }
}

export function eventsRoutes(db: Db, config: ObeliskConfig): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const result = await queryEvents(db, config, c.req.query())
    if ('error' in result) return c.json({ error: result.error }, 400)
    return c.json(result)
  })

  return app
}

function parseEventLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 200)
  if (!Number.isInteger(limit) || limit < 1) return 200
  return Math.min(limit, MAX_LIMIT)
}
