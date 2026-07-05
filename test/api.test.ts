import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, recordEmbeddings, records } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { eq } from 'drizzle-orm'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' }

const COLLECTION = 'site.standard.document'

function xrpc(method: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/xrpc/${COLLECTION}.${method}`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify(body ?? {}),
    }),
  )
}

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
    const res = await app.request(`/xrpc/${COLLECTION}.getRecords`)
    expect(res.status).toBe(401)
  })

  test('401 with wrong token', async () => {
    const res = await app.request(`/xrpc/${COLLECTION}.getRecords`, { headers: { Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  test('health endpoint needs no auth', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })
})

describe('/xrpc/{collection}.getRecords', () => {
  test('filters by did and collection', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:aaa', rkey: 'r1' }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:bbb', rkey: 'r2' }))
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:aaa', collection: 'site.standard.publication', rkey: 'r3', record: { name: 'Pub' } }),
    )

    const res = await xrpc('getRecords', { where: { did: { eq: 'did:plc:aaa' } } })
    const body = (await res.json()) as { records: { did: string; collection: string }[] }

    expect(res.status).toBe(200)
    expect(body.records).toHaveLength(1)
    expect(body.records[0]!.did).toBe('did:plc:aaa')
    expect(body.records[0]!.collection).toBe(COLLECTION)
  })

  test('excludes soft-deleted by default, includes with flag', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'gone' }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'gone', action: 'delete', record: null }))

    const hidden = await xrpc('getRecords', {})
    expect(((await hidden.json()) as { records: unknown[] }).records).toHaveLength(0)

    const shown = await xrpc('getRecords', { includeDeleted: true })
    expect(((await shown.json()) as { records: unknown[] }).records).toHaveLength(1)
  })

  test('cursor pagination walks the full set without overlap', async () => {
    for (let i = 0; i < 5; i++) {
      await applyEvent(db, testConfig, makeEvent({ rkey: `page-${i}` }))
    }

    const first = await xrpc('getRecords', { limit: 2 })
    const page1 = (await first.json()) as { records: { uri: string }[]; cursor?: string }
    expect(page1.records).toHaveLength(2)
    expect(page1.cursor).toBeDefined()

    const second = await xrpc('getRecords', { limit: 2, cursor: page1.cursor })
    const page2 = (await second.json()) as { records: { uri: string }[]; cursor?: string }

    const seen = [...page1.records, ...page2.records].map((r) => r.uri)
    expect(new Set(seen).size).toBe(4)
  })

  test('single record fetch by uri, 404 when missing', async () => {
    const event = makeEvent({ rkey: 'single' })
    await applyEvent(db, testConfig, event)
    const uri = `at://${event.did}/${event.collection}/single`

    const found = await app.request(`/xrpc/${COLLECTION}.getRecord?uri=${encodeURIComponent(uri)}`, { headers: AUTH })
    expect(found.status).toBe(200)

    const missing = await app.request(`/xrpc/${COLLECTION}.getRecord?uri=${encodeURIComponent(uri + 'x')}`, {
      headers: AUTH,
    })
    expect(missing.status).toBe(404)
  })
})

async function seedExtracted(rkey: string, title: string, body: string): Promise<void> {
  await db
    .update(records)
    .set({ extractedTitle: title, extractedText: body })
    .where(eq(records.rkey, rkey))
}

describe('/xrpc/{collection}.searchRecords', () => {
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
    await seedExtracted('k1', 'Weaving the atmosphere', 'All about atproto sync.')
    await seedExtracted('k2', 'Cooking pasta', 'Boil water, add salt.')

    const res = await xrpc('searchRecords', { q: 'atproto' })
    const body = (await res.json()) as { records: { uri: string; rank: number }[] }

    expect(body.records).toHaveLength(1)
    expect(body.records[0]!.uri).toContain('/k1')
  })

  test('400 without q', async () => {
    const res = await xrpc('searchRecords', {})
    expect(res.status).toBe(400)
  })
})

describe('/xrpc/{collection}.searchRecords semantic', () => {
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

    const res = await xrpc('searchRecords', { q: 'atmosphere things', semantic: true })
    const body = (await res.json()) as { records: { uri: string; distance: number }[] }

    expect(body.records[0]!.uri).toContain('/sem-close')
    expect(body.records[0]!.distance).toBeLessThan(body.records[1]!.distance)
  })
})

describe('record.<path> where filters', () => {
  test('filters records by nested $type', async () => {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'op-1', record: { title: 'Offprint doc', content: { $type: 'app.offprint.content' } } }),
    )
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'lf-1', record: { title: 'Leaflet doc', content: { $type: 'pub.leaflet.content' } } }),
    )

    const res = await xrpc('getRecords', { where: { 'content.$type': { eq: 'app.offprint.content' } } })
    const body = (await res.json()) as { records: { uri: string }[] }

    expect(body.records).toHaveLength(1)
    expect(body.records[0]!.uri).toContain('/op-1')
  })

  test('keyword search respects JSON filter', async () => {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'op-2', record: { title: 'Shared words here', content: { $type: 'app.offprint.content' } } }),
    )
    await applyEvent(
      db,
      testConfig,
      makeEvent({ rkey: 'lf-2', record: { title: 'Shared words here', content: { $type: 'pub.leaflet.content' } } }),
    )
    await seedExtracted('op-2', 'Shared words here', '')
    await seedExtracted('lf-2', 'Shared words here', '')

    const res = await xrpc('searchRecords', {
      q: 'shared words',
      where: { 'content.$type': { eq: 'app.offprint.content' } },
    })
    const body = (await res.json()) as { records: { uri: string }[] }

    expect(body.records).toHaveLength(1)
    expect(body.records[0]!.uri).toContain('/op-2')
  })
})

describe('dev mode', () => {
  test('devMode app serves without any token', async () => {
    const devApp = createApp({ db, config: testConfig, ollama: fakeOllama, devMode: true })
    const res = await devApp.request(`/xrpc/${COLLECTION}.getRecords`)
    expect(res.status).toBe(200)
  })

  test('default app still requires auth', async () => {
    const res = await app.request(`/xrpc/${COLLECTION}.getRecords`)
    expect(res.status).toBe(401)
  })
})
