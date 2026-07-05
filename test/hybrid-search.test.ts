import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, recordEmbeddings, records } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'site.standard.document'

/** Pad a short vector to the 768-dim embedding width. */
function vec(head: number[]): number[] {
  return [...head, ...new Array(768 - head.length).fill(0)]
}

// The query always embeds to this direction; docs are seeded relative to it.
const QUERY_VEC = vec([0, 1, 0])
const fakeOllama = { embed: async (inputs: string[]) => inputs.map(() => QUERY_VEC) } as unknown as OllamaClient

/** Archive a doc with FTS text + a manual embedding at `embedding`. */
async function seedDoc(rkey: string, text: string, embedding: number[], did = 'did:plc:author'): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ did, rkey, record: { title: 'Doc' } }))
  await db.execute(
    sql`UPDATE records SET extracted_title = 'Doc', extracted_text = ${text} WHERE did = ${did} AND rkey = ${rkey}`,
  )
  const row = await db.select({ id: records.id }).from(records).where(eq(records.rkey, rkey)).then((r) => r[0]!)
  await db.insert(recordEmbeddings).values({ recordId: row.id, chunkIndex: 0, chunkText: text, embedding })
}

function search(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/xrpc/${NS}.searchRecords`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
  )
}

function rkeyOf(r: { uri: string }): string {
  return r.uri.split('/').pop()!
}

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

describe(`${NS}.searchRecords mode=hybrid`, () => {
  test('fuses FTS and vector legs — a doc strong in either surfaces above one strong in neither', async () => {
    // A: strong FTS, far vector. B: no FTS, closest vector. C: no FTS, far vector.
    await seedDoc('A', 'atproto atproto', vec([0, 0.7071, 0.7071]))
    await seedDoc('B', 'nothing here', vec([0, 1, 0]))
    await seedDoc('C', 'nothing here', vec([1, 0, 0]))

    const res = await search({ q: 'atproto', mode: 'hybrid' })
    expect(res.status).toBe(200)
    const { records: recs } = (await res.json()) as { records: { uri: string; score: number }[] }
    const order = recs.map(rkeyOf)
    // A wins (both legs), B is present via the vector leg alone, C trails.
    expect(order[0]).toBe('A')
    expect(order).toContain('B')
    expect(order.at(-1)).toBe('C')
  })

  test('where filter is honored in both legs', async () => {
    await seedDoc('A', 'atproto atproto', vec([0, 1, 0]), 'did:plc:keep')
    await seedDoc('B', 'atproto atproto', vec([0, 1, 0]), 'did:plc:drop')

    const res = await search({ q: 'atproto', mode: 'hybrid', where: { did: { eq: 'did:plc:keep' } } })
    const { records: recs } = (await res.json()) as { records: { uri: string }[] }
    expect(recs.map(rkeyOf)).toEqual(['A'])
  })

  test('composes with a ranking profile (fused relevance feeds the score)', async () => {
    await seedDoc('A', 'atproto atproto', vec([0, 1, 0]))
    await seedDoc('B', 'atproto', vec([1, 0, 0]))

    const res = await search({ q: 'atproto', mode: 'hybrid', ranking: 'relevant-fresh' })
    expect(res.status).toBe(200)
    const { records: recs } = (await res.json()) as { records: { uri: string; score: number }[] }
    // A is stronger in both legs → ranks first; scores are the profile's, not raw RRF.
    expect(rkeyOf(recs[0]!)).toBe('A')
    expect(recs[0]!.score).toBeGreaterThan(recs[1]!.score)
  })

  test('unknown ranking profile → InvalidRequest', async () => {
    await seedDoc('A', 'atproto', vec([0, 1, 0]))
    const res = await search({ q: 'atproto', mode: 'hybrid', ranking: 'nope' })
    expect(res.status).toBe(400)
  })

  test('compound cursor pages the fused list with no dup/skip', async () => {
    await seedDoc('A', 'atproto atproto', vec([0, 0.7071, 0.7071]))
    await seedDoc('B', 'nothing', vec([0, 1, 0]))
    await seedDoc('C', 'nothing', vec([1, 0, 0]))

    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 3; i++) {
      const res = await search({ q: 'atproto', mode: 'hybrid', limit: 1, cursor })
      const body = (await res.json()) as { records: { uri: string }[]; cursor?: string }
      expect(body.records).toHaveLength(1)
      seen.push(rkeyOf(body.records[0]!))
      cursor = body.cursor
    }
    expect(new Set(seen).size).toBe(3)
  })

  test('unknown mode → InvalidRequest', async () => {
    const res = await search({ q: 'atproto', mode: 'fuzzy' })
    expect(res.status).toBe(400)
  })
})
