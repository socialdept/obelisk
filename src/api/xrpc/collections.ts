import { Hono } from 'hono'
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { ObeliskConfig } from '../../config'
import type { ConstellationClient } from '../../constellation/client'
import type { Db } from '../../db/client'
import type { OllamaClient } from '../../embed/ollama'
import type { LexiconRegistry } from '../../lexicon/registry'
import type { TabAdmin } from '../../ingest/tab-admin'
import type { FetchFn } from '../../webhooks/worker'
import { records } from '../../db/schema'
import { xrpcError, type XrpcContext } from './respond'
import { SERVICE_NS, handleServiceMethod } from './service'
import { sortClause, whereFilters, type WhereClause } from './where'

const NSID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\.[a-zA-Z][a-zA-Z0-9]*$/
const MAX_LIMIT = 100

interface QueryBody {
  where?: WhereClause
  sortBy?: { field: string; direction?: string }[]
  limit?: number
  cursor?: string
  includeDeleted?: boolean
  q?: string
  semantic?: boolean
}

/**
 * atproto-shaped query surface: the METHOD NSID is the archived collection
 * being queried plus a read verb —
 *
 *   POST /xrpc/site.standard.document.getRecords
 *   GET  /xrpc/site.standard.document.getRecord?uri=at://…
 *   POST /xrpc/site.standard.document.countRecords
 *   POST /xrpc/site.standard.document.searchRecords
 *
 * Read-only by design (SCOPE.md): write verbs are not implemented.
 *
 * Methods under the reserved authority `social.dept.obelisk.*` are the service
 * plane (events / types / link graph) and route to ./service.
 */
export interface XrpcDeps {
  db: Db
  ollama: OllamaClient
  config: ObeliskConfig
  constellation: ConstellationClient
  lexicons: LexiconRegistry
  tab: TabAdmin
  /** Injectable for testWebhook delivery; defaults to global fetch. */
  fetchFn?: FetchFn
}

export function xrpcRoutes(deps: XrpcDeps): Hono {
  const { db, ollama } = deps
  const app = new Hono()

  app.all('/:method', async (c) => {
    const method = c.req.param('method')

    // Service plane: Obelisk's own cross-collection / archive methods.
    if (method === SERVICE_NS || method.startsWith(`${SERVICE_NS}.`)) {
      return handleServiceMethod(method.slice(SERVICE_NS.length + 1), c, deps)
    }

    // Collection plane: {collection}.{verb}, collection = the queried NSID.
    const lastDot = method.lastIndexOf('.')
    const collection = method.slice(0, lastDot)
    const verb = method.slice(lastDot + 1)

    if (lastDot === -1 || !NSID_RE.test(collection)) {
      return xrpcError(c, 400, 'InvalidRequest', `not a valid collection NSID: ${collection}`)
    }

    switch (verb) {
      case 'getRecords':
        return getRecords(c, db, collection)
      case 'getRecord':
        return getRecord(c, db, collection)
      case 'countRecords':
        return countRecords(c, db, collection)
      case 'searchRecords':
        return searchRecords(c, db, ollama, collection)
      case 'createRecord':
      case 'updateRecord':
      case 'deleteRecord':
        return xrpcError(c, 501, 'MethodNotImplemented', 'obelisk is a read-only archive, writes go through your PDS')
      default:
        return xrpcError(c, 501, 'MethodNotImplemented', `unknown method suffix: ${verb}`)
    }
  })

  return app
}

async function parseBody(c: XrpcContext): Promise<QueryBody> {
  if (c.req.method !== 'POST') return {}
  return ((await c.req.json().catch(() => ({}))) ?? {}) as QueryBody
}

async function getRecords(c: XrpcContext, db: Db, collection: string) {
  const body = await parseBody(c)
  const built = buildFilters(collection, body)
  if ('error' in built) return xrpcError(c, 400, 'InvalidRequest', built.error)

  const order = sortClause(body.sortBy)
  if ('error' in order) return xrpcError(c, 400, 'InvalidRequest', order.error)

  const limit = clampLimit(body.limit)
  const offset = decodeCursor(body.cursor)
  if (offset === null) return xrpcError(c, 400, 'InvalidRequest', 'invalid cursor')

  const rows = await db.execute<RecordRowRaw>(sql`
    SELECT did, collection, rkey, uri, cid, record, indexed_at
    FROM records
    WHERE ${and(...built.filters)}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `)

  return c.json({
    records: rows.map(serialize),
    cursor: rows.length === limit ? String(offset + limit) : undefined,
  })
}

