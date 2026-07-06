import { Hono } from 'hono'
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { ObeliskConfig } from '../../config'
import type { ConstellationClient } from '../../constellation/client'
import type { Db } from '../../db/client'
import type { EmbeddingProvider } from '../../embed/provider'
import type { LexiconRegistry } from '../../lexicon/registry'
import type { TabAdmin } from '../../ingest/tab-admin'
import type { FetchFn } from '../../webhooks/worker'
import { records } from '../../db/schema'
import { xrpcError, type XrpcContext } from './respond'
import { SERVICE_NS, handleServiceMethod } from './service'
import { sortClause, whereFilters, type WhereClause } from './where'
import {
  compileRanking,
  decodeRankingCursor,
  encodeRankingCursor,
  rankingAnchor,
  rankingCursorFilter,
  type RankingCursor,
} from '../../ranking/compile'
import { localInteractionCount } from '../../ranking/interactions'
import type { RankingProfile } from '../../ranking/config'
import type { Blocklist } from '../../ingest/blocklist'
import type { ColdList, ColdPdsList } from '../../ingest/cold'
import type { PdsBlocklist } from '../../ingest/pds-blocklist'
import type { SseGuard } from '../ratelimit'
import { computeFacets, highlightExpr, type FacetBucket } from '../routes/search-enrich'
import { clampLimit } from '../routes/records'

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
  mode?: 'fts' | 'semantic' | 'hybrid'
  ranking?: string
  highlight?: boolean
  facets?: string[]
  /** Exclude cold-storage records (LAB-68). searchRecords sets this by default
   *  (cold is hidden unless `includeCold`); getRecords/countRecords honor it raw
   *  (default off). Semantic search excludes cold intrinsically — no embeddings. */
  excludeCold?: boolean
  /** searchRecords only: surface cold-storage records that are hidden by default. */
  includeCold?: boolean
}

const RRF_K = 60
const RETRIEVE_K = 100

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
  ollama: EmbeddingProvider
  config: ObeliskConfig
  constellation: ConstellationClient
  lexicons: LexiconRegistry
  tab: TabAdmin
  /** Injectable for testWebhook delivery; defaults to global fetch. */
  fetchFn?: FetchFn
  /** Shared DID deny-list (LAB-47). */
  blocklist: Blocklist
  /** Shared PDS deny-list (LAB-48). */
  pdsBlocklist: PdsBlocklist
  /** Shared cold DID list (LAB-68). */
  coldList: ColdList
  /** Shared cold PDS list (LAB-68). */
  coldPdsList: ColdPdsList
  /** Live-tail concurrency guard (LAB-52). */
  sse?: SseGuard
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
        return searchRecords(c, db, ollama, deps.config, collection)
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

  const limit = clampLimit(body.limit, 50, MAX_LIMIT)
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

