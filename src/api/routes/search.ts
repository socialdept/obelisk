import { Hono } from 'hono'
import { sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/client'
import type { OllamaClient } from '../../embed/ollama'
import { parseLimit, recordJsonFilters } from './records'

function andAll(filters: SQL[]): SQL {
  return filters.length > 0 ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``
}

export function searchRoutes(db: Db, ollama: OllamaClient): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const q = c.req.query('q')
    if (!q) return c.json({ error: 'q is required' }, 400)

    const limit = parseLimit(c.req.query('limit'))
    const collection = c.req.query('collection')
    const did = c.req.query('did')

    const rows = await db.execute(sql`
      SELECT did, collection, rkey, uri, record, indexed_at,
             ts_rank(searchable, websearch_to_tsquery('english', ${q})) AS rank
      FROM records
      WHERE searchable @@ websearch_to_tsquery('english', ${q})
        AND deleted_at IS NULL
        ${collection ? sql`AND collection = ${collection}` : sql``}
        ${did ? sql`AND did = ${did}` : sql``}
        ${andAll(recordJsonFilters(c.req.query()))}
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    return c.json({ results: rows })
  })

  app.get('/semantic', async (c) => {
    const q = c.req.query('q')
    if (!q) return c.json({ error: 'q is required' }, 400)

    const limit = parseLimit(c.req.query('limit'))
    const collection = c.req.query('collection')

    const [queryVector] = await ollama.embed([q])
    const vec = JSON.stringify(queryVector)

    const rows = await db.execute(sql`
      SELECT records.did, records.collection, records.rkey, records.uri, records.record, records.indexed_at,
             t.distance, t.chunk_text
      FROM (
        SELECT DISTINCT ON (record_id) record_id, distance, chunk_text
        FROM (
          SELECT record_id, chunk_text, embedding <=> ${vec}::vector AS distance
          FROM record_embeddings
          ORDER BY embedding <=> ${vec}::vector
          LIMIT 100
        ) nn
        ORDER BY record_id, distance
      ) t
      JOIN records ON records.id = t.record_id
      WHERE records.deleted_at IS NULL
        ${collection ? sql`AND records.collection = ${collection}` : sql``}
        ${andAll(recordJsonFilters(c.req.query()))}
      ORDER BY t.distance
      LIMIT ${limit}
    `)

    return c.json({ results: rows })
  })

  return app
}
