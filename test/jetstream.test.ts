import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../src/db/client'
import { records } from '../src/db/schema'
import { BatchApplier } from '../src/ingest/batch-applier'
import { loadCursor, saveCursor } from '../src/ingest/cursor'
import { normalizeEvent } from '../src/ingest/jetstream'
import { setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())
beforeEach(() => truncateAll(db))

/**
 * Captured verbatim from wss://jetstream.us-west.bsky.network on 2026-08-16,
 * so the parser is pinned to the wire rather than to a reading of the docs.
 */
const LIVE_COMMIT = {
  $type: 'network.bsky.jetstream.subscribeEvents#commit',
  cid: 'bafyreifyvx4dw32x3n4lykcf62ate7n5z7j6n3kekhbfqaxnmplfyxvety',
  collection: 'app.bsky.feed.post',
  did: 'did:plc:m65dyjzrlcl32doxyfo55wmp',
  operation: 'create',
  record: { $type: 'app.bsky.feed.post', text: 'hello' },
  rev: '3mt6nokrfqz2j',
  rkey: '3mt6nokqjrs2d',
  seq: 24766274020,
  time: '2026-08-16T07:22:03.868352Z',
}

describe('normalizeEvent', () => {
  test('maps a live v2 commit onto a RecordEvent', () => {
    const event = normalizeEvent(LIVE_COMMIT)

    expect(event).toEqual({
      type: 'record',
      did: 'did:plc:m65dyjzrlcl32doxyfo55wmp',
      collection: 'app.bsky.feed.post',
      rkey: '3mt6nokqjrs2d',
      action: 'create',
      record: { $type: 'app.bsky.feed.post', text: 'hello' },
      cid: 'bafyreifyvx4dw32x3n4lykcf62ate7n5z7j6n3kekhbfqaxnmplfyxvety',
      rev: '3mt6nokrfqz2j',
      live: true,
    })
  })

  test('a delete carries neither record nor cid', () => {
    const { record, cid, ...rest } = LIVE_COMMIT
    const event = normalizeEvent({ ...rest, operation: 'delete' })

    expect(event?.action).toBe('delete')
    expect(event?.record).toBeNull()
    expect(event?.cid).toBeNull()
  })

  test('rejects a payload missing identity fields rather than writing a partial row', () => {
    expect(normalizeEvent({ ...LIVE_COMMIT, did: undefined })).toBeNull()
    expect(normalizeEvent({ ...LIVE_COMMIT, collection: undefined })).toBeNull()
    expect(normalizeEvent({ ...LIVE_COMMIT, rkey: undefined })).toBeNull()
  })

  test('rejects an unknown operation', () => {
    expect(normalizeEvent({ ...LIVE_COMMIT, operation: 'frobnicate' })).toBeNull()
  })
})

describe('ingest cursor', () => {
  test('is null before the driver has ever run', async () => {
    expect(await loadCursor(db, 'jetstream')).toBeNull()
  })

  test('round-trips and overwrites in place', async () => {
    await saveCursor(db, 'jetstream', 100)
    expect(await loadCursor(db, 'jetstream')).toBe(100)

    await saveCursor(db, 'jetstream', 250)
    expect(await loadCursor(db, 'jetstream')).toBe(250)
  })

  test('treats a stored 0 as a position, not as "never ran"', async () => {
    // A falsy check here would restart from live and silently skip the backlog.
    await saveCursor(db, 'jetstream', 0)
    expect(await loadCursor(db, 'jetstream')).toBe(0)
  })

  test('keeps sources independent', async () => {
    await saveCursor(db, 'jetstream', 7)
    expect(await loadCursor(db, 'other')).toBeNull()
  })
})

describe('BatchApplier with the Jetstream cursor hook', () => {
  function applier(onCommitted?: (seqs: number[]) => void) {
    return new BatchApplier<number>(
      db,
      testConfig,
      {
        inTransaction: async (tx, seqs) => saveCursor(tx, 'jetstream', Math.max(...seqs)),
        afterCommit: (seqs) => onCommitted?.(seqs),
      },
      {},
      { batchSize: 10, flushMs: 5 },
    )
  }

  test('commits the record and its cursor together', async () => {
    const committed: number[][] = []
    const batch = applier((seqs) => committed.push(seqs))

    const event = normalizeEvent(LIVE_COMMIT)!
    batch.push(event, LIVE_COMMIT.seq)
    batch.triggerFlush()
    await batch.stop()

    const rows = await db
      .select()
      .from(records)
      .where(and(eq(records.did, event.did), eq(records.rkey, event.rkey)))

    expect(rows).toHaveLength(1)
    expect(await loadCursor(db, 'jetstream')).toBe(LIVE_COMMIT.seq)
    expect(committed).toEqual([[LIVE_COMMIT.seq]])
  })

  test('stores the highest seq in the batch, not the last one applied', async () => {
    const batch = applier()

    // Out of order on purpose: resuming from a lower seq would replay work the
    // archive has already committed.
    for (const seq of [30, 10, 20]) {
      batch.push({ ...normalizeEvent(LIVE_COMMIT)!, rkey: `rkey-${seq}` }, seq)
    }
    batch.triggerFlush()
    await batch.stop()

    expect(await loadCursor(db, 'jetstream')).toBe(30)
  })

  test('does not advance the cursor when nothing has been pushed', async () => {
    const batch = applier()
    batch.triggerFlush()
    await batch.stop()

    expect(await loadCursor(db, 'jetstream')).toBeNull()
  })
})
