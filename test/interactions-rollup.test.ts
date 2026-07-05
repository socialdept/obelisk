import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent, type RecordEvent } from '../src/ingest/upsert'
import { rebuildInteractionCounts } from '../src/ranking/interactions'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

// testConfig's `engaged` ranking tracks recommend.document → the recommended doc.
const RECOMMEND = 'site.standard.graph.recommend'
const KIND = `${RECOMMEND}:document`
const DOC_A = 'at://did:plc:author/site.standard.document/A'
const DOC_B = 'at://did:plc:author/site.standard.document/B'

/** A recommend record (source) pointing at a document (target). */
function recommendEvent(rkey: string, document: string, overrides: Partial<RecordEvent> = {}): RecordEvent {
  return makeEvent({ did: 'did:plc:fan', collection: RECOMMEND, rkey, record: { document }, ...overrides })
}

async function countFor(targetUri: string, kind = KIND): Promise<number> {
  const rows = await db.execute<{ count: string }>(
    sql`SELECT count FROM interaction_counts WHERE target_uri = ${targetUri} AND kind = ${kind}`,
  )
  return rows[0] ? Number(rows[0].count) : 0
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

describe('interaction rollup maintenance', () => {
  test('create increments the target count', async () => {
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    expect(await countFor(DOC_A)).toBe(1)
  })

  test('multiple sources sum', async () => {
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    await applyEvent(db, testConfig, recommendEvent('r2', DOC_A, { did: 'did:plc:fan2' }))
    expect(await countFor(DOC_A)).toBe(2)
  })

  test('delete decrements (floors at 0)', async () => {
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A, { action: 'delete', record: null }))
    expect(await countFor(DOC_A)).toBe(0)
  })

  test('update that re-targets moves the count', async () => {
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_B)) // newer rev, re-targets
    expect(await countFor(DOC_A)).toBe(0)
    expect(await countFor(DOC_B)).toBe(1)
  })

  test('redelivered event does not double-count', async () => {
    const evt = recommendEvent('r1', DOC_A)
    await applyEvent(db, testConfig, evt)
    await applyEvent(db, testConfig, evt) // same rev → skipped
    expect(await countFor(DOC_A)).toBe(1)
  })

  test('undelete restores the count', async () => {
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A, { action: 'delete', record: null }))
    expect(await countFor(DOC_A)).toBe(0)
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A)) // re-create
    expect(await countFor(DOC_A)).toBe(1)
  })

  test('untracked collection is ignored', async () => {
    // A subscription links to a publication, but no ranking spec tracks it.
    await applyEvent(
      db,
      testConfig,
      makeEvent({
        collection: 'site.standard.graph.subscription',
        rkey: 's1',
        record: { publication: 'at://did:plc:pub/site.standard.publication/self' },
      }),
    )
    const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM interaction_counts`)
    expect(Number(rows[0]!.n)).toBe(0)
  })
})

describe('rebuildInteractionCounts', () => {
  test('recompute matches the maintained counts and live record_links', async () => {
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    await applyEvent(db, testConfig, recommendEvent('r2', DOC_A, { did: 'did:plc:fan2' }))
    await applyEvent(db, testConfig, recommendEvent('r3', DOC_B, { did: 'did:plc:fan3' }))
    // A deleted source must not be counted by the rebuild.
    await applyEvent(db, testConfig, recommendEvent('r4', DOC_B, { did: 'did:plc:fan4' }))
    await applyEvent(
      db,
      testConfig,
      recommendEvent('r4', DOC_B, { did: 'did:plc:fan4', action: 'delete', record: null }),
    )

    const maintainedA = await countFor(DOC_A)
    const maintainedB = await countFor(DOC_B)

    await db.execute(sql`DELETE FROM interaction_counts`)
    const { rows } = await rebuildInteractionCounts(db, testConfig)

    expect(rows).toBe(2) // (DOC_A, KIND) and (DOC_B, KIND)
    expect(await countFor(DOC_A)).toBe(maintainedA)
    expect(await countFor(DOC_B)).toBe(maintainedB)
    expect(maintainedA).toBe(2)
    expect(maintainedB).toBe(1) // r3 live; r4 deleted
  })
})

describe('ranking consumes interaction counts', () => {
  /** Archive a document with FTS text so searchRecords can rank it. */
  async function seedDoc(rkey: string): Promise<void> {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:author', rkey, record: { title: 'Doc' } }))
    await db.execute(
      sql`UPDATE records SET extracted_title = 'Doc', extracted_text = 'atproto' WHERE did = 'did:plc:author' AND rkey = ${rkey}`,
    )
  }

  test('a more-recommended document ranks higher', async () => {
    await seedDoc('A')
    await seedDoc('B')
    // Two recommends point at A, none at B.
    await applyEvent(db, testConfig, recommendEvent('r1', DOC_A))
    await applyEvent(db, testConfig, recommendEvent('r2', DOC_A, { did: 'did:plc:fan2' }))

    const res = await app.request('/xrpc/site.standard.document.searchRecords', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ q: 'atproto', ranking: 'engaged' }),
    })
    expect(res.status).toBe(200)
    const { records } = (await res.json()) as { records: { uri: string; score: number }[] }
    expect(records[0]!.uri).toBe(DOC_A)
    expect(records[0]!.score).toBeGreaterThan(records[1]!.score)
  })
})
