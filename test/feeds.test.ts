import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, audiences, webhookSubscriptions } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { WebhookWorker } from '../src/webhooks/worker'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }

const READER = 'did:plc:reader'
const AUTHOR = 'did:plc:author'
const FOLLOWED_PUB = `at://${AUTHOR}/site.standard.publication/followed`
const OTHER_PUB = `at://${AUTHOR}/site.standard.publication/other`

/**
 * Network: author owns two publications; reader subscribes to only one.
 * Author posts a doc under each. The following feed must contain only the
 * doc under the followed publication — same author, different pub, excluded.
 */
async function seedFollowing(): Promise<void> {
  for (const rkey of ['followed', 'other']) {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: AUTHOR, collection: 'site.standard.publication', rkey, record: { name: rkey } }),
    )
  }
  await applyEvent(
    db,
    testConfig,
    makeEvent({ did: READER, collection: 'site.standard.graph.subscription', rkey: 'sub1', record: { publication: FOLLOWED_PUB } }),
  )
  await applyEvent(
    db,
    testConfig,
    makeEvent({ did: AUTHOR, rkey: 'doc-in-followed', record: { title: 'In followed pub', site: FOLLOWED_PUB } }),
  )
  await applyEvent(
    db,
    testConfig,
    makeEvent({ did: AUTHOR, rkey: 'doc-in-other', record: { title: 'In other pub', site: OTHER_PUB } }),
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
  await db.execute(sql`TRUNCATE events, webhook_subscriptions, audiences RESTART IDENTITY CASCADE`)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
})

describe('outlink audiences', () => {
  test('resolves the DIDs a user links to', async () => {
    await seedFollowing()
    await db.insert(audiences).values({
      name: 'reader-follows',
      definition: { kind: 'outlink', did: READER, collection: 'site.standard.graph.subscription', path: 'publication' },
    })

    const res = await app.request('/api/v1/audiences/reader-follows/members', { headers: AUTH })
    expect(((await res.json()) as { members: string[] }).members).toEqual([AUTHOR])
  })
})

describe('link.<path> event filter', () => {
  test('events narrowed to records linking to an exact target', async () => {
    await seedFollowing()

    const res = await app.request(`/api/v1/events?link.site=${encodeURIComponent(FOLLOWED_PUB)}`, { headers: AUTH })
    const body = (await res.json()) as { events: { rkey: string }[] }

    expect(body.events).toHaveLength(1)
    expect(body.events[0]!.rkey).toBe('doc-in-followed')
  })
})

describe('feed=following:<did>', () => {
  test('returns docs from followed publications only — not the same author elsewhere', async () => {
    await seedFollowing()

    const res = await app.request(`/api/v1/events?feed=following:${READER}&collection=site.standard.document`, {
      headers: AUTH,
    })
    const body = (await res.json()) as { events: { rkey: string }[] }

    expect(body.events.map((e) => e.rkey)).toEqual(['doc-in-followed'])
  })

  test('unsubscribing empties the feed', async () => {
    await seedFollowing()
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: READER, collection: 'site.standard.graph.subscription', rkey: 'sub1', action: 'delete', record: null }),
    )

    const res = await app.request(`/api/v1/events?feed=following:${READER}&collection=site.standard.document`, {
      headers: AUTH,
    })
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(0)
  })

  test('400 on malformed feed', async () => {
    const bad = await app.request('/api/v1/events?feed=trending:whatever', { headers: AUTH })
    expect(bad.status).toBe(400)

    const noDid = await app.request('/api/v1/events?feed=following:not-a-did', { headers: AUTH })
    expect(noDid.status).toBe(400)
  })

  test('webhook subscription with feed delivers only followed-pub docs', async () => {
    await seedFollowing()

    const deliveries: { events: { rkey: string }[] }[] = []
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      deliveries.push(JSON.parse(String(init?.body)))
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    await db.insert(webhookSubscriptions).values({
      name: 'reader-feed',
      url: 'http://x.test',
      secret: 'shh',
      collections: ['site.standard.document'],
      feed: `following:${READER}`,
      cursor: 0,
      maxWaitMs: 0,
    })
    await new WebhookWorker(db, testConfig, fakeFetch).tick()

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.events.map((e) => e.rkey)).toEqual(['doc-in-followed'])
  })
})
