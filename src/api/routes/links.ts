import { and, eq, or } from 'drizzle-orm'
import type { Db } from '../../db/client'
import type { ConstellationClient } from '../../constellation/client'
import { recordLinks, records } from '../../db/schema'
import { serializeRecord } from './records'

export interface LinkOut {
  path: string
  targetUri: string | null
  targetDid: string | null
  targetCollection: string | null
  targetRkey: string | null
}

/** Outgoing AT Proto references extracted from a record. null = record not found. */
export async function getRecordLinks(db: Db, uri: string): Promise<LinkOut[] | null> {
  const row = await recordByUri(db, uri)
  if (!row) return null

  const links = await db.select().from(recordLinks).where(eq(recordLinks.recordId, row.id))
  return links.map((link) => ({
    path: link.path,
    targetUri: link.targetUri,
    targetDid: link.targetDid,
    targetCollection: link.targetCollection,
    targetRkey: link.targetRkey,
  }))
}

/** Records in the archive that reference `uri`, filtered by source collection/link path. */
export async function queryBacklinks(
  db: Db,
  uri: string,
  opts: { collection?: string; path?: string } = {},
) {
  const filters = [or(eq(recordLinks.targetUri, uri), eq(recordLinks.targetDid, uri))!]
  if (opts.path) filters.push(eq(recordLinks.path, opts.path))
  if (opts.collection) filters.push(eq(records.collection, opts.collection))

  const rows = await db
    .select({ link: recordLinks, source: records })
    .from(recordLinks)
    .innerJoin(records, eq(records.id, recordLinks.recordId))
    .where(and(...filters))
    .limit(200)

  return rows
    .filter(({ source }) => source.deletedAt === null)
    .map(({ link, source }) => ({ path: link.path, source: serializeRecord(source) }))
}

/** Network-wide backlinks via Constellation (cached). null = upstream unavailable. */
export async function queryNetworkBacklinks(
  constellation: ConstellationClient,
  uri: string,
  opts: { collection?: string; path?: string; count?: boolean; cursor?: string } = {},
) {
  const { collection, path, count, cursor } = opts
  const endpoint = collection && path ? (count ? 'links/count' : 'links') : 'links/all/count'

  const result = await constellation.query(endpoint, { target: uri, collection, path, cursor }).catch((err) => {
    console.error('constellation query failed', err)
    return null
  })
  if (!result) return null

  return {
    endpoint,
    data: result.data,
    meta: { cached: result.cached, stale: result.stale, fetchedAt: result.fetchedAt },
  }
}

async function recordByUri(db: Db, uri: string) {
  const rows = await db.select({ id: records.id }).from(records).where(eq(records.uri, uri)).limit(1)
  return rows[0]
}
