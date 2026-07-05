import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, recordEmbeddings, records } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { eq } from 'drizzle-orm'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

const fakeOllama = {
  embed: async (inputs: string[]) => inputs.map(() => new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
} as unknown as OllamaClient

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'site.standard.document'

async function seedDoc(rkey: string, text: string, did = 'did:plc:author'): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ did, rkey, record: { title: 'Doc' } }))
  await db.execute(
    sql`UPDATE records SET extracted_title = 'Doc', extracted_text = ${text} WHERE did = ${did} AND rkey = ${rkey}`,
  )
}

function search(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/xrpc/${NS}.searchRecords`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
  )
}

interface SearchBody {
  records: { uri: string; highlight?: string }[]
  facets?: Record<string, { value: string | null; count: number }[]>
  error?: string
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

describe('search enrichment', () => {
  test('highlight returns a <mark>-wrapped excerpt over the matched term', async () => {
    await seedDoc('a', 'the atproto protocol powers the atmosphere network')

    const body = (await (await search({ q: 'atproto', highlight: true })).json()) as SearchBody
    expect(body.records[0]!.highlight).toContain('<mark>atproto</mark>')
  })

  test('no highlight field unless requested', async () => {
    await seedDoc('a', 'atproto thing')
    const body = (await (await search({ q: 'atproto' })).json()) as SearchBody
    expect(body.records[0]!.highlight).toBeUndefined()
  })

  test('facets return counts consistent with the filtered result set', async () => {
    await seedDoc('a', 'atproto one', 'did:plc:x')
    await seedDoc('b', 'atproto two', 'did:plc:x')
    await seedDoc('c', 'atproto three', 'did:plc:y')
    await seedDoc('d', 'unrelated', 'did:plc:y') // no keyword match → excluded from facets

    const body = (await (await search({ q: 'atproto', facets: ['did'] })).json()) as SearchBody
    const byDid = Object.fromEntries(body.facets!.did!.map((f) => [f.value, f.count]))
    expect(byDid['did:plc:x']).toBe(2)
    expect(byDid['did:plc:y']).toBe(1) // only the matching doc, not 'unrelated'
  })

  test('facets respect the where filter', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'op', record: { title: 'A', content: { $type: 'app.offprint.content' } } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'lf', record: { title: 'B', content: { $type: 'pub.leaflet.content' } } }))
    await db.execute(sql`UPDATE records SET extracted_title='Doc', extracted_text='atproto' WHERE rkey IN ('op','lf')`)

    const body = (await (
      await search({ q: 'atproto', facets: ['collection'], where: { 'content.$type': { eq: 'app.offprint.content' } } })
    ).json()) as SearchBody
    expect(body.facets!.collection![0]!.count).toBe(1) // only the offprint doc
  })

  test('highlight + facets compose with hybrid mode', async () => {
    await seedDoc('a', 'atproto atproto')
    const row = await db.select({ id: records.id }).from(records).where(eq(records.rkey, 'a')).then((r) => r[0]!)
    await db
      .insert(recordEmbeddings)
      .values({ recordId: row.id, chunkIndex: 0, chunkText: 'x', embedding: new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0)) })

    const body = (await (await search({ q: 'atproto', mode: 'hybrid', highlight: true, facets: ['did'] })).json()) as SearchBody
    expect(body.records[0]!.highlight).toContain('<mark>')
    expect(body.facets!.did![0]!.count).toBe(1)
  })

  test('faceting by json → InvalidRequest', async () => {
    await seedDoc('a', 'atproto')
    const res = await search({ q: 'atproto', facets: ['json'] })
    expect(res.status).toBe(400)
  })
})
