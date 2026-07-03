import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { ConstellationClient } from '../src/constellation/client'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import type { LexiconRegistry } from '../src/lexicon/registry'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }

const NS = 'social.dept.obelisk'
const PUB_URI = 'at://did:plc:pub/site.standard.publication/self'

// Offline fakes so the service plane never touches the network in tests.
const fakeConstellation = {
  query: async () => ({ data: { total: 7 }, cached: false, stale: false, fetchedAt: '2026-07-03T00:00:00Z' }),
} as unknown as ConstellationClient
const fakeLexicons = {
  get: async () => ({ schema: null, error: null, resolvedAt: new Date() }),
} as unknown as LexiconRegistry

function xrpc(method: string, query: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams(query).toString()
  return Promise.resolve(app.request(`/xrpc/${NS}.${method}${qs ? `?${qs}` : ''}`, { headers: AUTH }))
}

async function seed(): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', record: { $type: 'site.standard.document', title: 'One' } }))
  await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:bob', rkey: 'd2', record: { $type: 'site.standard.document', title: 'Two' } }))
  await applyEvent(
    db,
    testConfig,
    makeEvent({
      did: 'did:plc:alice',
      collection: 'site.standard.graph.subscription',
      rkey: 'sub-1',
      record: { $type: 'site.standard.graph.subscription', publication: PUB_URI },
    }),
  )
}

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
  app = createApp({
    db,
    config: testConfig,
    ollama: {} as OllamaClient,
    constellation: fakeConstellation,
    lexicons: fakeLexicons,
  })
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
})

describe('service plane dispatch', () => {
  test('requires auth', async () => {
    const res = await app.request(`/xrpc/${NS}.getTypes`)
    expect(res.status).toBe(401)
  })

  test('unknown service method → MethodNotImplemented', async () => {
    const res = await xrpc('explode')
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toBe('MethodNotImplemented')
  })
})

describe(`${NS}.getEvents`, () => {
  test('returns the change log with a cursor', async () => {
    await seed()
    const res = await xrpc('getEvents')
    const body = (await res.json()) as { events: { collection: string; action: string }[]; cursor: string | null }
    expect(res.status).toBe(200)
    expect(body.events.length).toBe(3)
    expect(body.cursor).not.toBeNull()
  })

  test('filters by collection', async () => {
    await seed()
    const res = await xrpc('getEvents', { collection: 'site.standard.graph.subscription' })
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events).toHaveLength(1)
  })

  test('bad cursor → InvalidRequest', async () => {
    const res = await xrpc('getEvents', { cursor: 'nope' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('InvalidRequest')
  })
})

describe(`${NS}.getTypes / getType`, () => {
  test('getTypes reports observed $type values', async () => {
    await seed()
    const res = await xrpc('getTypes')
    const body = (await res.json()) as { types: Record<string, Record<string, number>> }
    expect(body.types['$type']?.['site.standard.document']).toBe(2)
  })

  test('getType requires nsid, returns usage', async () => {
    await seed()
    const missing = await xrpc('getType')
    expect(missing.status).toBe(400)

    const res = await xrpc('getType', { nsid: 'site.standard.document' })
    const body = (await res.json()) as { nsid: string; usage: unknown[]; lexicon: unknown }
    expect(body.nsid).toBe('site.standard.document')
    expect(Array.isArray(body.usage)).toBe(true)
  })
})

describe(`${NS}.getLinks / getBacklinks`, () => {
  test('getLinks returns outgoing references; 404 for unknown record', async () => {
    await seed()
    const res = await xrpc('getLinks', { uri: 'at://did:plc:alice/site.standard.graph.subscription/sub-1' })
    const body = (await res.json()) as { links: { path: string; targetUri: string }[] }
    expect(body.links.some((l) => l.targetUri === PUB_URI)).toBe(true)

    const missing = await xrpc('getLinks', { uri: 'at://did:plc:alice/site.standard.document/nope' })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toBe('RecordNotFound')
  })

  test('getBacklinks finds records pointing at a target', async () => {
    await seed()
    const res = await xrpc('getBacklinks', { uri: PUB_URI })
    const body = (await res.json()) as { backlinks: { path: string; source: { rkey: string } }[] }
    expect(body.backlinks).toHaveLength(1)
    expect(body.backlinks[0]!.source.rkey).toBe('sub-1')
  })

  test('getLinks/getBacklinks require uri', async () => {
    expect((await xrpc('getLinks')).status).toBe(400)
    expect((await xrpc('getBacklinks')).status).toBe(400)
  })
})

describe(`${NS}.getNetworkBacklinks`, () => {
  test('proxies Constellation with cache meta', async () => {
    const res = await xrpc('getNetworkBacklinks', { uri: PUB_URI })
    const body = (await res.json()) as { data: { total: number }; meta: { cached: boolean } }
    expect(res.status).toBe(200)
    expect(body.data.total).toBe(7)
    expect(body.meta.cached).toBe(false)
  })
})
