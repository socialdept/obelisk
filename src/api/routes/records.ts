import { eq, isNull, sql, type SQL } from 'drizzle-orm'
import { records } from '../../db/schema'

const MAX_LIMIT = 100

/** Equality filters against record JSON, e.g. { "content.$type": "app.offprint.content" }. */
export function jsonMatcherFilters(matchers: Record<string, string>): SQL[] {
  return Object.entries(matchers).map(([path, value]) => {
    const parts = path.split('.')
    const args = sql.join(parts.map((part) => sql`${part}`), sql`, `)
    return sql`jsonb_extract_path_text(${records.record}, ${args}) = ${value}`
  })
}

/** Same, sourced from `record.<path>=<value>` query params. */
export function recordJsonFilters(query: Record<string, string>): SQL[] {
  const matchers: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('record.')) matchers[key.slice('record.'.length)] = value
  }
  return jsonMatcherFilters(matchers)
}

export function recordFilters(query: {
  did?: string
  collection?: string
  rkey?: string
  uri?: string
  include_deleted?: string
}): SQL[] {
  const filters: SQL[] = []
  if (query.did) filters.push(eq(records.did, query.did))
  if (query.collection) filters.push(eq(records.collection, query.collection))
  if (query.rkey) filters.push(eq(records.rkey, query.rkey))
  if (query.uri) filters.push(eq(records.uri, query.uri))
  if (query.include_deleted !== '1') filters.push(isNull(records.deletedAt))
  return filters
}

export function parseLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 50)
  if (!Number.isInteger(limit) || limit < 1) return 50
  return Math.min(limit, MAX_LIMIT)
}

export function serializeRecord(row: typeof records.$inferSelect) {
  return {
    uri: row.uri,
    did: row.did,
    collection: row.collection,
    rkey: row.rkey,
    cid: row.cid,
    rev: row.rev,
    record: row.record,
    indexedAt: row.indexedAt,
    deletedAt: row.deletedAt,
  }
}
