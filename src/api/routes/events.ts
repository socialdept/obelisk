import { and, asc, desc, eq, gt, gte, isNull, lt, lte, sql, type SQL } from 'drizzle-orm'
import { audienceFilter, findAudience } from '../../audiences/definition'
import type { ObeliskConfig } from '../../config'
import type { Db } from '../../db/client'
import { events, records } from '../../db/schema'
import { buildFeedFilter, linkFilters } from '../../feeds/filter'
import type { ManageResult } from '../../webhooks/manage'
import { whereFilters, type WhereClause } from '../xrpc/where'
import { clampLimit, recordJsonFilters } from './records'

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
  const limit = clampLimit(query.limit, 200, MAX_LIMIT)

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

export interface BackfillEventsInput {
  collection?: string
  did?: string
  where?: WhereClause
  includeDeleted?: boolean
}

/**
 * Seed synthetic events for archived records that have **no events** — records
 * that predate the event log (the log starts at deploy; anything ingested
 * before it is invisible to a `cursor=start` consumer). Powers the
 * `social.dept.obelisk.backfillEvents` service procedure.
 *
 * Matching records get a `create` event (or `delete` for tombstoned rows when
 * `includeDeleted`), `live:false` to mark them historical, ordered by
 * `records.id` so replay order ≈ archive order. The `NOT EXISTS` guard makes it
 * idempotent — re-running only seeds records still missing an event.
 */
export async function backfillEvents(
  db: Db,
  input: BackfillEventsInput,
): Promise<ManageResult<{ seeded: number }>> {
  const filters: SQL[] = []
  if (input.collection) filters.push(eq(records.collection, input.collection))
  if (input.did) filters.push(eq(records.did, input.did))
  if (!input.includeDeleted) filters.push(isNull(records.deletedAt))
  if (input.where) {
    const parsed = whereFilters(input.where)
    if ('error' in parsed) return { error: 'InvalidRequest', message: parsed.error, status: 400 }
    filters.push(...parsed)
  }

  const unseen = sql`NOT EXISTS (SELECT 1 FROM ${events} e WHERE e.record_id = ${records.id})`
  const where = filters.length ? sql`${and(...filters)} AND ${unseen}` : unseen

  const rows = await db.execute<{ seeded: number }>(sql`
    WITH ins AS (
      INSERT INTO events (record_id, did, collection, rkey, action, rev, live)
      SELECT ${records.id}, ${records.did}, ${records.collection}, ${records.rkey},
             CASE WHEN ${records.deletedAt} IS NULL THEN 'create' ELSE 'delete' END,
             ${records.rev}, false
      FROM ${records}
      WHERE ${where}
      ORDER BY ${records.id}
      RETURNING 1
    )
    SELECT count(*)::int AS seeded FROM ins
  `)
  return { data: { seeded: rows[0]?.seeded ?? 0 } }
}
