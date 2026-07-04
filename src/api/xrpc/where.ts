import { sql, type SQL } from 'drizzle-orm'
import { records } from '../../db/schema'

/**
 * Slices-style `where` filter DSL over archived records.
 *
 *   { "title": { "contains": "atproto" },          // record field
 *     "did": { "eq": "did:plc:x" },                // system field
 *     "record.did": { "eq": "did:plc:y" },         // forced record path
 *     "condition": { "in": ["a", "b"] },
 *     "json": { "contains": "nirvana" } }          // whole-record search
 *
 * Operators: eq, contains (case-insensitive), in. Record fields support dot
 * paths (content.$type). A `record.` prefix forces a JSON-path lookup even when
 * the field name collides with a system field (so a record whose own body has a
 * `did`/`uri`/… key stays reachable). Conditions AND together.
 */

export type WhereClause = Record<string, { eq?: unknown; contains?: string; in?: unknown[] }>

const SYSTEM_FIELDS: Record<string, SQL> = {
  did: sql`${records.did}`,
  collection: sql`${records.collection}`,
  rkey: sql`${records.rkey}`,
  uri: sql`${records.uri}`,
  cid: sql`${records.cid}`,
  rev: sql`${records.rev}`,
  lang: sql`${records.lang}`,
  indexedAt: sql`${records.indexedAt}::text`,
}

export function whereFilters(where: WhereClause): SQL[] | { error: string } {
  const filters: SQL[] = []

  for (const [field, condition] of Object.entries(where)) {
    if (condition === null || typeof condition !== 'object') {
      return { error: `filter for "${field}" must be an object with eq/contains/in` }
    }

    const column = columnFor(field)
    const ops = Object.entries(condition)
    if (ops.length === 0) return { error: `filter for "${field}" has no operator` }

    for (const [op, value] of ops) {
      const filter = operatorFilter(field, column, op, value)
      if ('error' in filter) return filter
      filters.push(filter.sql)
    }
  }

  return filters
}

export function columnFor(field: string): SQL {
  if (field === 'json') return sql`${records.record}::text`

  // `record.` forces a JSON path, bypassing system-field shadowing.
  if (field.startsWith('record.')) return jsonPath(field.slice('record.'.length))

  const system = SYSTEM_FIELDS[field]
  if (system) return system

  return jsonPath(field)
}

/** jsonb_extract_path_text over the record body for a dot path (parts parameterized). */
export function jsonPath(path: string): SQL {
  const parts = path.split('.')
  const args = sql.join(parts.map((part) => sql`${part}`), sql`, `)
  return sql`jsonb_extract_path_text(${records.record}, ${args})`
}

function operatorFilter(
  field: string,
  column: SQL,
  op: string,
  value: unknown,
): { sql: SQL } | { error: string } {
  switch (op) {
    case 'eq':
      return { sql: sql`${column} = ${String(value)}` }
    case 'contains': {
      if (typeof value !== 'string') return { error: `"contains" for "${field}" requires a string` }
      return { sql: sql`${column} ILIKE ${'%' + escapeLike(value) + '%'}` }
    }
    case 'in': {
      if (!Array.isArray(value) || value.length === 0) {
        return { error: `"in" for "${field}" requires a non-empty array` }
      }
      const items = sql.join(value.map((item) => sql`${String(item)}`), sql`, `)
      return { sql: sql`${column} IN (${items})` }
    }
    default:
      return { error: `unknown operator "${op}" for "${field}" (supported: eq, contains, in)` }
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/** sortBy: [{field, direction}] over system fields or record dot paths. */
export function sortClause(
  sortBy: { field: string; direction?: string }[] | undefined,
): SQL | { error: string } {
  if (!sortBy || sortBy.length === 0) return sql`${records.id} DESC`

  const parts: SQL[] = []
  for (const { field, direction } of sortBy) {
    if (typeof field !== 'string' || field === 'json') return { error: `cannot sort by "${field}"` }
    const dir = (direction ?? 'asc').toLowerCase()
    if (dir !== 'asc' && dir !== 'desc') return { error: `direction for "${field}" must be "asc" or "desc"` }
    parts.push(sql`${columnFor(field)} ${dir === 'desc' ? sql`DESC` : sql`ASC`}`)
  }
  // Stable tiebreaker so cursor pagination never skips or repeats rows.
  parts.push(sql`${records.id} DESC`)
  return sql.join(parts, sql`, `)
}
