import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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
const AUTH = { Authorization: `Bearer ${TOKEN}` }

interface EventJson {
  cursor: string
  uri: string
  action: string
  collection: string
  record?: Record<string, unknown> | null
}

async function fetchEvents(qs = ''): Promise<{ events: EventJson[]; cursor: string | null }> {
  const res = await app.request(`/api/v1/events${qs}`, { headers: AUTH })
  expect(res.status).toBe(200)
  return (await res.json()) as { events: EventJson[]; cursor: string | null }
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
  await db.execute(await import('drizzle-orm').then(({ sql }) => sql`TRUNCATE events RESTART IDENTITY CASCADE`))
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
})

describe('event log writes', () => {
  test('applied create/update/delete each append one event', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'e1' }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'e1', action: 'update', record: { title: 'v2' } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'e1', action: 'delete', record: null }))

    const rows = await db.select().from(events)
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'delete'])
  })

  test('skipped redeliveries append nothing', async () => {
    const event = makeEvent({ rkey: 'e2' })
    await applyEvent(db, testConfig, event)
    await applyEvent(db, testConfig, event)

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
  })

  test('tombstone delete for unseen record still logs', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'ghost', action: 'delete', record: null }))

    const rows = await db.select().from(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('delete')
  })
})

describe('GET /api/v1/events', () => {
  test('cursor pagination is ordered, exclusive, and resumable', async () => {
    for (let i = 0; i < 5; i++) await applyEvent(db, testConfig, makeEvent({ rkey: `p${i}` }))

    const page1 = await fetchEvents('?limit=3')
    expect(page1.events).toHaveLength(3)

    const page2 = await fetchEvents(`?limit=3&cursor=${page1.cursor}`)
    expect(page2.events).toHaveLength(2)

    const all = [...page1.events, ...page2.events].map((e) => e.cursor)
    expect(new Set(all).size).toBe(5)
    expect([...all].sort((a, b) => Number(a) - Number(b))).toEqual(all)

    const empty = await fetchEvents(`?cursor=${page2.cursor}`)
    expect(empty.events).toHaveLength(0)
    expect(empty.cursor).toBeNull()
  })

  test('filters by collection, did, and action', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'f1' }))
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:other', collection: 'site.standard.publication', rkey: 'f2', record: { name: 'P' } }),
    )
    await applyEvent(db, testConfig, makeEvent({ rkey: 'f1', action: 'delete', record: null }))

    expect((await fetchEvents('?collection=site.standard.publication')).events).toHaveLength(1)
    expect((await fetchEvents('?did=did:plc:other')).events).toHaveLength(1)
    expect((await fetchEvents('?action=delete')).events).toHaveLength(1)
  })

  test('record json filter narrows events', async () => {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'j1', record: { title: 'A', content: { $type: 'app.offprint.content' } } }),
    )
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'j2', record: { title: 'B', content: { $type: 'pub.leaflet.content' } } }),
    )

    const filtered = await fetchEvents('?record.content.$type=app.offprint.content')
    expect(filtered.events).toHaveLength(1)
    expect(filtered.events[0]!.uri).toContain('/j1')
  })

  test('include_record attaches record json, null for deletes', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'r1', record: { title: 'With body' } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'r1', action: 'delete', record: null }))

    const { events: list } = await fetchEvents('?include_record=1')
    expect((list[0]!.record as { title: string }).title).toBe('With body')
    expect(list[1]!.record).toBeNull()

    const bare = await fetchEvents()
    expect(bare.events[0]!.record).toBeUndefined()
  })

  test('rejects garbage cursor', async () => {
    const res = await app.request('/api/v1/events?cursor=nope', { headers: AUTH })
    expect(res.status).toBe(400)
  })
})
