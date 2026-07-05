import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../src/db/client'
import { records, watchedDids } from '../src/db/schema'
import { backfillRepo, type RepoRecord, type BackfillDeps } from '../src/ingest/backfill'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

const DID = 'did:plc:subject'
const REV = '3krev0000000' // snapshot commit rev

/** Injected deps so the parser/network are stubbed — real CAR parsing is covered by a live experiment. */
function deps(entries: RepoRecord[], rev = REV, batchSize?: number): BackfillDeps {
  return {
    resolvePds: async () => 'https://pds.test',
    fetchRev: async () => rev,
    openRepo: () => entries,
    batchSize,
  }
}

/** Lazily-yielding streaming source, to prove the async-iterable (streamed CAR) path. */
async function* streamEntries(entries: RepoRecord[], counter?: { peak: number }): AsyncIterable<RepoRecord> {
  let outstanding = 0
  for (const entry of entries) {
    outstanding += 1
    if (counter) counter.peak = Math.max(counter.peak, outstanding)
    yield entry
    outstanding -= 1 // consumed before the next is produced → never materialized all at once
  }
}

const rec = (collection: string, rkey: string, record: Record<string, unknown>): RepoRecord => ({
  collection,
  rkey,
  cid: `cid-${collection}-${rkey}`,
  record,
})

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.execute(sql`TRUNCATE watched_dids RESTART IDENTITY CASCADE`)
})

describe('backfillRepo', () => {
  test('imports every collection through the ingest path, independent of any filter', async () => {
    const result = await backfillRepo(db, testConfig, DID, deps([
      rec('site.standard.document', 'd1', { title: 'A doc', textContent: 'body' }),
      rec('app.bsky.feed.post', 'p1', { text: 'a post' }), // NOT a configured collection — still imported
      rec('app.bsky.feed.like', 'l1', { subject: { uri: 'at://x' } }),
    ]))

    expect(result).toMatchObject({ did: DID, rev: REV, total: 3, applied: 3, skipped: 0 })
    expect(result.byCollection).toEqual({
      'site.standard.document': 1,
      'app.bsky.feed.post': 1,
      'app.bsky.feed.like': 1,
    })

    const rows = await db.select().from(records).where(eq(records.did, DID))
    expect(rows).toHaveLength(3)
    // Records land stamped with the commit rev and queued for embedding.
    const doc = rows.find((r) => r.collection === 'site.standard.document')!
    expect(doc.rev).toBe(REV)
    expect(doc.embedStatus).toBe('pending')
    expect(doc.deletedAt).toBeNull()
  })

  test('idempotent: re-running with the same rev applies nothing', async () => {
    const entries = [rec('app.bsky.feed.post', 'p1', { text: 'hi' }), rec('app.bsky.feed.post', 'p2', { text: 'yo' })]
    await backfillRepo(db, testConfig, DID, deps(entries))

    const second = await backfillRepo(db, testConfig, DID, deps(entries))
    expect(second.applied).toBe(0)
    expect(second.skipped).toBe(2)
    expect(await db.select().from(records).where(eq(records.did, DID))).toHaveLength(2)
  })

  test('a snapshot never overwrites a newer live record (rev-compare wins)', async () => {
    // Live forward event already archived at a HIGHER rev than the snapshot commit.
    await applyEvent(db, testConfig, makeEvent({
      did: DID,
      collection: 'site.standard.document',
      rkey: 'd1',
      rev: '3zzzz9999999', // > REV
      live: true,
      record: { title: 'LIVE' },
    }))

    const result = await backfillRepo(db, testConfig, DID, deps([
      rec('site.standard.document', 'd1', { title: 'STALE SNAPSHOT' }),
    ]))
    expect(result.skipped).toBe(1)

    const row = (await db.select().from(records).where(and(eq(records.did, DID), eq(records.rkey, 'd1'))))[0]!
    expect((row.record as { title: string }).title).toBe('LIVE') // not clobbered
  })

  test('stamps snapshot_at on a watched DID; no-op for an unwatched one', async () => {
    await db.insert(watchedDids).values({ did: DID })

    await backfillRepo(db, testConfig, DID, deps([rec('app.bsky.feed.post', 'p1', { text: 'hi' })]))
    const watched = (await db.select().from(watchedDids).where(eq(watchedDids.did, DID)))[0]!
    expect(watched.snapshotAt).not.toBeNull()

    // Unwatched DID: the update matches nothing, no throw.
    const other = await backfillRepo(db, testConfig, 'did:plc:unwatched', deps([rec('app.bsky.feed.post', 'p2', { text: 'x' })]))
    expect(other.applied).toBe(1)
  })

  test('batches large repos without dropping records', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => rec('app.bsky.feed.like', `l${i}`, { i }))
    const result = await backfillRepo(db, testConfig, DID, deps(entries, REV, 10))
    expect(result.total).toBe(25)
    expect(result.applied).toBe(25)
    expect(await db.select().from(records).where(eq(records.did, DID))).toHaveLength(25)
  })

  test('streams an async-iterable repo incrementally (bounded memory, no full materialization)', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => rec('app.bsky.feed.like', `s${i}`, { i }))
    const counter = { peak: 0 }
    const result = await backfillRepo(db, testConfig, DID, {
      resolvePds: async () => 'https://pds.test',
      fetchRev: async () => REV,
      openRepo: () => streamEntries(entries, counter),
      batchSize: 10,
    })
    expect(result.applied).toBe(30)
    expect(await db.select().from(records).where(eq(records.did, DID))).toHaveLength(30)
    // Never more than one record "in hand" at a time — the whole repo is never buffered.
    expect(counter.peak).toBe(1)
  })
})
