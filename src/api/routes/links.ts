import { Hono } from 'hono'
import { and, eq, or } from 'drizzle-orm'
import type { Db } from '../../db/client'
import type { ConstellationClient } from '../../constellation/client'
import { recordLinks, records } from '../../db/schema'
import { serializeRecord } from './records'

/** Routes mounted under /records/:did/:collection/:rkey — link graph queries. */
export function linksRoutes(db: Db, constellation: ConstellationClient): Hono {
  const app = new Hono()

  app.get('/:did/:collection/:rkey/links', async (c) => {
    const uri = uriFromParams(c.req.param())
    const row = await recordByUri(db, uri)
    if (!row) return c.json({ error: 'record not found' }, 404)

    const links = await db.select().from(recordLinks).where(eq(recordLinks.recordId, row.id))
    return c.json({
      uri,
      links: links.map((link) => ({
        path: link.path,
        targetUri: link.targetUri,
        targetDid: link.targetDid,
        targetCollection: link.targetCollection,
        targetRkey: link.targetRkey,
      })),
    })
  })

  app.get('/:did/:collection/:rkey/backlinks', async (c) => {
    const uri = uriFromParams(c.req.param())
    const collection = c.req.query('collection')
    const path = c.req.query('path')

    const filters = [or(eq(recordLinks.targetUri, uri), eq(recordLinks.targetDid, uri))!]
    if (path) filters.push(eq(recordLinks.path, path))
    if (collection) filters.push(eq(records.collection, collection))

    const rows = await db
      .select({ link: recordLinks, source: records })
      .from(recordLinks)
      .innerJoin(records, eq(records.id, recordLinks.recordId))
      .where(and(...filters))
      .limit(200)

    return c.json({
      uri,
      backlinks: rows
        .filter(({ source }) => source.deletedAt === null)
        .map(({ link, source }) => ({ path: link.path, source: serializeRecord(source) })),
    })
  })

  app.get('/:did/:collection/:rkey/backlinks/network', async (c) => {
    const uri = uriFromParams(c.req.param())
    const collection = c.req.query('collection')
    const path = c.req.query('path')
    const wantCount = c.req.query('count') === '1'

    const endpoint = collection && path ? (wantCount ? 'links/count' : 'links') : 'links/all/count'

    const result = await constellation
      .query(endpoint, { target: uri, collection, path, cursor: c.req.query('cursor') })
      .catch((err) => {
        console.error('constellation query failed', err)
        return null
      })
    if (!result) return c.json({ error: 'constellation unavailable' }, 502)

    return c.json({
      uri,
      endpoint,
      data: result.data,
      meta: { cached: result.cached, stale: result.stale, fetchedAt: result.fetchedAt },
    })
  })

  return app
}

function uriFromParams(params: Record<string, string>): string {
  return `at://${params.did}/${params.collection}/${params.rkey}`
}

async function recordByUri(db: Db, uri: string) {
  const rows = await db.select({ id: records.id }).from(records).where(eq(records.uri, uri)).limit(1)
  return rows[0]
}
