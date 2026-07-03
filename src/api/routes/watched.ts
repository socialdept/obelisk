import { Hono, type Context } from 'hono'
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { records, watchedDids, type WatchedDidRow } from '../../db/schema'
import { TabAdmin } from '../../ingest/tab-admin'
import { parseLimit, serializeRecord } from './records'

interface WatchedInput {
  did?: string
  note?: string | null
  collections?: string[] | null
  active?: boolean
}

export interface FootprintOptions {
  includeDeleted?: boolean
  cursor?: string
  limit?: number
}

/**
 * Per-DID footprint rollup — the "show me everything this user did, deleted
 * included" convenience. Counts-by-collection always report the deleted
 * breakdown (so the archive's "we kept what the network dropped" story is
 * visible even when the timeline hides soft-deletes); the timeline itself
 * respects `includeDeleted`. `snapshotAt` bounds deletion coverage: records
 * deleted before the DID was snapshotted were never seen (LAB-27 caveat).
 *
 * Works for ANY DID, watched or not — a watched row just annotates the response.
 * Shared by the /api/v1 route and the service-plane getFootprint method so both
 * planes run the same machinery.
 */
export async function queryFootprint(db: Db, did: string, opts: FootprintOptions = {}) {
  const watchedRows = await db.select().from(watchedDids).where(eq(watchedDids.did, did)).limit(1)
  const watched = watchedRows[0]

  const byCollection = await db
    .select({
      collection: records.collection,
      count: sql<number>`count(*)::int`,
      deleted: sql<number>`count(${records.deletedAt})::int`,
    })
    .from(records)
    .where(eq(records.did, did))
    .groupBy(records.collection)
    .orderBy(desc(sql`count(*)`))

  const totals = byCollection.reduce(
    (acc, row) => ({ records: acc.records + row.count, deleted: acc.deleted + row.deleted }),
    { records: 0, deleted: 0 },
  )

  const filters = [eq(records.did, did)]
  if (!opts.includeDeleted) filters.push(isNull(records.deletedAt))
  const limit = parseLimit(String(opts.limit ?? 50))
  if (opts.cursor) {
    const cursorId = Number(Buffer.from(opts.cursor, 'base64').toString())
    if (Number.isInteger(cursorId)) filters.push(lt(records.id, cursorId))
  }

  const rows = await db
    .select()
    .from(records)
    .where(and(...filters))
    .orderBy(desc(records.id))
    .limit(limit)

  const last = rows.at(-1)
  return {
    did,
    watched: Boolean(watched),
    active: watched?.active,
    snapshotAt: watched?.snapshotAt ?? null,
    totals,
    collections: byCollection,
    records: rows.map(serializeRecord),
    cursor: rows.length === limit && last ? Buffer.from(String(last.id)).toString('base64') : null,
  }
}

function serializeWatched(row: WatchedDidRow, enrolled?: boolean) {
  return {
    did: row.did,
    note: row.note,
    collections: row.collections,
    active: row.active,
    snapshotAt: row.snapshotAt,
    addedAt: row.addedAt,
    ...(enrolled === undefined ? {} : { enrolled }),
  }
}

/** Management CRUD for the audit list. Adding/reactivating enrolls the DID in the
 *  footprint Tab (best-effort); removing/deactivating un-enrolls it. */
export function watchedRoutes(db: Db, tab: TabAdmin): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const filters = c.req.query('active') === '1' ? [eq(watchedDids.active, true)] : []
    const rows = await db
      .select()
      .from(watchedDids)
      .where(and(...filters))
      .orderBy(desc(watchedDids.addedAt))
    return c.json({ watchedDids: rows.map((r) => serializeWatched(r)) })
  })

  app.post('/', async (c) => {
    const input = (await c.req.json()) as WatchedInput
    if (!input.did) return c.json({ error: 'did is required' }, 400)

    const inserted = await db
      .insert(watchedDids)
      .values({ did: input.did, note: input.note ?? null, collections: input.collections ?? null })
      .returning()
      .catch(() => null)
    if (!inserted) return c.json({ error: 'did already watched' }, 409)

    const { enrolled } = await tab.addRepos([input.did])
    return c.json({ watchedDid: serializeWatched(inserted[0]!, enrolled) }, 201)
  })

  app.get('/:did', async (c) => {
    const row = await findWatched(db, c.req.param('did'))
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json({ watchedDid: serializeWatched(row) })
  })

  app.patch('/:did', async (c) => {
    const row = await findWatched(db, c.req.param('did'))
    if (!row) return c.json({ error: 'not found' }, 404)

    const input = (await c.req.json()) as WatchedInput
    const updates: Partial<typeof watchedDids.$inferInsert> = {}
    if (input.note !== undefined) updates.note = input.note
    if (input.collections !== undefined) updates.collections = input.collections
    if (input.active !== undefined) updates.active = input.active

    const updated = await db.update(watchedDids).set(updates).where(eq(watchedDids.id, row.id)).returning()

    let enrolled: boolean | undefined
    if (input.active !== undefined && input.active !== row.active) {
      const result = input.active ? await tab.addRepos([row.did]) : await tab.removeRepos([row.did])
      enrolled = result.enrolled
    }
    return c.json({ watchedDid: serializeWatched(updated[0]!, enrolled) })
  })

  app.delete('/:did', async (c) => {
    const row = await findWatched(db, c.req.param('did'))
    if (!row) return c.json({ error: 'not found' }, 404)

    await db.delete(watchedDids).where(eq(watchedDids.id, row.id))
    await tab.removeRepos([row.did])
    return c.json({ deleted: true })
  })

  // Footprint of a watched DID — convenience alias for /api/v1/footprint/:did.
  app.get('/:did/footprint', (c) => footprint(db, c))

  return app
}

/** Per-DID footprint rollup for ANY DID (watched or not). */
export function footprintRoutes(db: Db): Hono {
  const app = new Hono()
  app.get('/:did', (c) => footprint(db, c))
  return app
}

async function footprint(db: Db, c: Context) {
  const result = await queryFootprint(db, c.req.param('did')!, {
    includeDeleted: c.req.query('include_deleted') === '1',
    cursor: c.req.query('cursor'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
  })
  return c.json(result)
}

async function findWatched(db: Db, did: string): Promise<WatchedDidRow | undefined> {
  const rows = await db.select().from(watchedDids).where(eq(watchedDids.did, did)).limit(1)
  return rows[0]
}
