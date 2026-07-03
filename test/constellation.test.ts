import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { ConstellationClient } from '../src/constellation/client'
import type { Db } from '../src/db/client'
import { setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

const realFetch = globalThis.fetch
let fetchCalls: { url: string; userAgent: string | undefined }[] = []
let upstreamResponse: () => Response

function mockFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    fetchCalls.push({ url, userAgent: headers.get('User-Agent') ?? undefined })
    return upstreamResponse()
  }) as typeof fetch
}

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  fetchCalls = []
  upstreamResponse = () => Response.json({ total: 7, linking_records: [] })
  mockFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function client(ttlSeconds = 3600): ConstellationClient {
  return new ConstellationClient(db, { ...testConfig.constellation, ttlSeconds })
}

const PARAMS = {
  target: 'at://did:plc:pub/site.standard.publication/p1',
  collection: 'site.standard.graph.subscription',
  path: '.publication',
}

describe('ConstellationClient', () => {
  test('first call hits upstream with User-Agent, second within TTL serves cache', async () => {
    const c = client()

    const first = await c.query('links', PARAMS)
    expect(first.cached).toBe(false)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.userAgent).toBe('reservoir-test')
    expect(fetchCalls[0]!.url).toContain('collection=site.standard.graph.subscription')

    const second = await c.query('links', PARAMS)
    expect(second.cached).toBe(true)
    expect(second.stale).toBe(false)
    expect(fetchCalls).toHaveLength(1)
    expect(second.data).toEqual({ total: 7, linking_records: [] })
  })

  test('expired TTL refetches', async () => {
    const c = client()
    await c.query('links', PARAMS)
    await db.execute(sql`UPDATE constellation_cache SET fetched_at = now() - interval '2 hours'`)

    const result = await c.query('links', PARAMS)
    expect(result.cached).toBe(false)
    expect(fetchCalls).toHaveLength(2)
  })

  test('serves stale cache when upstream errors', async () => {
    const c = client()
    await c.query('links', PARAMS)
    await db.execute(sql`UPDATE constellation_cache SET fetched_at = now() - interval '2 hours'`)
    upstreamResponse = () => new Response('boom', { status: 503 })

    const result = await c.query('links', PARAMS)
    expect(result.cached).toBe(true)
    expect(result.stale).toBe(true)
    expect(result.data).toEqual({ total: 7, linking_records: [] })
  })

  test('throws when upstream errors and no cache exists', async () => {
    upstreamResponse = () => new Response('boom', { status: 503 })
    expect(client().query('links', PARAMS)).rejects.toThrow('503')
  })

  test('plain-text count responses are wrapped', async () => {
    upstreamResponse = () => new Response('42')
    const result = await client().query('links/count', PARAMS)
    expect(result.data).toEqual({ count: 42 })
  })

  test('different params produce distinct cache entries', async () => {
    const c = client()
    await c.query('links', PARAMS)
    await c.query('links', { ...PARAMS, path: '.other' })
    expect(fetchCalls).toHaveLength(2)
  })
})
