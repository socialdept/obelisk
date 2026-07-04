import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { containment } from '../src/api/xrpc/where'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'site.standard.document'

async function getRecords(body: unknown): Promise<{ uri: string }[]> {
  const res = await app.request(`/xrpc/${NS}.getRecords`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) })
  return ((await res.json()) as { records: { uri: string }[] }).records
}
const rkeys = (recs: { uri: string }[]) => recs.map((r) => r.uri.split('/').pop()!).sort()

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

describe('record JSON filtering via containment (LAB-11)', () => {
  test('eq on a nested path matches (containment)', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'op', record: { title: 'A', content: { $type: 'app.offprint.content' } } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'lf', record: { title: 'B', content: { $type: 'pub.leaflet.content' } } }))

    const recs = await getRecords({ where: { 'content.$type': { eq: 'app.offprint.content' } } })
    expect(rkeys(recs)).toEqual(['op'])
  })

  test('in matches any of the values (OR of containments)', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'op', record: { content: { $type: 'app.offprint.content' } } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'lf', record: { content: { $type: 'pub.leaflet.content' } } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'wp', record: { content: { $type: 'com.whitewind.blog.entry' } } }))

    const recs = await getRecords({
      where: { 'content.$type': { in: ['app.offprint.content', 'pub.leaflet.content'] } },
    })
    expect(rkeys(recs)).toEqual(['lf', 'op'])
  })

  test('eq with an array value matches array membership (subset containment)', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'tagged', record: { tags: ['atproto', 'publishing'] } }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'other', record: { tags: ['cooking'] } }))

    const recs = await getRecords({ where: { tags: { eq: ['atproto'] } } })
    expect(rkeys(recs)).toEqual(['tagged'])
  })

  test('contains still works (substring, extract-text fallback)', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'op', record: { content: { $type: 'app.offprint.content' } } }))
    const recs = await getRecords({ where: { 'content.$type': { contains: 'offprint' } } })
    expect(rkeys(recs)).toEqual(['op'])
  })

  test('the GIN index exists', async () => {
    const rows = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'records' AND indexname = 'records_record_gin'`,
    )
    expect(rows).toHaveLength(1)
  })

  test('a containment filter is index-eligible', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'op', record: { content: { $type: 'app.offprint.content' } } }))
    // Force the planner off seq scans; a containment query must then choose the GIN index.
    const filter = containment(['content', '$type'], 'app.offprint.content')
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`)
      return tx.execute<{ 'QUERY PLAN': string }>(sql`EXPLAIN SELECT id FROM records WHERE ${filter}`)
    })
    const text = plan.map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toContain('records_record_gin')
  })
})
