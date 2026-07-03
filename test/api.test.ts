import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, recordEmbeddings, records } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }

/** Deterministic fake: vector points one-hot by input length parity — enough to order results. */
const fakeOllama = {
  embed: async (inputs: string[]) =>
    inputs.map((input) => {
      const vec = new Array(768).fill(0)
      vec[0] = input.includes('atmosphere') ? 1 : 0
      vec[1] = input.includes('atmosphere') ? 0 : 1
      return vec
    }),
} as unknown as OllamaClient

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
  app = createApp({ db, config: testConfig, ollama: fakeOllama })
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
})

describe('auth', () => {
  test('401 without token', async () => {
    const res = await app.request('/api/v1/records')
    expect(res.status).toBe(401)
  })

  test('401 with wrong token', async () => {
    const res = await app.request('/api/v1/records', { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  test('health endpoint needs no auth', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })
})

describe('GET /api/v1/records', () => {
  test('filters by did and collection', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:aaa', rkey: 'r1' }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:bbb', rkey: 'r2' }))
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:aaa', collection: 'site.standard.publication', rkey: 'r3', record: { name: 'Pub' } }),
    )

    const res = await app.request('/api/v1/records?did=did:plc:aaa&collection=site.standard.document', { headers: AUTH })
    const body = (await res.json()) as { records: { did: string }[] }

    expect(res.status).toBe(200)
    expect(body.records).toHaveLength(1)
    expect(body.records[0]!.did).toBe('did:plc:aaa')
  })

  test('excludes soft-deleted by default, includes with flag', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'gone' }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'gone', action: 'delete', record: null }))

    const hidden = await app.request('/api/v1/records', { headers: AUTH })
    expect(((await hidden.json()) as { records: unknown[] }).records).toHaveLength(0)

    const shown = await app.request('/api/v1/records?include_deleted=1', { headers: AUTH })
    expect(((await shown.json()) as { records: unknown[] }).records).toHaveLength(1)
  })

  test('cursor pagination walks the full set without overlap', async () => {
    for (let i = 0; i < 5; i++) {
      await applyEvent(db, testConfig, makeEvent({ rkey: `page-${i}` }))
    }

    const first = await app.request('/api/v1/records?limit=2', { headers: AUTH })
    const page1 = (await first.json()) as { records: { rkey: string }[]; cursor: string }
    expect(page1.records).toHaveLength(2)
    expect(page1.cursor).not.toBeNull()

    const second = await app.request(`/api/v1/records?limit=2&cursor=${page1.cursor}`, { headers: AUTH })
    const page2 = (await second.json()) as { records: { rkey: string }[]; cursor: string }

    const seen = [...page1.records, ...page2.records].map((r) => r.rkey)
    expect(new Set(seen).size).toBe(4)
  })

  test('single record fetch by path, 404 when missing', async () => {
    const event = makeEvent({ rkey: 'single' })
    await applyEvent(db, testConfig, event)

    const found = await app.request(`/api/v1/records/${event.did}/${event.collection}/single`, { headers: AUTH })
    expect(found.status).toBe(200)

    const missing = await app.request(`/api/v1/records/${event.did}/${event.collection}/nope`, { headers: AUTH })
    expect(missing.status).toBe(404)
  })
})

describe('GET /api/v1/search', () => {
  test('finds documents by keyword, respects collection filter', async () => {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'k1', record: { title: 'Weaving the atmosphere', textContent: 'All about atproto sync.' } }),
    )
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'k2', record: { title: 'Cooking pasta', textContent: 'Boil water, add salt.' } }),
    )

    const res = await app.request('/api/v1/search?q=atproto', { headers: AUTH })
    const body = (await res.json()) as { results: { rkey: string }[] }

    expect(body.results).toHaveLength(1)
    expect(body.results[0]!.rkey).toBe('k1')
  })

  test('400 without q', async () => {
    const res = await app.request('/api/v1/search', { headers: AUTH })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/search/semantic', () => {
  test('orders by vector distance using the fake embedder', async () => {
    const close = makeEvent({ rkey: 'sem-close', record: { title: 'atmosphere post', textContent: 'atmosphere' } })
    const far = makeEvent({ rkey: 'sem-far', record: { title: 'other post', textContent: 'unrelated' } })
    await applyEvent(db, testConfig, close)
    await applyEvent(db, testConfig, far)

    const rows = await db.select({ id: records.id, rkey: records.rkey }).from(records)
    for (const row of rows) {
      const [vec] = await fakeOllama.embed([row.rkey === 'sem-close' ? 'atmosphere' : 'other'])
      await db.insert(recordEmbeddings).values({ recordId: row.id, chunkIndex: 0, chunkText: 'chunk', embedding: vec! })
    }

    const res = await app.request('/api/v1/search/semantic?q=atmosphere+things', { headers: AUTH })
    const body = (await res.json()) as { results: { rkey: string; distance: number }[] }

    expect(body.results[0]!.rkey).toBe('sem-close')
    expect(body.results[0]!.distance).toBeLessThan(body.results[1]!.distance)
  })
})
