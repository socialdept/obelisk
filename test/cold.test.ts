import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, recordEmbeddings, records } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { ColdList, ColdPdsList } from '../src/ingest/cold'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono
let coldList: ColdList
let coldPdsList: ColdPdsList

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'social.dept.obelisk'

const COLD = 'did:plc:coldrepo'
const WARM = 'did:plc:warmrepo'

// Fake DID → PDS for the cold-PDS tests.
const PDS_OF: Record<string, string> = {
  'did:plc:onhost': 'https://atproto.pds.host',
  'did:plc:elsewhere': 'https://bsky.social',
}
async function fakeResolve(did: string): Promise<string> {
  const pds = PDS_OF[did]
  if (!pds) throw new Error(`no PDS for ${did}`)
  return pds
}

function post(verb: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(`/xrpc/${NS}.${verb}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }))
}

async function statusOf(did: string): Promise<{ cold: boolean; embed_status: string }[]> {
  return db.execute<{ cold: boolean; embed_status: string }>(
    sql`SELECT cold, embed_status FROM records WHERE did = ${did} ORDER BY rkey`,
  )
}

/** Emulate the ingester's cold decision for a DID event. */
function coldDidFn(did: string): boolean {
  return coldList.has(did) || coldPdsList.isCold(did)
}

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
  coldList = new ColdList()
  coldPdsList = new ColdPdsList(db, fakeResolve)
  app = createApp({ db, config: testConfig, ollama: {} as OllamaClient, coldList, coldPdsList })
})

describe('applyEvent cold decision', () => {
  test('a cold DID is archived but marked cold + embed skipped; a warm DID stays pending', async () => {
    coldList.addLocal(COLD)
    await applyEvent(db, testConfig, makeEvent({ did: COLD, rkey: 'a' }), { coldDid: coldDidFn })
    await applyEvent(db, testConfig, makeEvent({ did: WARM, rkey: 'b' }), { coldDid: coldDidFn })

    expect(await statusOf(COLD)).toEqual([{ cold: true, embed_status: 'skipped' }])
    expect(await statusOf(WARM)).toEqual([{ cold: false, embed_status: 'pending' }])
  })
})

describe(`${NS}.addColdDid`, () => {
  test('cools existing records (marks cold + skipped, purges embeddings) and updates the live set', async () => {
    // Two warm records with a stale embedding each.
    await applyEvent(db, testConfig, makeEvent({ did: COLD, rkey: 'a' }), { coldDid: coldDidFn })
    await applyEvent(db, testConfig, makeEvent({ did: COLD, rkey: 'b' }), { coldDid: coldDidFn })
    const rows = await db.select({ id: records.id }).from(records).where(sql`did = ${COLD}`)
    for (const r of rows) {
      await db.insert(recordEmbeddings).values({
        recordId: r.id,
        chunkIndex: 0,
        chunkText: 'x',
        embedding: Array(768).fill(0),
      })
    }

    const res = await post('addColdDid', { did: COLD, note: 'high volume, low value' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cold: COLD, cooled: 2, embeddingsPurged: 2 })

    // Live set updated — next event goes cold with no reload.
    expect(coldList.has(COLD)).toBe(true)
    expect(await statusOf(COLD)).toEqual([
      { cold: true, embed_status: 'skipped' },
      { cold: true, embed_status: 'skipped' },
    ])
    const embeds = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM record_embeddings`)
    expect(Number(embeds[0]!.n)).toBe(0)

    const list = (await (await app.request(`/xrpc/${NS}.getColdDids`, { headers: AUTH })).json()) as {
      coldDids: { did: string }[]
    }
    expect(list.coldDids.map((d) => d.did)).toEqual([COLD])
  })

  test('missing did → InvalidRequest', async () => {
    expect((await post('addColdDid', {})).status).toBe(400)
  })
})

