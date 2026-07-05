import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, audiences } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'social.dept.obelisk'
const DOCS = 'site.standard.document'

interface FeedBody {
  feed: { post: string }[]
  cursor: string | null
  error?: string
}

function get(qs: string): Promise<Response> {
  return Promise.resolve(app.request(`/xrpc/${NS}.getRankedFeed?${qs}`, { headers: AUTH }))
}
function post(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/xrpc/${NS}.getRankedFeed`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
  )
}
function rkeyOf(post: { post: string }): string {
  return post.post.split('/').pop()!
}

async function seedDoc(rkey: string, did = 'did:plc:author'): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ did, rkey, record: { title: rkey } }))
}

/** A recommend record (tracked by the `engaged` ranking) pointing at a document. */
async function recommend(rkey: string, docUri: string, did = 'did:plc:fan'): Promise<void> {
  await applyEvent(
    db,
    testConfig,
    makeEvent({ did, collection: 'site.standard.graph.recommend', rkey, record: { document: docUri } }),
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

describe(`${NS}.getRankedFeed`, () => {
  test('chrono default returns {feed:[{post}]}, newest first', async () => {
    await seedDoc('a')
    await seedDoc('b')
    await seedDoc('c')

    const res = await get(`collection=${DOCS}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as FeedBody
    expect(body.feed.map(rkeyOf)).toEqual(['c', 'b', 'a'])
    expect(body.feed[0]!.post).toStartWith('at://')
  })

  test('audience scopes the feed to member DIDs', async () => {
    await seedDoc('mine', 'did:plc:one')
    await seedDoc('theirs', 'did:plc:two')
    await db.insert(audiences).values({ name: 'aud', definition: { kind: 'static', dids: ['did:plc:one'] } })

    const body = (await (await get(`collection=${DOCS}&audience=aud`)).json()) as FeedBody
    expect(body.feed.map(rkeyOf)).toEqual(['mine'])
  })

  test('following feed: only docs under a followed publication', async () => {
    const AUTHOR = 'did:plc:author'
    const READER = 'did:plc:reader'
    const FOLLOWED = `at://${AUTHOR}/site.standard.publication/followed`
    const OTHER = `at://${AUTHOR}/site.standard.publication/other`
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: READER, collection: 'site.standard.graph.subscription', rkey: 's', record: { publication: FOLLOWED } }),
    )
    await applyEvent(db, testConfig, makeEvent({ did: AUTHOR, rkey: 'in-followed', record: { title: 'x', site: FOLLOWED } }))
    await applyEvent(db, testConfig, makeEvent({ did: AUTHOR, rkey: 'in-other', record: { title: 'y', site: OTHER } }))

    const body = (await (await get(`collection=${DOCS}&feed=following:${READER}`)).json()) as FeedBody
    expect(body.feed.map(rkeyOf)).toEqual(['in-followed'])
  })

  test('where filter narrows the feed (POST body)', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'op', record: { title: 'A', content: { $type: 'app.offprint.content' } } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'lf', record: { title: 'B', content: { $type: 'pub.leaflet.content' } } }))

    const body = (await (
      await post({ collection: DOCS, where: { 'content.$type': { eq: 'app.offprint.content' } } })
    ).json()) as FeedBody
    expect(body.feed.map(rkeyOf)).toEqual(['op'])
  })

  test('ranking by interactions: more-recommended doc ranks first', async () => {
    await seedDoc('A')
    await seedDoc('B')
    const docA = `at://did:plc:author/${DOCS}/A`
    await recommend('r1', docA)
    await recommend('r2', docA, 'did:plc:fan2')

    const body = (await (await get(`collection=${DOCS}&ranking=engaged`)).json()) as FeedBody
    expect(rkeyOf(body.feed[0]!)).toBe('A')
  })

  test('compound cursor pages with no dup/skip', async () => {
    await seedDoc('a')
    await seedDoc('b')
    await seedDoc('c')

    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 3; i++) {
      const qs = `collection=${DOCS}&limit=1` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const body = (await (await get(qs)).json()) as FeedBody
      expect(body.feed).toHaveLength(1)
      seen.push(rkeyOf(body.feed[0]!))
      cursor = body.cursor
    }
    expect(new Set(seen).size).toBe(3)
  })

  test('unknown ranking → InvalidRequest', async () => {
    const res = await get(`collection=${DOCS}&ranking=nope`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as FeedBody).error).toBe('InvalidRequest')
  })

  test('unknown audience → InvalidRequest', async () => {
    const res = await get(`collection=${DOCS}&audience=ghost`)
    expect(res.status).toBe(400)
  })

  test('requires auth', async () => {
    const res = await app.request(`/xrpc/${NS}.getRankedFeed?collection=${DOCS}`)
    expect(res.status).toBe(401)
  })
})
