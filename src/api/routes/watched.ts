import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { records, watchedDids, type WatchedDidRow } from '../../db/schema'
import { TabAdmin } from '../../ingest/tab-admin'
import type { ManageResult } from '../../webhooks/manage'
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

export function serializeWatched(row: WatchedDidRow, enrolled?: boolean) {
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

export async function listWatched(db: Db, activeOnly: boolean) {
  const filters = activeOnly ? [eq(watchedDids.active, true)] : []
  const rows = await db
    .select()
    .from(watchedDids)
    .where(and(...filters))
    .orderBy(desc(watchedDids.addedAt))
  return rows.map((r) => serializeWatched(r))
}

export async function getWatched(db: Db, did: string | undefined): Promise<ManageResult<object>> {
  if (!did) return invalid('did is required')
  const row = await findWatched(db, did)
  if (!row) return notFound()
  return { data: { watchedDid: serializeWatched(row) } }
}

/** Add a watched DID and best-effort enroll it in the footprint Tab (LAB-29). */
export async function addWatched(db: Db, tab: TabAdmin, input: WatchedInput): Promise<ManageResult<object>> {
  if (!input.did) return invalid('did is required')

  const inserted = await db
    .insert(watchedDids)
    .values({ did: input.did, note: input.note ?? null, collections: input.collections ?? null })
    .returning()
    .catch(() => null)
  if (!inserted) return conflict('did already watched')

  const { enrolled } = await tab.addRepos([input.did])
  return { data: { watchedDid: serializeWatched(inserted[0]!, enrolled) } }
}

export async function updateWatched(db: Db, tab: TabAdmin, input: WatchedInput): Promise<ManageResult<object>> {
  if (!input.did) return invalid('did is required')
  const row = await findWatched(db, input.did)
  if (!row) return notFound()

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
  return { data: { watchedDid: serializeWatched(updated[0]!, enrolled) } }
}

export async function removeWatched(
  db: Db,
  tab: TabAdmin,
  did: string | undefined,
): Promise<ManageResult<{ deleted: true }>> {
  if (!did) return invalid('did is required')
  const row = await findWatched(db, did)
  if (!row) return notFound()

  await db.delete(watchedDids).where(eq(watchedDids.id, row.id))
  await tab.removeRepos([row.did])
  return { data: { deleted: true } }
}

async function findWatched(db: Db, did: string): Promise<WatchedDidRow | undefined> {
  const rows = await db.select().from(watchedDids).where(eq(watchedDids.did, did)).limit(1)
  return rows[0]
}

const invalid = (message: string) => ({ error: 'InvalidRequest', message, status: 400 as const })
const notFound = () => ({ error: 'NotFound', message: 'watched did not found', status: 404 as const })
const conflict = (message: string) => ({ error: 'AlreadyExists', message, status: 409 as const })
