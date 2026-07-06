import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../src/db/client'
import { records, watchedDids } from '../src/db/schema'
import { backfillRepo, collectionFilter, type RepoRecord, type BackfillDeps } from '../src/ingest/backfill'
import { RepoBackfiller } from '../src/ingest/backfill-runner'
import { ColdList, ColdPdsList } from '../src/ingest/cold'
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

describe('collectionFilter', () => {
  test('uses config globs when set', () => {
    const match = collectionFilter({ ...testConfig, collectionFilters: ['site.standard.*'] })
    expect(match('site.standard.document')).toBe(true)
    expect(match('site.standard.graph.subscription')).toBe(true)
    expect(match('app.bsky.feed.post')).toBe(false)
  })

  test('falls back to the explicit collection keys when no globs', () => {
    const match = collectionFilter(testConfig) // no collectionFilters
    expect(match('site.standard.document')).toBe(true)
    expect(match('site.standard.other')).toBe(false) // not an explicit key
    expect(match('app.bsky.feed.post')).toBe(false)
  })
})

describe('backfillRepo — collection filter', () => {
  test('keeps only matching collections and reports the rest as filtered', async () => {
    const result = await backfillRepo(db, testConfig, DID, {
      ...deps([
        rec('site.standard.document', 'd1', { title: 'A doc', textContent: 'body' }),
        rec('app.bsky.feed.post', 'p1', { text: 'a post' }),
        rec('app.bsky.feed.like', 'l1', { subject: { uri: 'at://x' } }),
      ]),
      collections: collectionFilter(testConfig),
    })

    expect(result).toMatchObject({ total: 1, applied: 1, filtered: 2 })
    expect(result.byCollection).toEqual({ 'site.standard.document': 1 })
    const rows = await db.select().from(records).where(eq(records.did, DID))
    expect(rows.map((r) => r.collection)).toEqual(['site.standard.document'])
  })
})

describe('backfillRepo — listRecords fallback (getRepo 501)', () => {
  // A getRepo source that 501s on first pull — like atproto.brid.gy / a relay.
  async function* getRepo501(): AsyncGenerator<RepoRecord> {
    throw new Error(`getRepo ${DID} → 501`)
  }

  test('falls back to listRecords, scoped to configured collections, when getRepo is unsupported', async () => {
    const listed = [
      rec('site.standard.document', 'd1', { title: 'Bridged doc', textContent: 'via a bridge' }),
      rec('app.bsky.feed.post', 'p1', { text: 'noise' }), // not a configured collection
    ]
    const result = await backfillRepo(db, testConfig, DID, {
      resolvePds: async () => 'https://atproto.brid.gy',
      fetchRev: async () => REV,
      openRepo: () => getRepo501(),
      describeCollections: async () => ['site.standard.document', 'app.bsky.feed.post'],
      listRecordsSource: (_pds, _did, collections) =>
        (async function* () {
          for (const r of listed) if (collections.includes(r.collection)) yield r
        })(),
      collections: collectionFilter(testConfig),
    })

    // listRecords was asked only for the wanted collection, so p1 never arrives.
    expect(result).toMatchObject({ applied: 1, filtered: 0 })
    expect(result.rev).toBeNull() // no commit rev on the listRecords path
    const rows = await db.select().from(records).where(sql`did = ${DID}`)
    expect(rows.map((r) => r.collection)).toEqual(['site.standard.document'])
  })

  test('a non-501 error is not swallowed', async () => {
    async function* boom(): AsyncGenerator<RepoRecord> {
      throw new Error(`getRepo ${DID} → 500`)
    }
    await expect(
      backfillRepo(db, testConfig, DID, { resolvePds: async () => 'https://x', fetchRev: async () => REV, openRepo: () => boom() }),
    ).rejects.toThrow('→ 500')
  })
})

describe('backfillRepo — cold-aware', () => {
  test('a cold DID via applyOptions lands records unembedded', async () => {
    await backfillRepo(db, testConfig, DID, {
      ...deps([rec('site.standard.document', 'd1', { title: 'A doc', textContent: 'body' })]),
      applyOptions: { coldDid: (d) => d === DID },
    })
    const rows = await db.execute<{ cold: boolean; embed_status: string }>(
      sql`SELECT cold, embed_status FROM records WHERE did = ${DID}`,
    )
    expect(rows[0]).toEqual({ cold: true, embed_status: 'skipped' })
  })
})

describe('RepoBackfiller', () => {
  test('validates the did', () => {
    const runner = new RepoBackfiller(db, testConfig, new ColdList(), new ColdPdsList(db), async () => {
      throw new Error('should not run')
    })
    expect(runner.trigger({ did: 'not-a-did' })).toMatchObject({ error: expect.any(String) })
  })

  test('kicks off a scoped, cold-aware backfill and guards against a duplicate', async () => {
    const coldList = new ColdList()
    coldList.addLocal(DID)
    let captured: BackfillDeps | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const run = (async (_db, _config, _did, d) => {
      captured = d
      await gate // hold the DID in-flight so the duplicate check has something to hit
      return { did: DID, rev: REV, total: 0, applied: 0, skipped: 0, filtered: 0, byCollection: {} }
    }) as typeof backfillRepo

    const runner = new RepoBackfiller(db, testConfig, coldList, new ColdPdsList(db), run)
    expect(runner.trigger({ did: DID })).toMatchObject({ data: { did: DID, status: 'started', scope: 'configured' } })
    await Bun.sleep(10) // let execute() start and enter run()
    expect(runner.running()).toEqual([DID])
    // A second trigger while in-flight is a no-op.
    expect(runner.trigger({ did: DID })).toMatchObject({ data: { status: 'already-running' } })

    // The scoped filter and the cold decision were forwarded.
    expect(captured?.collections?.('site.standard.document')).toBe(true)
    expect(captured?.collections?.('app.bsky.feed.post')).toBe(false)
    expect(captured?.applyOptions?.coldDid?.(DID)).toBe(true)

    release()
    await Bun.sleep(10)
    expect(runner.running()).toEqual([])
  })

  test('--all omits the collection filter', async () => {
    let captured: BackfillDeps | undefined
    const run = (async (_db, _config, _did, d) => {
      captured = d
      return { did: DID, rev: REV, total: 0, applied: 0, skipped: 0, filtered: 0, byCollection: {} }
    }) as typeof backfillRepo
    const runner = new RepoBackfiller(db, testConfig, new ColdList(), new ColdPdsList(db), run)
    expect(runner.trigger({ did: DID, all: true })).toMatchObject({ data: { scope: 'all' } })
    await Bun.sleep(10)
    expect(captured?.collections).toBeUndefined()
  })
})
