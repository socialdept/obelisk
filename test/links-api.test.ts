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

const PUB_DID = 'did:plc:publisher'
const PUB_RKEY = 'pub-1'
const PUB_URI = `at://${PUB_DID}/site.standard.publication/${PUB_RKEY}`

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

  await applyEvent(
    db,
    testConfig,
    makeEvent({ did: PUB_DID, collection: 'site.standard.publication', rkey: PUB_RKEY, record: { name: 'The Pub' } }),
  )
  await applyEvent(
    db,
    testConfig,
    makeEvent({
      did: 'did:plc:reader',
      collection: 'site.standard.graph.subscription',
      rkey: 'sub-1',
      record: { publication: PUB_URI },
    }),
  )
})

describe('links endpoints', () => {
  test('outgoing links for a subscription', async () => {
    const res = await app.request('/api/v1/records/did:plc:reader/site.standard.graph.subscription/sub-1/links', {
      headers: AUTH,
    })
    const body = (await res.json()) as { links: { targetUri: string; path: string }[] }

    expect(res.status).toBe(200)
    expect(body.links).toHaveLength(1)
    expect(body.links[0]!).toMatchObject({ path: 'publication', targetUri: PUB_URI })
  })

  test('internal backlinks: subscription shows up on the publication', async () => {
    const res = await app.request(
      `/api/v1/records/${PUB_DID}/site.standard.publication/${PUB_RKEY}/backlinks`,
      { headers: AUTH },
    )
    const body = (await res.json()) as { backlinks: { path: string; source: { rkey: string } }[] }

    expect(body.backlinks).toHaveLength(1)
    expect(body.backlinks[0]!.path).toBe('publication')
    expect(body.backlinks[0]!.source.rkey).toBe('sub-1')
  })

  test('backlinks filterable by source collection', async () => {
    const res = await app.request(
      `/api/v1/records/${PUB_DID}/site.standard.publication/${PUB_RKEY}/backlinks?collection=site.standard.graph.recommend`,
      { headers: AUTH },
    )
    const body = (await res.json()) as { backlinks: unknown[] }

    expect(body.backlinks).toHaveLength(0)
  })

  test('soft-deleted sources drop out of backlinks', async () => {
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:reader', collection: 'site.standard.graph.subscription', rkey: 'sub-1', action: 'delete', record: null }),
    )

    const res = await app.request(
      `/api/v1/records/${PUB_DID}/site.standard.publication/${PUB_RKEY}/backlinks`,
      { headers: AUTH },
    )
    const body = (await res.json()) as { backlinks: unknown[] }

    expect(body.backlinks).toHaveLength(0)
  })

  test('plain record fetch still works alongside links routes', async () => {
    const res = await app.request(`/api/v1/records/${PUB_DID}/site.standard.publication/${PUB_RKEY}`, { headers: AUTH })
    expect(res.status).toBe(200)
  })
})