async function getRecord(c: XrpcContext, db: Db, collection: string) {
  const uri = c.req.query('uri')
  if (!uri) return xrpcError(c, 400, 'InvalidRequest', 'uri parameter is required')

  const rows = await db.execute<RecordRowRaw>(sql`
    SELECT did, collection, rkey, uri, cid, record, indexed_at
    FROM records
    WHERE uri = ${uri} AND collection = ${collection} AND deleted_at IS NULL
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return xrpcError(c, 404, 'RecordNotFound', `no record at ${uri}`)

  return c.json(serialize(row))
}

async function countRecords(c: XrpcContext, db: Db, collection: string) {
  const body = await parseBody(c)
  const built = buildFilters(collection, body)
  if ('error' in built) return xrpcError(c, 400, 'InvalidRequest', built.error)

  const rows = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM records WHERE ${and(...built.filters)}
  `)
  return c.json({ count: Number(rows[0]?.count ?? 0) })
}

async function searchRecords(c: XrpcContext, db: Db, ollama: OllamaClient, collection: string) {
  const body = await parseBody(c)
  if (!body.q || typeof body.q !== 'string') {
    return xrpcError(c, 400, 'InvalidRequest', 'q is required')
  }

  const built = buildFilters(collection, body)
  if ('error' in built) return xrpcError(c, 400, 'InvalidRequest', built.error)
  const limit = clampLimit(body.limit)

  if (body.semantic) {
    const [queryVector] = await ollama.embed([body.q])
    const vec = JSON.stringify(queryVector)
    const rows = await db.execute<RecordRowRaw & { distance: number }>(sql`
      SELECT records.did, records.collection, records.rkey, records.uri, records.cid,
             records.record, records.indexed_at, t.distance
      FROM (
        SELECT DISTINCT ON (record_id) record_id, distance
        FROM (
          SELECT record_id, embedding <=> ${vec}::vector AS distance
          FROM record_embeddings ORDER BY embedding <=> ${vec}::vector LIMIT 100
        ) nn ORDER BY record_id, distance
      ) t
      JOIN records ON records.id = t.record_id
      WHERE ${and(...built.filters)}
      ORDER BY t.distance
      LIMIT ${limit}
    `)
    return c.json({ records: rows.map((row) => ({ ...serialize(row), distance: row.distance })) })
  }

  const rows = await db.execute<RecordRowRaw & { rank: number }>(sql`
    SELECT did, collection, rkey, uri, cid, record, indexed_at,
           ts_rank(searchable, websearch_to_tsquery('english', ${body.q})) AS rank
    FROM records
    WHERE searchable @@ websearch_to_tsquery('english', ${body.q})
      AND ${and(...built.filters)}
    ORDER BY rank DESC
    LIMIT ${limit}
  `)
  return c.json({ records: rows.map((row) => ({ ...serialize(row), rank: row.rank })) })
}

function buildFilters(collection: string, body: QueryBody): { filters: SQL[] } | { error: string } {
  const filters: SQL[] = [eq(records.collection, collection)]
  if (!body.includeDeleted) filters.push(isNull(records.deletedAt))

  if (body.where) {
    const parsed = whereFilters(body.where)
    if ('error' in parsed) return parsed
    filters.push(...parsed)
  }
  return { filters }
}

interface RecordRowRaw {
  [key: string]: unknown
  did: string
  collection: string
  rkey: string
  uri: string
  cid: string | null
  record: unknown
  indexed_at: string | Date
}

function serialize(row: RecordRowRaw) {
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    collection: row.collection,
    value: row.record,
    indexedAt: row.indexed_at,
  }
}

function clampLimit(raw: unknown): number {
  const limit = Number(raw ?? 50)
  if (!Number.isInteger(limit) || limit < 1) return 50
  return Math.min(limit, MAX_LIMIT)
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0
  const offset = Number(cursor)
  return Number.isInteger(offset) && offset >= 0 ? offset : null
}

