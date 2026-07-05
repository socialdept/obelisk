import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { RateLimiter, UNLIMITED, type Limits } from '../src/api/ratelimit'
import type { Db } from '../src/db/client'
import type { OllamaClient } from '../src/embed/ollama'
import { setupTestDb, testConfig } from './helpers'

let db: Db
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ db, teardown } = await setupTestDb())
})
afterAll(() => teardown())

function appWith(limits: Partial<Limits>): Hono {
  return createApp({
    db,
    config: testConfig,
    ollama: {} as OllamaClient,
    devMode: true, // key rate limits by IP, no token setup needed
    limits: { ...UNLIMITED, ...limits },
  })
}

// An invalid collection NSID returns 400 before touching the DB, so it exercises
// the middleware chain (body cap → rate limit) without needing seeded data.
const INVALID = '/xrpc/foo.getRecords'

describe('RateLimiter', () => {
  test('hit allows up to the limit, then blocks with a retry-after', () => {
    const rl = new RateLimiter()
    expect(rl.hit('k', 2).ok).toBe(true)
    expect(rl.hit('k', 2).ok).toBe(true)
    const blocked = rl.hit('k', 2)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
  })

  test('separate keys have independent windows', () => {
    const rl = new RateLimiter()
    expect(rl.hit('a', 1).ok).toBe(true)
    expect(rl.hit('a', 1).ok).toBe(false)
    expect(rl.hit('b', 1).ok).toBe(true)
  })

  test('sse slots acquire up to max and release', () => {
    const rl = new RateLimiter()
    expect(rl.acquireSse('k', 2)).toBe(true)
    expect(rl.acquireSse('k', 2)).toBe(true)
    expect(rl.acquireSse('k', 2)).toBe(false)
    rl.releaseSse('k')
    expect(rl.acquireSse('k', 2)).toBe(true)
  })
})

describe('rate limit middleware', () => {
  test('429 with Retry-After once the per-minute limit is exceeded', async () => {
    const app = appWith({ rateLimitPerMin: 3 })
    for (let i = 0; i < 3; i++) {
      const res = await app.request(INVALID, { method: 'POST', body: '{}' })
      expect(res.status).toBe(400) // invalid NSID, but allowed through the limiter
    }
    const limited = await app.request(INVALID, { method: 'POST', body: '{}' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBeTruthy()
    const json = (await limited.json()) as { error: string }
    expect(json.error).toBe('RateLimitExceeded')
  })

  test('default (0) leaves the API unlimited', async () => {
    const app = appWith({}) // all UNLIMITED
    for (let i = 0; i < 25; i++) {
      const res = await app.request(INVALID, { method: 'POST', body: '{}' })
      expect(res.status).toBe(400)
    }
  })

  test('expensive methods use a separate, tighter bucket', async () => {
    const app = appWith({ rateLimitPerMin: 100, rateLimitExpensivePerMin: 1 })
    const search = '/xrpc/site.standard.document.searchRecords'
    const first = await app.request(search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":"x"}' })
    expect(first.status).not.toBe(429)
    const second = await app.request(search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":"x"}' })
    expect(second.status).toBe(429)
  })
})

describe('body size cap', () => {
  test('413 when Content-Length exceeds the cap', async () => {
    const app = appWith({ maxBodyBytes: 10 })
    const body = JSON.stringify({ padding: 'x'.repeat(100) })
    const res = await app.request(INVALID, {
      method: 'POST',
      headers: { 'content-length': String(body.length) },
      body,
    })
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('PayloadTooLarge')
  })

  test('under the cap passes through', async () => {
    const app = appWith({ maxBodyBytes: 10_000 })
    const res = await app.request(INVALID, { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
  })
})
