import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../src/db/client'
import { recordLinks, records } from '../src/db/schema'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, nextRev, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())
beforeEach(() => truncateAll(db))

async function getRecord(did: string, collection: string, rkey: string) {
  const rows = await db
    .select()
    .from(records)
    .where(and(eq(records.did, did), eq(records.collection, collection), eq(records.rkey, rkey)))
  return rows[0]
}

describe('applyEvent', () => {
  test('creates a record with generated uri and pending embed status', async () => {
    const event = makeEvent()
    const result = await applyEvent(db, testConfig, event)

    expect(result).toBe('applied')
    const row = await getRecord(event.did, event.collection, event.rkey)
    expect(row).toBeDefined()
    expect(row!.uri).toBe(`at://${event.did}/${event.collection}/${event.rkey}`)
    expect(row!.embedStatus).toBe('pending')
    expect(row!.deletedAt).toBeNull()
  })

  test('non-embeddable collection gets skipped embed status', async () => {
    const event = makeEvent({
      collection: 'site.standard.graph.subscription',
      record: { publication: 'at://did:plc:pub/site.standard.publication/p1' },
    })
    await applyEvent(db, testConfig, event)

    const row = await getRecord(event.did, event.collection, event.rkey)
    expect(row!.embedStatus).toBe('skipped')
  })

  test('redelivered event (same rev) is a no-op', async () => {
    const event = makeEvent()
    await applyEvent(db, testConfig, event)
    const result = await applyEvent(db, testConfig, event)

    expect(result).toBe('skipped')
  })

  test('older rev is ignored', async () => {
    const oldRev = nextRev()
    const newRev = nextRev()
    const event = makeEvent({ rev: newRev, record: { title: 'newer' } })
    await applyEvent(db, testConfig, event)

    const stale = makeEvent({ rev: oldRev, action: 'update', record: { title: 'older' }, cid: 'stale-cid' })
    const result = await applyEvent(db, testConfig, stale)

    expect(result).toBe('skipped')
    const row = await getRecord(event.did, event.collection, event.rkey)
    expect((row!.record as { title: string }).title).toBe('newer')
  })

  test('update with newer rev replaces record and resets embed status', async () => {
    const event = makeEvent()
    await applyEvent(db, testConfig, event)
    await db.update(records).set({ embedStatus: 'done' }).where(eq(records.did, event.did))

    const update = makeEvent({ action: 'update', record: { title: 'Updated' } })
    const result = await applyEvent(db, testConfig, update)

    expect(result).toBe('applied')
    const row = await getRecord(event.did, event.collection, event.rkey)
    expect((row!.record as { title: string }).title).toBe('Updated')
    expect(row!.embedStatus).toBe('pending')
  })

  test('unchanged cid does not reset embed status', async () => {
    const event = makeEvent({ cid: 'same-cid' })
    await applyEvent(db, testConfig, event)
    await db.update(records).set({ embedStatus: 'done' }).where(eq(records.did, event.did))

    const update = makeEvent({ action: 'update', cid: 'same-cid', record: event.record })
    await applyEvent(db, testConfig, update)

    const row = await getRecord(event.did, event.collection, event.rkey)
    expect(row!.embedStatus).toBe('done')
  })

  test('delete soft-deletes and keeps last-known record json', async () => {
    const event = makeEvent()
    await applyEvent(db, testConfig, event)

    const del = makeEvent({ action: 'delete', record: null })
    const result = await applyEvent(db, testConfig, del)

    expect(result).toBe('applied')
    const row = await getRecord(event.did, event.collection, event.rkey)
    expect(row!.deletedAt).not.toBeNull()
    expect((row!.record as { title: string }).title).toBe('Hello Atmosphere')
  })

  test('delete for never-seen record stores a tombstone', async () => {
    const del = makeEvent({ rkey: 'ghost', action: 'delete', record: null })
    const result = await applyEvent(db, testConfig, del)

    expect(result).toBe('applied')
    const row = await getRecord(del.did, del.collection, 'ghost')
    expect(row!.deletedAt).not.toBeNull()
  })

  test('re-create after delete undeletes', async () => {
    await applyEvent(db, testConfig, makeEvent())
    await applyEvent(db, testConfig, makeEvent({ action: 'delete', record: null }))

    const recreate = makeEvent({ record: { title: 'Back again' } })
    await applyEvent(db, testConfig, recreate)

    const row = await getRecord(recreate.did, recreate.collection, recreate.rkey)
    expect(row!.deletedAt).toBeNull()
    expect((row!.record as { title: string }).title).toBe('Back again')
  })

  test('extracts links and replaces them on update', async () => {
    const event = makeEvent({
      collection: 'site.standard.graph.subscription',
      record: { publication: 'at://did:plc:pub/site.standard.publication/p1' },
    })
    await applyEvent(db, testConfig, event)

    const row = await getRecord(event.did, event.collection, event.rkey)
    let links = await db.select().from(recordLinks).where(eq(recordLinks.recordId, row!.id))
    expect(links).toHaveLength(1)
    expect(links[0]!.targetUri).toBe('at://did:plc:pub/site.standard.publication/p1')

    const update = makeEvent({
      collection: event.collection,
      action: 'update',
      record: { publication: 'at://did:plc:pub/site.standard.publication/p2' },
    })
    await applyEvent(db, testConfig, update)

    links = await db.select().from(recordLinks).where(eq(recordLinks.recordId, row!.id))
    expect(links).toHaveLength(1)
    expect(links[0]!.targetRkey).toBe('p2')
  })

  test('identity events are skipped', async () => {
    const result = await applyEvent(db, testConfig, makeEvent({ type: 'identity' }))
    expect(result).toBe('skipped')
  })

  test('unknown collections are archived without embedding', async () => {
    const event = makeEvent({ collection: 'com.example.unknown', record: { note: 'did:plc:someone' } })
    const result = await applyEvent(db, testConfig, event)

    expect(result).toBe('applied')
    const row = await getRecord(event.did, 'com.example.unknown', event.rkey)
    expect(row!.embedStatus).toBe('skipped')
  })
})
