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
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' }

const COLLECTION = 'site.standard.document'

function xrpc(method: string, body?: unknown): Promise<Response> {
  return Promise.resolve(app.request(`/xrpc/${COLLECTION}.${method}`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify(body ?? {}),
  }))
}

async function seed(): Promise<void> {
  await applyEvent(
    db,
    testConfig,
    makeEvent({
      did: 'did:plc:alice',
      rkey: 'd1',
      record: { title: 'Grunge Revival', content: { $type: 'app.offprint.content' }, tags: [] },
    }),
  )
  await applyEvent(
    db,
    testConfig,
    makeEvent({
      did: 'did:plc:bob',
      rkey: 'd2',
      record: { title: 'Quiet Gardens', content: { $type: 'pub.leaflet.content' } },
    }),
  )
  await applyEvent(
    db,
    testConfig,
    makeEvent({
      did: 'did:plc:alice',
      rkey: 'd3',
      record: { title: 'Grunge Archives', content: { $type: 'pub.leaflet.content' } },
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

describe('/xrpc/{collection}.getRecords', () => {
  test('returns atproto-shaped records for the method collection only', async () => {
    await seed()
    await applyEvent(
      db,
      testConfig,
      makeEvent({ collection: 'site.standard.publication', rkey: 'p1', record: { name: 'A pub' } }),
    )

    const res = await xrpc('getRecords', {})
    const body = (await res.json()) as { records: { collection: string; value: { title: string }; uri: string }[] }

    expect(res.status).toBe(200)
    expect(body.records).toHaveLength(3)
    for (const record of body.records) {
      expect(record.collection).toBe(COLLECTION)
      expect(record.value).toBeDefined()
      expect(record.uri).toStartWith('at://')
    }
  })

  test('where: eq on system field, contains on record field, in on nested path', async () => {
    await seed()

    const byDid = await xrpc('getRecords', { where: { did: { eq: 'did:plc:alice' } } })
    expect(((await byDid.json()) as { records: unknown[] }).records).toHaveLength(2)

    const byTitle = await xrpc('getRecords', { where: { title: { contains: 'grunge' } } })
    expect(((await byTitle.json()) as { records: unknown[] }).records).toHaveLength(2)

    const byType = await xrpc('getRecords', {
      where: { 'content.$type': { in: ['app.offprint.content'] } },
    })
    const typed = (await byType.json()) as { records: { value: { title: string } }[] }
    expect(typed.records).toHaveLength(1)
    expect(typed.records[0]!.value.title).toBe('Grunge Revival')
  })

  test('record. prefix forces a JSON path past system-field shadowing', async () => {
    // A record whose own body carries a `did` key that differs from its repo DID.
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:alice', rkey: 'r1', record: { title: 'Owned', did: 'did:plc:subject' } }),
    )
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:alice', rkey: 'r2', record: { title: 'Other', did: 'did:plc:someone-else' } }),
    )

    // Bare `did` hits the indexed system column (repo DID) — both records match.
    const bySystem = await xrpc('getRecords', { where: { did: { eq: 'did:plc:alice' } } })
    expect(((await bySystem.json()) as { records: unknown[] }).records).toHaveLength(2)

    // `record.did` reaches into the record body instead — only the one match.
    const byRecord = await xrpc('getRecords', { where: { 'record.did': { eq: 'did:plc:subject' } } })
    const scoped = (await byRecord.json()) as { records: { value: { title: string } }[] }
    expect(scoped.records).toHaveLength(1)
    expect(scoped.records[0]!.value.title).toBe('Owned')
  })

  test('json special field searches the whole record', async () => {
    await seed()
    const res = await xrpc('getRecords', { where: { json: { contains: 'offprint' } } })
    expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(1)
  })

  test('sortBy record field with cursor pagination', async () => {
    await seed()

    const page1 = await xrpc('getRecords', { sortBy: [{ field: 'title', direction: 'asc' }], limit: 2 })
    const body1 = (await page1.json()) as { records: { value: { title: string } }[]; cursor?: string }
    expect(body1.records.map((r) => r.value.title)).toEqual(['Grunge Archives', 'Grunge Revival'])
    expect(body1.cursor).toBeDefined()

    const page2 = await xrpc('getRecords', {
      sortBy: [{ field: 'title', direction: 'asc' }],
      limit: 2,
      cursor: body1.cursor,
    })
    const body2 = (await page2.json()) as { records: { value: { title: string } }[]; cursor?: string }
    expect(body2.records.map((r) => r.value.title)).toEqual(['Quiet Gardens'])
    expect(body2.cursor).toBeUndefined()
  })

  test('soft-deleted records excluded unless includeDeleted', async () => {
    await seed()
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:alice', rkey: 'd1', action: 'delete', record: null }))

    const hidden = await xrpc('getRecords', {})
    expect(((await hidden.json()) as { records: unknown[] }).records).toHaveLength(2)

    const shown = await xrpc('getRecords', { includeDeleted: true })
    expect(((await shown.json()) as { records: unknown[] }).records).toHaveLength(3)
  })

  test('bad where operator returns atproto error shape', async () => {
    const res = await xrpc('getRecords', { where: { title: { like: 'x' } } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('InvalidRequest')
    expect(body.message).toContain('unknown operator')
  })
})

describe('/xrpc/{collection}.getRecord', () => {
  test('fetches by uri, 404s with RecordNotFound', async () => {
    await seed()
    const uri = `at://did:plc:alice/${COLLECTION}/d1`

    const res = await app.request(`/xrpc/${COLLECTION}.getRecord?uri=${encodeURIComponent(uri)}`, { headers: AUTH })
    const body = (await res.json()) as { uri: string; value: { title: string } }
    expect(body.uri).toBe(uri)
    expect(body.value.title).toBe('Grunge Revival')

    const missing = await app.request(`/xrpc/${COLLECTION}.getRecord?uri=${encodeURIComponent(uri + 'x')}`, {
      headers: AUTH,
    })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toBe('RecordNotFound')
  })
})

describe('/xrpc/{collection}.countRecords', () => {
  test('counts with where filters', async () => {
    await seed()
    const res = await xrpc('countRecords', { where: { did: { eq: 'did:plc:alice' } } })
    expect(((await res.json()) as { count: number }).count).toBe(2)
  })
})

describe('write verbs and unknown methods', () => {
  test('write verbs return MethodNotImplemented', async () => {
    const res = await xrpc('createRecord', { record: {} })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('MethodNotImplemented')
    expect(body.message).toContain('read-only')
  })

  test('unknown verb 501s, garbage NSID 400s', async () => {
    expect((await xrpc('explodeRecords')).status).toBe(501)

    const bad = await app.request('/xrpc/notansid.getRecords', { method: 'POST', headers: JSON_AUTH, body: '{}' })
    expect(bad.status).toBe(400)
  })
})
