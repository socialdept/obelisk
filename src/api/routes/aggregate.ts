import { and, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { events, recordLinks, records } from '../../db/schema'
import type { ManageResult } from '../../webhooks/manage'
import { jsonPath, whereFilters, type WhereClause } from '../xrpc/where'

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

/** date_trunc buckets we allow — validated so the first arg is never free text. */
const BUCKETS = new Set(['hour', 'day', 'week', 'month', 'year'])

export type AggregateSource = 'records' | 'events' | 'links'

export interface AggregateInput {
  source?: AggregateSource
  /** One or more dimensions: a source field, a `record.<path>`, or `<timeDim>:<bucket>`. */
  groupBy?: string | string[]
  /** `count` (default) or `count_distinct:<field>`. */
  aggregate?: string
  where?: WhereClause
  since?: string
  until?: string
  /** `count` (default, desc) or one of the groupBy tokens (asc). */
  orderBy?: string
  limit?: number
  /** records/links only — include soft-deleted records (default excluded). */
  includeDeleted?: boolean
}

export interface AggregateGroup {
  key: Record<string, unknown>
  count: number
}

/**
 * One source per call, joined to `records` so the `where` DSL (which resolves
 * against the record body + system columns) works uniformly across sources.
 *
 *   • records — the archive itself; time dim `indexedAt`. Excludes soft-deleted
 *     rows unless `includeDeleted`.
 *   • events  — the change log; time dim `createdAt`. Never filters deletes out
 *     (a delete is a real event).
 *   • links   — the internal link graph; time dim `createdAt`. `collection`/`did`
 *     are the LINKING record's; target fields are `target*`. Excludes links of
 *     soft-deleted records unless `includeDeleted`.
 */
interface SourceSpec {
  name: AggregateSource
  from: SQL
  time: { name: string; col: SQL }
  dims: Record<string, SQL>
  /** Whether the deleted-record filter applies to this source by default. */
  excludesDeleted: boolean
}

const SOURCES: Record<AggregateSource, SourceSpec> = {
  records: {
    name: 'records',
    from: sql`FROM ${records}`,
    time: { name: 'indexedAt', col: sql`${records.indexedAt}` },
    dims: {
      collection: sql`${records.collection}`,
      did: sql`${records.did}`,
      rkey: sql`${records.rkey}`,
      cid: sql`${records.cid}`,
      rev: sql`${records.rev}`,
      embedStatus: sql`${records.embedStatus}`,
    },
    excludesDeleted: true,
  },
  events: {
    name: 'events',
    from: sql`FROM ${events} JOIN ${records} ON ${records.id} = ${events.recordId}`,
    time: { name: 'createdAt', col: sql`${events.createdAt}` },
    dims: {
      collection: sql`${events.collection}`,
      did: sql`${events.did}`,
      rkey: sql`${events.rkey}`,
      action: sql`${events.action}`,
      rev: sql`${events.rev}`,
      live: sql`${events.live}`,
    },
    excludesDeleted: false,
  },
  links: {
    name: 'links',
    from: sql`FROM ${recordLinks} JOIN ${records} ON ${records.id} = ${recordLinks.recordId}`,
    time: { name: 'createdAt', col: sql`${recordLinks.createdAt}` },
    dims: {
      path: sql`${recordLinks.path}`,
      targetUri: sql`${recordLinks.targetUri}`,
      targetDid: sql`${recordLinks.targetDid}`,
      targetCollection: sql`${recordLinks.targetCollection}`,
      targetRkey: sql`${recordLinks.targetRkey}`,
      collection: sql`${records.collection}`,
      did: sql`${records.did}`,
    },
    excludesDeleted: true,
  },
}

type Resolved = { expr: SQL } | { error: string }

const invalid = (message: string): ManageResult<never> => ({ error: 'InvalidRequest', message, status: 400 })

/**
 * Generic grouped aggregate behind `social.dept.obelisk.aggregate`. Builds a
 * single `GROUP BY` over one source and returns `{ groups: [{ key, count }] }`.
 * All group-by / aggregate expressions come from a per-source whitelist or a
 * parameterized JSON path — never raw user SQL; `where` values stay parameterized.
 */
export async function runAggregate(
  db: Db,
  input: AggregateInput,
): Promise<ManageResult<{ groups: AggregateGroup[] }>> {
  const spec = SOURCES[input.source ?? 'records']
  if (!spec) return invalid(`unknown source: ${input.source} (expected records, events, or links)`)

  const tokens = normalizeGroupBy(input.groupBy)
  const dims: SQL[] = []
  for (const token of tokens) {
    const resolved = resolveGroupDim(spec, token)
    if ('error' in resolved) return invalid(resolved.error)
    dims.push(resolved.expr)
  }

  const agg = parseAggregate(spec, input.aggregate)
  if ('error' in agg) return invalid(agg.error)

  const order = resolveOrder(input.orderBy, tokens)
  if ('error' in order) return invalid(order.error)

  const filters: SQL[] = []
  if (spec.excludesDeleted && !input.includeDeleted) filters.push(sql`${records.deletedAt} IS NULL`)

  if (input.where) {
    const parsed = whereFilters(input.where)
    if ('error' in parsed) return invalid(parsed.error)
    filters.push(...parsed)
  }

  if (input.since) {
    const since = new Date(input.since)
    if (Number.isNaN(since.getTime())) return invalid('invalid since (expected an ISO timestamp)')
    filters.push(sql`${spec.time.col} >= ${since}`)
  }
  if (input.until) {
    const until = new Date(input.until)
    if (Number.isNaN(until.getTime())) return invalid('invalid until (expected an ISO timestamp)')
    filters.push(sql`${spec.time.col} <= ${until}`)
  }

  const limit = clampLimit(input.limit)
  const selectDims = dims.map((expr, i) => sql`${expr} AS ${sql.raw(`g${i}`)}`)
  const selectList = sql.join([...selectDims, sql`${agg.expr} AS value`], sql`, `)
  const whereClause = filters.length ? sql`WHERE ${and(...filters)}` : sql``
  const groupClause = dims.length
    ? sql`GROUP BY ${sql.join(dims.map((_, i) => sql.raw(String(i + 1))), sql`, `)}`
    : sql``

  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT ${selectList}
    ${spec.from}
    ${whereClause}
    ${groupClause}
    ORDER BY ${order.expr}
    LIMIT ${limit}
  `)

  const groups = rows.map((row) => {
    const key: Record<string, unknown> = {}
    tokens.forEach((token, i) => {
      key[token] = row[`g${i}`]
    })
    return { key, count: Number(row.value) }
  })
  return { data: { groups } }
}

function normalizeGroupBy(groupBy: string | string[] | undefined): string[] {
  if (groupBy === undefined) return []
  return Array.isArray(groupBy) ? groupBy : [groupBy]
}

/** A groupBy token: a time bucket `<timeDim>:<bucket>`, a `record.<path>`, or a source field. */
function resolveGroupDim(spec: SourceSpec, token: string): Resolved {
  if (token.includes(':')) {
    const [name, bucket] = token.split(':', 2)
    if (name !== spec.time.name) {
      return { error: `unknown time dimension "${name}" for source "${spec.name}" (expected ${spec.time.name})` }
    }
    if (!bucket || !BUCKETS.has(bucket)) {
      return { error: `invalid time bucket "${bucket}" (expected one of ${[...BUCKETS].join(', ')})` }
    }
    return { expr: sql`date_trunc(${bucket}, ${spec.time.col})` }
  }
  return resolveField(spec, token)
}

/** A plain field: a `record.<path>` or a source-whitelisted column (no time buckets). */
function resolveField(spec: SourceSpec, token: string): Resolved {
  if (token.startsWith('record.')) return { expr: jsonPath(token.slice('record.'.length)) }
  const col = spec.dims[token]
  if (!col) {
    const allowed = [...Object.keys(spec.dims), 'record.<path>'].join(', ')
    return { error: `cannot group by "${token}" on source "${spec.name}" (allowed: ${allowed})` }
  }
  return { expr: col }
}

function parseAggregate(spec: SourceSpec, aggregate: string | undefined): Resolved {
  const agg = aggregate ?? 'count'
  if (agg === 'count') return { expr: sql`count(*)` }
  if (agg.startsWith('count_distinct:')) {
    const field = agg.slice('count_distinct:'.length)
    const resolved = resolveField(spec, field)
    if ('error' in resolved) return resolved
    return { expr: sql`count(DISTINCT ${resolved.expr})` }
  }
  return { error: `unknown aggregate "${agg}" (expected count or count_distinct:<field>)` }
}

/** `count` (default) → the aggregate value desc; else an ordinal into the groupBy list, asc. */
function resolveOrder(orderBy: string | undefined, tokens: string[]): Resolved {
  if (!orderBy || orderBy === 'count') return { expr: sql`value DESC` }
  const i = tokens.indexOf(orderBy)
  if (i === -1) return { error: `cannot order by "${orderBy}" (expected count or a groupBy dimension)` }
  return { expr: sql`${sql.raw(String(i + 1))} ASC` }
}

function clampLimit(raw: unknown): number {
  const limit = Number(raw ?? DEFAULT_LIMIT)
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}
