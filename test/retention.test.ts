import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Db } from '../src/db/client'
import { pruneEvents } from '../src/db/retention'
import { setupTestDb, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.execute(sql`TRUNCATE events, webhook_subscriptions RESTART IDENTITY CASCADE`)
})

/** Events reference records, so each needs a row to hang off. */
async function seedEvent(ageDays: number): Promise<number> {
  // `uri` is generated from did/collection/rkey, so it must not be supplied.
  const [record] = (await db.execute(sql`
    INSERT INTO records (did, collection, rkey, record)
    VALUES ('did:plc:test', 'site.standard.document', ${`rkey-${Math.random()}`}, '{}'::jsonb)
    RETURNING id
  `)) as unknown as [{ id: number }]

  const [event] = (await db.execute(sql`
    INSERT INTO events (record_id, did, collection, rkey, action, created_at)
    VALUES (${record.id}, 'did:plc:test', 'site.standard.document', 'rkey', 'create',
            now() - make_interval(days => ${ageDays}))
    RETURNING id
  `)) as unknown as [{ id: number }]

  return Number(event.id)
}

async function subscribe(name: string, cursor: number, status = 'active') {
  await db.execute(sql`
    INSERT INTO webhook_subscriptions (name, url, secret, cursor, status)
    VALUES (${name}, 'https://example.test/hook', 'secret', ${cursor}, ${status})
  `)
}

async function remainingIds(): Promise<number[]> {
  const rows = (await db.execute(sql`SELECT id FROM events ORDER BY id`)) as unknown as { id: number }[]
  return rows.map((r) => Number(r.id))
}

describe('pruneEvents', () => {
  test('deletes only what is both delivered and older than the floor', async () => {
    const old = await seedEvent(30)
    const recent = await seedEvent(1)
    await subscribe('offprint', recent) // caught up on everything

    const result = await pruneEvents(db, { retentionDays: 7 })

    expect(result.deleted).toBe(1)
    expect(await remainingIds()).toEqual([recent])
    expect(result.heldBy).toEqual({ name: 'offprint', cursor: recent })
  })

  test('keeps events a subscription has not been delivered yet, however old', async () => {
    const delivered = await seedEvent(90)
    const undelivered = await seedEvent(90)
    await subscribe('offprint', delivered)

    const result = await pruneEvents(db, { retentionDays: 7 })

    // Age alone must never be enough: the consumer still needs this one.
    expect(result.deleted).toBe(1)
    expect(await remainingIds()).toEqual([undelivered])
  })

  test('the furthest-behind subscription holds the line', async () => {
    const first = await seedEvent(30)
    const second = await seedEvent(30)
    await subscribe('fast', second)
    await subscribe('slow', first)

    const result = await pruneEvents(db, { retentionDays: 7 })

    expect(result.heldBy).toEqual({ name: 'slow', cursor: first })
    expect(await remainingIds()).toEqual([second])
  })

  test('a paused or failing subscription still holds the line', async () => {
    const delivered = await seedEvent(30)
    const pending = await seedEvent(30)
    await subscribe('broken', delivered, 'failing')

    await pruneEvents(db, { retentionDays: 7 })

    // The webhook worker promises a subscription can be paused for a week and
    // resume; pruning past its cursor would quietly break that.
    expect(await remainingIds()).toEqual([pending])
  })

  test('the age floor protects pull consumers when no subscription exists', async () => {
    const old = await seedEvent(30)
    const recent = await seedEvent(1)

    const result = await pruneEvents(db, { retentionDays: 7 })

    expect(result.heldBy).toBeNull()
    expect(result.deleted).toBe(1)
    expect(await remainingIds()).toEqual([recent])
  })

  test('a dry run reports without deleting', async () => {
    await seedEvent(30)
    const recent = await seedEvent(1)
    await subscribe('offprint', recent)

    const result = await pruneEvents(db, { retentionDays: 7, dryRun: true })

    expect(result.eligible).toBe(1)
    expect(result.deleted).toBe(0)
    expect(await remainingIds()).toHaveLength(2)
  })

  test('deletes across multiple batches', async () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) ids.push(await seedEvent(30))
    await subscribe('offprint', ids.at(-1)!)

    const result = await pruneEvents(db, { retentionDays: 7, batchSize: 2 })

    expect(result.deleted).toBe(5)
    expect(await remainingIds()).toEqual([])
  })

  test('is a no-op when everything is inside the retention window', async () => {
    const recent = await seedEvent(1)
    await subscribe('offprint', recent)

    const result = await pruneEvents(db, { retentionDays: 7 })

    expect(result.deleted).toBe(0)
    expect(result.cutoffId).toBeNull()
  })

  test('refuses a non-positive retention, which would delete everything', async () => {
    await expect(pruneEvents(db, { retentionDays: 0 })).rejects.toThrow('positive')
    await expect(pruneEvents(db, { retentionDays: -1 })).rejects.toThrow('positive')
  })
})