async function searchRecords(
  c: XrpcContext,
  db: Db,
  ollama: EmbeddingProvider,
  config: ObeliskConfig,
  collection: string,
) {
  const body = await parseBody(c)
  if (!body.q || typeof body.q !== 'string') {
    return xrpcError(c, 400, 'InvalidRequest', 'q is required')
  }

  // Search hides cold-storage records by default (LAB-68) — pass includeCold to
  // surface them. Browsing (getRecords/countRecords) is unaffected: an explicit
  // did/uri query still returns everything.
  const built = buildFilters(collection, { ...body, excludeCold: !body.includeCold })
  if ('error' in built) return xrpcError(c, 400, 'InvalidRequest', built.error)
  const limit = clampLimit(body.limit, 50, MAX_LIMIT)

  const mode = body.mode ?? (body.semantic ? 'semantic' : 'fts')
  if (mode !== 'fts' && mode !== 'semantic' && mode !== 'hybrid') {
    return xrpcError(c, 400, 'InvalidRequest', `unknown mode: ${mode} (expected fts, semantic, or hybrid)`)
  }

  // Facets (LAB-42): group counts over the same keyword predicate + filters,
  // computed once and merged into whichever mode's response is returned.
  let facets: Record<string, FacetBucket[]> | undefined
  if (body.facets) {
    const computed = await computeFacets(db, body.q, built.filters, body.facets)
    if ('error' in computed) return xrpcError(c, 400, 'InvalidRequest', computed.error)
    facets = computed.facets
  }

  if (mode === 'hybrid') return hybridSearch(c, db, ollama, config, body, built.filters, limit, facets)

  if (mode === 'fts' && body.ranking) return rankedSearch(c, db, config, body, built.filters, limit, facets)

  if (mode === 'semantic' && body.ranking) {
    return xrpcError(c, 400, 'InvalidRequest', 'semantic ranking is not supported yet — use mode "hybrid" (LAB-41)')
  }

  if (mode === 'semantic') {
    const embedded = await embedQuery(ollama, body.q)
    if ('error' in embedded) return xrpcError(c, 503, 'ServiceUnavailable', embedded.error)
    const vec = JSON.stringify(embedded.vector)
    const rows = await db.execute<RecordRowRaw & { distance: number; highlight?: string }>(sql`
      SELECT records.did, records.collection, records.rkey, records.uri, records.cid,
             records.record, records.indexed_at, t.distance ${highlightColumn(body)}
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
    return c.json({ records: rows.map((row) => ({ ...serialize(row), distance: row.distance })), ...(facets && { facets }) })
  }

  const rows = await db.execute<RecordRowRaw & { rank: number; highlight?: string }>(sql`
    SELECT did, collection, rkey, uri, cid, record, indexed_at,
           ts_rank(searchable, websearch_to_tsquery('english', ${body.q})) AS rank ${highlightColumn(body)}
    FROM records
    WHERE searchable @@ websearch_to_tsquery('english', ${body.q})
      AND ${and(...built.filters)}
    ORDER BY rank DESC
    LIMIT ${limit}
  `)
  return c.json({ records: rows.map((row) => ({ ...serialize(row), rank: row.rank })), ...(facets && { facets }) })
}

/**
 * Keyword search ordered by a named ranking profile instead of raw `ts_rank`.
 * FTS relevance feeds the profile's `relevance` signal; recency/interactions add
 * to the score. Paged with the ranking compound `(score, id)` cursor.
 */
async function rankedSearch(
  c: XrpcContext,
  db: Db,
  config: ObeliskConfig,
  body: QueryBody,
  filters: SQL[],
  limit: number,
  facets?: Record<string, FacetBucket[]>,
) {
  const profile = config.rankings?.[body.ranking!]
  if (!profile) return xrpcError(c, 400, 'InvalidRequest', `unknown ranking profile: ${body.ranking}`)

  return runRanked(c, db, body, limit, facets, {
    profile,
    ctes: sql``,
    from: sql`FROM records`,
    where: sql`searchable @@ websearch_to_tsquery('english', ${body.q!}) AND ${and(...filters)}`,
    relevance: sql`ts_rank(searchable, websearch_to_tsquery('english', ${body.q!}))`,
  })
}

/**
 * Hybrid search: fuse the FTS and vector rankings with Reciprocal Rank Fusion
 * (`Σ 1/(k + rankᵢ)`, k=60) into one relevance signal, so a doc strong in either
 * leg surfaces without tuning the `ts_rank`-vs-distance scale mismatch. The fused
 * relevance then feeds a ranking profile (an implicit relevance-only one when no
 * `ranking` is given), so recency/interactions compose on top.
 */
async function hybridSearch(
  c: XrpcContext,
  db: Db,
  ollama: EmbeddingProvider,
  config: ObeliskConfig,
  body: QueryBody,
  filters: SQL[],
  limit: number,
  facets?: Record<string, FacetBucket[]>,
) {
  const profile = body.ranking ? config.rankings?.[body.ranking] : RELEVANCE_ONLY
  if (!profile) return xrpcError(c, 400, 'InvalidRequest', `unknown ranking profile: ${body.ranking}`)

  const embedded = await embedQuery(ollama, body.q!)
  if ('error' in embedded) return xrpcError(c, 503, 'ServiceUnavailable', embedded.error)
  const vec = JSON.stringify(embedded.vector)
  const q = body.q!

  // Two ranked legs → RRF-fused relevance, filters applied inside each leg.
  const ctes = sql`WITH fts AS (
      SELECT records.id AS id, row_number() OVER (ORDER BY ts_rank(searchable, websearch_to_tsquery('english', ${q})) DESC) AS rank
      FROM records
      WHERE searchable @@ websearch_to_tsquery('english', ${q}) AND ${and(...filters)}
      ORDER BY ts_rank(searchable, websearch_to_tsquery('english', ${q})) DESC
      LIMIT ${RETRIEVE_K}
    ),
    vec AS (
      SELECT id, row_number() OVER (ORDER BY distance) AS rank FROM (
        SELECT DISTINCT ON (nn.record_id) nn.record_id AS id, nn.distance
        FROM (
          SELECT record_id, embedding <=> ${vec}::vector AS distance
          FROM record_embeddings ORDER BY embedding <=> ${vec}::vector LIMIT ${RETRIEVE_K}
        ) nn
        JOIN records ON records.id = nn.record_id
        WHERE ${and(...filters)}
        ORDER BY nn.record_id, nn.distance
      ) d ORDER BY distance LIMIT ${RETRIEVE_K}
    ),
    fused AS (
      SELECT coalesce(fts.id, vec.id) AS id,
             coalesce(1.0 / (${RRF_K} + fts.rank), 0) + coalesce(1.0 / (${RRF_K} + vec.rank), 0) AS relevance
      FROM fts FULL OUTER JOIN vec ON fts.id = vec.id
    ) `

  return runRanked(c, db, body, limit, facets, {
    profile,
    ctes,
    from: sql`FROM fused JOIN records ON records.id = fused.id`,
    where: sql`TRUE`,
    relevance: sql`fused.relevance`,
  })
}

/**
 * Embed a query vector, turning an Ollama outage into a clean result instead of
 * a thrown 500 (LAB-56). The caller maps the error to a 503 so `mode: fts` keeps
 * working while the embedding backend is down.
 */
async function embedQuery(ollama: EmbeddingProvider, q: string): Promise<{ vector: number[] } | { error: string }> {
  try {
    const [vector] = await ollama.embed([q])
    if (!vector) return { error: 'semantic search unavailable: embedding backend returned no vector' }
    return { vector }
  } catch {
    return { error: 'semantic search unavailable: embedding backend unreachable' }
  }
}

/** An implicit profile for hybrid search with no explicit ranking: relevance only. */
const RELEVANCE_ONLY: RankingProfile = { signals: [{ kind: 'relevance', weight: 1 }] }

interface RankedQuery {
  profile: RankingProfile
  ctes: SQL
  from: SQL
  where: SQL
  relevance: SQL
}

/**
 * Shared ranked-query core: compile the profile's score with the given relevance,
 * page with the compound `(score, id)` cursor (whose `now` anchor keeps recency
 * scores stable across pages), and serialize with the per-row score.
 */
async function runRanked(
  c: XrpcContext,
  db: Db,
  body: QueryBody,
  limit: number,
  facets: Record<string, FacetBucket[]> | undefined,
  q: RankedQuery,
) {
  let prev: RankingCursor | undefined
  if (body.cursor) {
    const decoded = decodeRankingCursor(body.cursor)
    if ('error' in decoded) return xrpcError(c, 400, 'InvalidRequest', decoded.error)
    prev = decoded
  }
  const { anchorMs, anchor } = rankingAnchor(prev)

  const compiled = compileRanking(q.profile, {
    relevance: q.relevance,
    idColumn: sql`records.id`,
    now: anchor,
    interactionCount: localInteractionCount,
  })

  const cursorClause = prev ? rankingCursorFilter(compiled.score, sql`records.id`, prev.score, prev.id) : sql`TRUE`

  const rows = await db.execute<RecordRowRaw & { id: number; score: number; highlight?: string }>(sql`
    ${q.ctes}
    SELECT records.did, records.collection, records.rkey, records.uri, records.cid,
           records.record, records.indexed_at, records.id AS id,
           (${compiled.score})::double precision AS score ${highlightColumn(body)}
    ${q.from}
    WHERE ${q.where} AND ${cursorClause}
    ORDER BY ${compiled.orderBy}
    LIMIT ${limit}
  `)

  const last = rows.at(-1)
  return c.json({
    records: rows.map((row) => ({ ...serialize(row), score: Number(row.score) })),
    cursor: last ? encodeRankingCursor({ score: Number(last.score), id: last.id, anchorMs }) : undefined,
    ...(facets && { facets }),
  })
}

function buildFilters(collection: string, body: QueryBody): { filters: SQL[] } | { error: string } {
  const filters: SQL[] = [eq(records.collection, collection)]
  if (!body.includeDeleted) filters.push(isNull(records.deletedAt))
  if (body.excludeCold) filters.push(eq(records.cold, false))

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

function serialize(row: RecordRowRaw & { highlight?: string }) {
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    collection: row.collection,
    value: row.record,
    indexedAt: row.indexed_at,
    ...(row.highlight != null && { highlight: row.highlight }),
  }
}

/** Optional `ts_headline` column for the SELECT, gated on `highlight`. */
function highlightColumn(body: QueryBody): SQL {
  return body.highlight ? sql`, ${highlightExpr(body.q!)} AS highlight` : sql``
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0
  const offset = Number(cursor)
  return Number.isInteger(offset) && offset >= 0 ? offset : null
}

