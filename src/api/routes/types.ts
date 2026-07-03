import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import type { LexiconRegistry } from '../../lexicon/registry'

export function typesRoutes(db: Db, registry: LexiconRegistry): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const collection = c.req.query('collection')
    const path = c.req.query('path')

    const rows = await db.execute<{ path: string; nsid: string; count: string }>(sql`
      SELECT rt.path, rt.nsid, count(*) AS count
      FROM record_types rt
      JOIN records r ON r.id = rt.record_id
      WHERE r.deleted_at IS NULL
        ${collection ? sql`AND r.collection = ${collection}` : sql``}
        ${path ? sql`AND rt.path = ${path}` : sql``}
      GROUP BY rt.path, rt.nsid
      ORDER BY rt.path, count(*) DESC
    `)

    const types: Record<string, Record<string, number>> = {}
    for (const row of rows) {
      types[row.path] ??= {}
      types[row.path]![row.nsid] = Number(row.count)
    }

    return c.json({ types })
  })

  app.get('/:nsid', async (c) => {
    const nsid = c.req.param('nsid')

    const usage = await db.execute<{ path: string; collection: string; count: string }>(sql`
      SELECT rt.path, r.collection, count(*) AS count
      FROM record_types rt
      JOIN records r ON r.id = rt.record_id
      WHERE rt.nsid = ${nsid} AND r.deleted_at IS NULL
      GROUP BY rt.path, r.collection
      ORDER BY count(*) DESC
    `)

    const entry = await registry.get(nsid)

    return c.json({
      nsid,
      usage: usage.map((row) => ({ path: row.path, collection: row.collection, count: Number(row.count) })),
      lexicon: entry.schema,
      lexiconError: entry.error,
      resolvedAt: entry.resolvedAt,
      textFields: entry.schema ? deriveTextFields(entry.schema) : null,
    })
  })

  return app
}

/**
 * Best-effort list of string-typed property paths in a lexicon's defs —
 * a starting point for content extraction (LAB-10), not a full lex parser.
 */
export function deriveTextFields(schema: unknown): string[] {
  const fields: string[] = []
  const defs = (schema as { defs?: Record<string, unknown> }).defs
  if (!defs) return fields

  for (const [defName, def] of Object.entries(defs)) {
    collectStrings(def, defName === 'main' ? '' : `#${defName}`, fields)
  }
  return fields
}

function collectStrings(node: unknown, path: string, fields: string[]): void {
  if (node === null || typeof node !== 'object') return

  const typed = node as { type?: string; properties?: Record<string, unknown>; items?: unknown; record?: unknown }

  if (typed.record) collectStrings(typed.record, path, fields)
  if (typed.items) collectStrings(typed.items, `${path}[]`, fields)

  if (!typed.properties) return
  for (const [name, prop] of Object.entries(typed.properties)) {
    const propPath = path === '' ? name : `${path}.${name}`
    const propType = (prop as { type?: string }).type
    if (propType === 'string') {
      fields.push(propPath)
      continue
    }
    collectStrings(prop, propPath, fields)
  }
}
