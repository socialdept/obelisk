import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, events } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'social.dept.obelisk'

function backfill(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/xrpc/${NS}.backfillEvents`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
  )
}

/** Archive records via the normal path, then wipe the event log to simulate
 *  records that predate it (the exact condition backfillEvents exists to fix). */
async function seedRecordsWithoutEvents(): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', record: { title: 'One' } }))
  await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:bob', rkey: 'd2', record: { title: 'Two' } }))
  await applyEvent(
    db,
    testConfig,
    makeEvent({
      did: 'did:plc:alice',
      collection: 'site.standard.graph.subscription',
      rkey: 's1',
      record: { publication: 'at://did:plc:pub/site.standard.publication/self' },
    }),
  )
  await db.delete(events)
}

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
  app = createApp({ db, config: testConfig, ollama: {} as OllamaClient })
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
})

describe(`${NS}.backfillEvents`, () => {
  test('seeds create events for records that have none, live:false', async () => {
    await seedRecordsWithoutEvents()

    const res = await backfill({})
    expect(res.status).toBe(200)
    expect(((await res.json()) as { seeded: number }).seeded).toBe(3)

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(3)
    expect(rows.every((e) => e.action === 'create')).toBe(true)
    expect(rows.every((e) => e.live === false)).toBe(true)
    // Seeded in records.id order so replay ≈ archive order.
    expect(rows.map((e) => e.id)).toEqual([...rows.map((e) => e.id)].sort((a, b) => a - b))
  })

  test('is idempotent — re-run seeds nothing', async () => {
    await seedRecordsWithoutEvents()
    expect(((await (await backfill({})).json()) as { seeded: number }).seeded).toBe(3)
    expect(((await (await backfill({})).json()) as { seeded: number }).seeded).toBe(0)
  })

  test('does not touch records that already have events', async () => {
    // Two archived normally (they DO have events), one orphaned.
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', record: { title: 'Kept' } }))
    await db.execute(sql`DELETE FROM events WHERE rkey = 'd1'`) // orphan just d1
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:bob', rkey: 'd2', record: { title: 'HasEvent' } }))

    const seeded = ((await (await backfill({})).json()) as { seeded: number }).seeded
    expect(seeded).toBe(1) // only the orphaned d1 — d2 already had an event
    const rows = await db.select().from(events)
    expect(rows).toHaveLength(2) // d2's original + d1's seeded, no duplicate for d2
    expect(rows.filter((e) => e.rkey === 'd1')).toHaveLength(1)
  })

  test('filters by collection', async () => {
    await seedRecordsWithoutEvents()
    const seeded = ((await (await backfill({ collection: 'site.standard.document' })).json()) as { seeded: number })
      .seeded
    expect(seeded).toBe(2) // d1, d2 — not the subscription
  })

  test('filters by did', async () => {
    await seedRecordsWithoutEvents()
    const seeded = ((await (await backfill({ did: 'did:plc:alice' })).json()) as { seeded: number }).seeded
    expect(seeded).toBe(2) // d1 + s1
  })

  test('where DSL narrows to record fields', async () => {
    await seedRecordsWithoutEvents()
    const seeded = ((await (await backfill({ where: { title: { eq: 'One' } } })).json()) as { seeded: number }).seeded
    expect(seeded).toBe(1)
  })

  test('bad where operator → InvalidRequest', async () => {
    const res = await backfill({ where: { title: { like: 'x' } } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('InvalidRequest')
  })

  test('includeDeleted seeds delete events for tombstoned records', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', record: { title: 'Gone' } }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', action: 'delete', record: null }))
    await db.delete(events)

    // Without includeDeleted the tombstone is skipped.
    expect(((await (await backfill({})).json()) as { seeded: number }).seeded).toBe(0)

    const seeded = ((await (await backfill({ includeDeleted: true })).json()) as { seeded: number }).seeded
    expect(seeded).toBe(1)
    const rows = await db.select().from(events)
    expect(rows[0]!.action).toBe('delete')
  })

  test('requires auth', async () => {
    const res = await app.request(`/xrpc/${NS}.backfillEvents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})