describe(`${NS}.removeColdDid`, () => {
  test('un-cools: clears the flag and re-queues records for embedding', async () => {
    coldList.addLocal(COLD)
    await applyEvent(db, testConfig, makeEvent({ did: COLD, rkey: 'a' }), { coldDid: coldDidFn })
    await post('addColdDid', { did: COLD })

    const res = await post('removeColdDid', { did: COLD })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ warmed: COLD, requeued: 1 })
    expect(coldList.has(COLD)).toBe(false)
    expect(await statusOf(COLD)).toEqual([{ cold: false, embed_status: 'pending' }])
  })

  test('un-cooling a DID that is not cold → NotFound', async () => {
    expect((await post('removeColdDid', { did: 'did:plc:nope' })).status).toBe(404)
  })
})

describe('searchRecords hides cold by default', () => {
  async function search(body: object): Promise<string[]> {
    const res = await app.request(`/xrpc/site.standard.document.searchRecords`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as { records: { did: string }[] }
    return json.records.map((r) => r.did)
  }

  beforeEach(async () => {
    coldList.addLocal(COLD)
    await applyEvent(db, testConfig, makeEvent({ did: COLD, rkey: 'a' }), { coldDid: coldDidFn })
    await applyEvent(db, testConfig, makeEvent({ did: WARM, rkey: 'b' }), { coldDid: coldDidFn })
    // FTS's `searchable` is generated from extracted_*, which the embed worker
    // populates — seed it directly since the worker doesn't run in this test.
    await db.execute(sql`UPDATE records SET extracted_text = 'a document about atproto'`)
  })

  test('default: only the warm record matches', async () => {
    expect(await search({ q: 'atproto' })).toEqual([WARM])
  })

  test('includeCold: both records match', async () => {
    expect((await search({ q: 'atproto', includeCold: true })).sort()).toEqual([COLD, WARM].sort())
  })
})

describe('ColdPdsList (forward-only)', () => {
  test('matchesPds honors the glob and slash-normalizes', () => {
    const list = new ColdPdsList(db, fakeResolve)
    // @ts-expect-error — poke the private set for a unit check
    list.patterns = [/^https:\/\/.*\.pds\.host$/i]
    expect(list.matchesPds('https://atproto.pds.host/')).toBe(true)
    expect(list.matchesPds('https://bsky.social')).toBe(false)
    expect(list.matchesPds(null)).toBe(false)
  })

  test('cools new records from a matching PDS after ensureDecided', async () => {
    await post('addColdPds', { pattern: 'https://*.pds.host' })
    await coldPdsList.ensureDecided(['did:plc:onhost', 'did:plc:elsewhere'])

    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:onhost', rkey: 'a' }), { coldDid: coldDidFn })
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:elsewhere', rkey: 'b' }), { coldDid: coldDidFn })

    expect(await statusOf('did:plc:onhost')).toEqual([{ cold: true, embed_status: 'skipped' }])
    expect(await statusOf('did:plc:elsewhere')).toEqual([{ cold: false, embed_status: 'pending' }])
  })

  test('removeColdPds → NotFound when the pattern is not cold', async () => {
    expect((await post('removeColdPds', { pattern: 'https://*.nope' })).status).toBe(404)
  })
})

describe('aggregate filters by cold', () => {
  test('where cold eq true counts only cold records', async () => {
    coldList.addLocal(COLD)
    await applyEvent(db, testConfig, makeEvent({ did: COLD, rkey: 'a' }), { coldDid: coldDidFn })
    await applyEvent(db, testConfig, makeEvent({ did: WARM, rkey: 'b' }), { coldDid: coldDidFn })

    const res = await app.request(`/xrpc/${NS}.aggregate`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ groupBy: 'collection', where: { cold: { eq: true } } }),
    })
    const { groups } = (await res.json()) as { groups: { key: Record<string, string>; count: number }[] }
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(1)
  })
})

describe('ColdList.load', () => {
  test('loads DIDs from the table', async () => {
    await db.execute(sql`INSERT INTO cold_dids (did) VALUES (${COLD}), ('did:plc:two')`)
    const fresh = new ColdList()
    await fresh.load(db)
    expect(fresh.has(COLD)).toBe(true)
    expect(fresh.size).toBe(2)
  })
})
