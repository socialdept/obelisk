import { eq, sql, type SQL } from 'drizzle-orm'
import { jsonMatcherFilters } from '../api/routes/records'
import type { Db } from '../db/client'
import { audiences, type AudienceDefinition } from '../db/schema'

/**
 * Audiences are queries over the archive, not synced lists: membership is
 * derived live from records/links, so a deletion on the network (e.g. an
 * unsubscribe) removes the member with zero bookkeeping.
 */

export function validateDefinition(definition: AudienceDefinition): string | null {
  switch (definition.kind) {
    case 'backlink':
      return definition.target ? null : 'backlink audiences require a target'
    case 'outlink':
      return definition.did ? null : 'outlink audiences require a did'
    case 'collection':
      return definition.collection ? null : 'collection audiences require a collection'
    case 'static':
      return Array.isArray(definition.dids) ? null : 'static audiences require a dids array'
    default:
      return `unknown audience kind: ${(definition as { kind?: string }).kind}`
  }
}

/** Subquery selecting member DIDs. Compose with IN (…) against any did column. */
export function memberDidsQuery(definition: AudienceDefinition): SQL {
  switch (definition.kind) {
    case 'backlink':
      return sql`
        SELECT DISTINCT r.did FROM record_links l
        JOIN records r ON r.id = l.record_id
        WHERE l.target_uri = ${definition.target}
          AND r.deleted_at IS NULL
          ${definition.collection ? sql`AND r.collection = ${definition.collection}` : sql``}
          ${definition.path ? sql`AND l.path = ${definition.path}` : sql``}
      `
    case 'outlink':
      return sql`
        SELECT DISTINCT l.target_did AS did FROM record_links l
        JOIN records r ON r.id = l.record_id
        WHERE r.did = ${definition.did}
          AND r.deleted_at IS NULL
          AND l.target_did IS NOT NULL
          ${definition.collection ? sql`AND r.collection = ${definition.collection}` : sql``}
          ${definition.path ? sql`AND l.path = ${definition.path}` : sql``}
      `
    case 'collection': {
      const matcherSql = jsonMatcherFilters(definition.matchers ?? {})
      return sql`
        SELECT DISTINCT did FROM records
        WHERE collection = ${definition.collection}
          AND deleted_at IS NULL
          ${matcherSql.length > 0 ? sql`AND ${sql.join(matcherSql, sql` AND `)}` : sql``}
      `
    }
    case 'static': {
      if (definition.dids.length === 0) return sql`SELECT NULL::text AS did WHERE false`
      const items = sql.join(definition.dids.map((did) => sql`${did}`), sql`, `)
      return sql`SELECT unnest(ARRAY[${items}]::text[]) AS did`
    }
  }
}

/** Filter fragment: `<didColumn> IN (members)`. */
export function audienceFilter(didColumn: SQL, definition: AudienceDefinition): SQL {
  return sql`${didColumn} IN (${memberDidsQuery(definition)})`
}

export async function findAudience(db: Db, name: string) {
  const rows = await db.select().from(audiences).where(eq(audiences.name, name))
  return rows[0]
}

export async function isMember(db: Db, definition: AudienceDefinition, did: string): Promise<boolean> {
  const rows = await db.execute<{ found: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM (${memberDidsQuery(definition)}) m WHERE m.did = ${did}) AS found`,
  )
  return rows[0]?.found ?? false
}

export async function listMembers(
  db: Db,
  definition: AudienceDefinition,
  limit: number,
  offset: number,
): Promise<string[]> {
  const rows = await db.execute<{ did: string }>(
    sql`SELECT did FROM (${memberDidsQuery(definition)}) m ORDER BY did LIMIT ${limit} OFFSET ${offset}`,
  )
  return rows.map((row) => row.did)
}

/** Total distinct members for a definition (drives the audience-builder count). */
export async function countMembers(db: Db, definition: AudienceDefinition): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM (${memberDidsQuery(definition)}) m`,
  )
  return Number(rows[0]?.n ?? 0)
}
