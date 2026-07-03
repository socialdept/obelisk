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
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' }

const PUB_URI = 'at://did:plc:publisher/site.standard.publication/self'

/** Seed: two subscribers of PUB_URI (one later unsubscribes), one unrelated author. */
async function seedNetwork(): Promise<void> {
  await applyEvent(
    db,
    testConfig,
    makeEvent({ did: 'did:plc:publisher', collection: 'site.standard.publication', rkey: 'self', record: { name: 'Pub' } }),
  )
  for (const did of ['did:plc:fan1', 'did:plc:fan2']) {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did, collection: 'site.standard.graph.subscription', rkey: 'sub', record: { publication: PUB_URI } }),
    )
  }
  await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:rando', rkey: 'doc', record: { title: 'Unrelated' } }))
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

describe('audience membership', () => {
  test('backlink audience resolves subscribers; network unsubscribe removes them', async () => {
    await seedNetwork()
    await db.insert(audiences).values({
      name: 'pub-subscribers',
      definition: { kind: 'backlink', target: PUB_URI, collection: 'site.standard.graph.subscription', path: 'publication' },
    })

    const before = await app.request('/api/v1/audiences/pub-subscribers/members', { headers: AUTH })
    expect(((await before.json()) as { members: string[] }).members).toEqual(['did:plc:fan1', 'did:plc:fan2'])

    // fan2 deletes their subscription record on the network → drops out with zero bookkeeping.
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:fan2', collection: 'site.standard.graph.subscription', rkey: 'sub', action: 'delete', record: null }),
    )
    const after = await app.request('/api/v1/audiences/pub-subscribers/members', { headers: AUTH })
    expect(((await after.json()) as { members: string[] }).members).toEqual(['did:plc:fan1'])
  })

  test('collection audience with matchers', async () => {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:op', rkey: 'd1', record: { title: 'A', content: { $type: 'app.offprint.content' } } }),
    )
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:lf', rkey: 'd2', record: { title: 'B', content: { $type: 'pub.leaflet.content' } } }),
    )
    await db.insert(audiences).values({
      name: 'offprint-authors',
      definition: {
        kind: 'collection',
        collection: 'site.standard.document',
        matchers: { 'content.$type': 'app.offprint.content' },
      },
    })

    const res = await app.request('/api/v1/audiences/offprint-authors/members', { headers: AUTH })
    expect(((await res.json()) as { members: string[] }).members).toEqual(['did:plc:op'])
  })

  test('static audience and membership check endpoint', async () => {
    await db.insert(audiences).values({ name: 'vips', definition: { kind: 'static', dids: ['did:plc:a', 'did:plc:b'] } })

    const yes = await app.request('/api/v1/audiences/vips/members/did:plc:a', { headers: AUTH })
    expect(((await yes.json()) as { member: boolean }).member).toBe(true)

    const no = await app.request('/api/v1/audiences/vips/members/did:plc:z', { headers: AUTH })
    expect(((await no.json()) as { member: boolean }).member).toBe(false)
  })
})

describe('audience consumption', () => {
  test('events endpoint filters by audience', async () => {
    await seedNetwork()
    await db.insert(audiences).values({
      name: 'pub-subscribers',
      definition: { kind: 'backlink', target: PUB_URI },
    })
    // New documents from a fan and from the rando.
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:fan1', rkey: 'post1', record: { title: 'Fan post' } }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:rando', rkey: 'post2', record: { title: 'Rando post' } }))

    const res = await app.request(
      '/api/v1/events?audience=pub-subscribers&collection=site.standard.document',
      { headers: AUTH },
    )
    const body = (await res.json()) as { events: { did: string }[] }

    expect(body.events).toHaveLength(1)
    expect(body.events[0]!.did).toBe('did:plc:fan1')
  })

  test('events endpoint 400s on unknown audience', async () => {
    const res = await app.request('/api/v1/events?audience=nope', { headers: AUTH })
    expect(res.status).toBe(400)
  })

  test('webhook subscription with audience only delivers member events', async () => {
    await seedNetwork()
    await db.insert(audiences).values({ name: 'pub-subscribers', definition: { kind: 'backlink', target: PUB_URI } })
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:fan1', rkey: 'post1', record: { title: 'Fan post' } }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:rando', rkey: 'post2', record: { title: 'Rando post' } }))

    const deliveries: { events: { did: string }[] }[] = []
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      deliveries.push(JSON.parse(String(init?.body)))
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    await db.insert(webhookSubscriptions).values({
      name: 'fans-hook',
      url: 'http://x.test',
      secret: 'shh',
      collections: ['site.standard.document'],
      audience: 'pub-subscribers',
      cursor: 0,
      maxWaitMs: 0,
    })
    await new WebhookWorker(db, testConfig, fakeFetch).tick()

    expect(deliveries).toHaveLength(1)
    const dids = deliveries[0]!.events.map((e) => e.did)
    expect(dids).toEqual(['did:plc:fan1'])
  })

  test('webhook with unknown audience delivers nothing', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'x' }))
    const fakeFetch = (async () => new Response('ok')) as unknown as typeof fetch
    await db.insert(webhookSubscriptions).values({
      name: 'ghost-hook',
      url: 'http://x.test',
      secret: 'shh',
      audience: 'does-not-exist',
      cursor: 0,
      maxWaitMs: 0,
    })

    expect(await new WebhookWorker(db, testConfig, fakeFetch).tick()).toBe(0)
  })
})

describe('audiences CRUD', () => {
  test('create validates definition', async () => {
    const bad = await app.request('/api/v1/audiences', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ name: 'broken', definition: { kind: 'backlink' } }),
    })
    expect(bad.status).toBe(400)

    const good = await app.request('/api/v1/audiences', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ name: 'ok', definition: { kind: 'backlink', target: PUB_URI } }),
    })
    expect(good.status).toBe(201)
  })

  test('duplicate name conflicts, delete removes', async () => {
    const make = () =>
      app.request('/api/v1/audiences', {
        method: 'POST',
        headers: JSON_AUTH,
        body: JSON.stringify({ name: 'dupe', definition: { kind: 'static', dids: [] } }),
      })
    expect((await make()).status).toBe(201)
    expect((await make()).status).toBe(409)

    const del = await app.request('/api/v1/audiences/dupe', { method: 'DELETE', headers: AUTH })
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)
    expect((await app.request('/api/v1/audiences/dupe', { headers: AUTH })).status).toBe(404)
  })
})
