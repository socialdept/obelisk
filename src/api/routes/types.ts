import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { deriveTextFields, type ExternalResolver } from '../../lexicon/fields'
import type { LexiconRegistry } from '../../lexicon/registry'

const MAX_MEMBERS = 10

/** Inventory of $type values observed in the archive, keyed by path → nsid → count. */
export async function getTypeInventory(
  db: Db,
  opts: { collection?: string; path?: string } = {},
): Promise<Record<string, Record<string, number>>> {
  const { collection, path } = opts
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
  return types
}

/** Usage + resolved lexicon + derived text fields + observed union members for one nsid. */
export async function getTypeDetail(db: Db, registry: LexiconRegistry, nsid: string) {
  const resolveExternal: ExternalResolver = async (ref) => (await registry.get(ref)).schema

  const usage = await db.execute<{ path: string; collection: string; count: string }>(sql`
    SELECT rt.path, r.collection, count(*) AS count
    FROM record_types rt
    JOIN records r ON r.id = rt.record_id
    WHERE rt.nsid = ${nsid} AND r.deleted_at IS NULL
    GROUP BY rt.path, r.collection
    ORDER BY count(*) DESC
  `)

  const entry = await registry.get(nsid)
  const textFields = entry.schema ? await deriveTextFields(entry.schema, resolveExternal) : null
  const members = await observedMembers(db, nsid, resolveExternal)

  return {
    nsid,
    usage: usage.map((row) => ({ path: row.path, collection: row.collection, count: Number(row.count) })),
    lexicon: entry.schema,
    lexiconError: entry.error,
    resolvedAt: entry.resolvedAt,
    textFields,
    members,
  }
}

export function typesRoutes(db: Db, registry: LexiconRegistry): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const types = await getTypeInventory(db, {
      collection: c.req.query('collection'),
      path: c.req.query('path'),
    })
    return c.json({ types })
  })

  app.get('/:nsid', async (c) => {
    return c.json(await getTypeDetail(db, registry, c.req.param('nsid')))
  })

  return app
}

/**
 * $types observed nested inside this type's records (same record, deeper
 * path) — fills the gap lexicons can't: open unions like pckt's
 * `items: {type: 'union', refs: []}` only reveal their members in real data.
 */
async function observedMembers(db: Db, nsid: string, resolveExternal: ExternalResolver) {
  const rows = await db.execute<{ path: string; nsid: string; count: string }>(sql`
    SELECT rt_child.path, rt_child.nsid, count(*) AS count
    FROM record_types rt_parent
    JOIN record_types rt_child ON rt_child.record_id = rt_parent.record_id
    WHERE rt_parent.nsid = ${nsid}
      AND rt_child.path <> rt_parent.path
      AND rt_child.path LIKE (
        CASE WHEN rt_parent.path = '$type' THEN ''
             ELSE left(rt_parent.path, length(rt_parent.path) - length('.$type'))
        END || '%'
      )
    GROUP BY rt_child.path, rt_child.nsid
    ORDER BY count(*) DESC
    LIMIT ${MAX_MEMBERS}
  `)

  return Promise.all(
    rows.map(async (row) => {
      const schema = await resolveExternal(row.nsid).catch(() => null)
      return {
        nsid: row.nsid,
        path: row.path,
        count: Number(row.count),
        textFields: schema ? await deriveTextFields(schema, resolveExternal) : null,
      }
    }),
  )
}
