import { and, asc, desc, eq, gt, gte, lt, lte, sql, type SQL } from 'drizzle-orm'
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
 * Cursor-paged change log query behind the social.dept.obelisk.getEvents XRPC
 * method. `query` is the raw query-param record. `since`/`until` bound the
 * event `created_at` (ISO timestamps, inclusive). `order` is `asc` (default,
 * oldest-first replay) or `desc` (newest-first) — the cursor stays a monotonic
 * event id and pages the chosen direction. Returns `{ error }` on a client
 * mistake (bad cursor / bad since|until / bad order / unknown audience / bad
 * feed) — all 400s.
 */
export async function queryEvents(
  db: Db,
  config: ObeliskConfig,
  query: Record<string, string | undefined>,
): Promise<EventsResult | { error: string }> {
  const limit = parseEventLimit(query.limit)

  const order = query.order ?? 'asc'
  if (order !== 'asc' && order !== 'desc') return { error: `invalid order: ${order} (expected asc or desc)` }

  const filters: SQL[] = []
  if (query.cursor) {
    const cursorId = Number(query.cursor)
    if (!Number.isInteger(cursorId) || cursorId < 0) return { error: 'invalid cursor' }
    // Page in the requested direction: past the cursor id, away from where we started.
    filters.push(order === 'desc' ? lt(events.id, cursorId) : gt(events.id, cursorId))
  }
  if (query.since) {
    const since = new Date(query.since)
    if (Number.isNaN(since.getTime())) return { error: 'invalid since (expected an ISO timestamp)' }
    filters.push(gte(events.createdAt, since))
  }
  if (query.until) {
    const until = new Date(query.until)
    if (Number.isNaN(until.getTime())) return { error: 'invalid until (expected an ISO timestamp)' }
    filters.push(lte(events.createdAt, until))
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
    .orderBy(order === 'desc' ? desc(events.id) : asc(events.id))
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

function parseEventLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 200)
  if (!Number.isInteger(limit) || limit < 1) return 200
  return Math.min(limit, MAX_LIMIT)
}
