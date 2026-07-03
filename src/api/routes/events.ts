import { Hono } from 'hono'
import { and, asc, eq, gt, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { events, records } from '../../db/schema'
import { recordJsonFilters } from './records'

const MAX_LIMIT = 500

export function eventsRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const query = c.req.query()
    const limit = parseEventLimit(query.limit)

    const filters: SQL[] = []
    if (query.cursor) {
      const cursorId = Number(query.cursor)
      if (!Number.isInteger(cursorId) || cursorId < 0) return c.json({ error: 'invalid cursor' }, 400)
      filters.push(gt(events.id, cursorId))
    }
    if (query.collection) filters.push(eq(events.collection, query.collection))
    if (query.did) filters.push(eq(events.did, query.did))
    if (query.action) filters.push(eq(events.action, query.action))
    filters.push(...recordJsonFilters(query))

    const includeRecord = query.include_record === '1'

    const rows = await db
      .select({ event: events, record: records })
      .from(events)
      .innerJoin(records, eq(records.id, events.recordId))
      .where(and(...filters))
      .orderBy(asc(events.id))
      .limit(limit)

    const last = rows.at(-1)
    return c.json({
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
    })
  })

  return app
}

function parseEventLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 200)
  if (!Number.isInteger(limit) || limit < 1) return 200
  return Math.min(limit, MAX_LIMIT)
}
