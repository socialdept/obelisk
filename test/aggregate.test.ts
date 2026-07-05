import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'social.dept.obelisk'

interface Group {
  key: Record<string, unknown>
  count: number
}

async function agg(body: unknown): Promise<{ status: number; groups: Group[]; error?: string }> {
  const res = await app.request(`/xrpc/${NS}.aggregate`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) })
  const json = (await res.json()) as { groups?: Group[]; error?: string }
  return { status: res.status, groups: json.groups ?? [], error: json.error }
}

/** Find the count for a group whose key matches the given subset. */
function countFor(groups: Group[], key: Record<string, unknown>): number | undefined {
  const match = groups.find((g) => Object.entries(key).every(([k, v]) => g.key[k] === v))
  return match?.count
}

/** Two documents (alice, bob) + one subscription (alice → a publication). */
async function seedMixed(): Promise<void> {
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

describe(`${NS}.aggregate`, () => {
  test('groups records by collection', async () => {
    await seedMixed()
    const { status, groups } = await agg({ groupBy: 'collection' })
    expect(status).toBe(200)
    expect(countFor(groups, { collection: 'site.standard.document' })).toBe(2)
    expect(countFor(groups, { collection: 'site.standard.graph.subscription' })).toBe(1)
  })

  test('groups records by did', async () => {
    await seedMixed()
    const { groups } = await agg({ groupBy: 'did' })
    expect(countFor(groups, { did: 'did:plc:alice' })).toBe(2)
    expect(countFor(groups, { did: 'did:plc:bob' })).toBe(1)
  })

  test('no groupBy → single total', async () => {
    await seedMixed()
    const { groups } = await agg({})
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toEqual({})
    expect(groups[0]!.count).toBe(3)
  })

  test('where narrows the aggregate', async () => {
    await seedMixed()
    const { groups } = await agg({ groupBy: 'collection', where: { title: { eq: 'One' } } })
    expect(groups).toHaveLength(1)
    expect(countFor(groups, { collection: 'site.standard.document' })).toBe(1)
  })

  test('groups by a record JSON path', async () => {
    await seedMixed()
    const { groups } = await agg({ source: 'links', groupBy: 'record.publication' })
    expect(countFor(groups, { 'record.publication': 'at://did:plc:pub/site.standard.publication/self' })).toBe(1)
  })

  test('events source: count_distinct by did', async () => {
    await seedMixed()
    const { groups } = await agg({ source: 'events', aggregate: 'count_distinct:did' })
    expect(groups[0]!.count).toBe(2) // alice + bob
  })

  test('events source: time bucket groups into one day', async () => {
    await seedMixed()
    const { groups } = await agg({ source: 'events', groupBy: 'createdAt:day' })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(3)
  })

  test('links source: group by target collection', async () => {
    await seedMixed()
    const { groups } = await agg({ source: 'links', groupBy: 'targetCollection' })
    expect(countFor(groups, { targetCollection: 'site.standard.publication' })).toBe(1)
  })

  test('excludes soft-deleted records by default; includeDeleted counts them', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', record: { title: 'Live' } }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd2', record: { title: 'Gone' } }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd2', action: 'delete', record: null }))

    expect((await agg({ groupBy: 'collection' })).groups[0]!.count).toBe(1)
    expect((await agg({ groupBy: 'collection', includeDeleted: true })).groups[0]!.count).toBe(2)
  })

  test('GET form with comma-separated groupBy', async () => {
    await seedMixed()
    const res = await app.request(`/xrpc/${NS}.aggregate?source=records&groupBy=collection,did`, { headers: AUTH })
    expect(res.status).toBe(200)
    const { groups } = (await res.json()) as { groups: Group[] }
    expect(countFor(groups, { collection: 'site.standard.document', did: 'did:plc:alice' })).toBe(1)
    expect(countFor(groups, { collection: 'site.standard.document', did: 'did:plc:bob' })).toBe(1)
  })

  test('unknown source → InvalidRequest', async () => {
    const { status, error } = await agg({ source: 'nope', groupBy: 'collection' })
    expect(status).toBe(400)
    expect(error).toBe('InvalidRequest')
  })

  test('ungroupable field → InvalidRequest', async () => {
    const { status, error } = await agg({ source: 'events', groupBy: 'targetCollection' })
    expect(status).toBe(400)
    expect(error).toBe('InvalidRequest')
  })

  test('unknown aggregate → InvalidRequest', async () => {
    const { status } = await agg({ aggregate: 'median:foo' })
    expect(status).toBe(400)
  })

  test('bad time bucket → InvalidRequest', async () => {
    const { status } = await agg({ source: 'events', groupBy: 'createdAt:decade' })
    expect(status).toBe(400)
  })

  test('requires auth', async () => {
    const res = await app.request(`/xrpc/${NS}.aggregate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})
