import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { applyEvent } from '../src/ingest/upsert'
import { compileRanking, decodeRankingCursor } from '../src/ranking/compile'
import { validateRankings } from '../src/ranking/config'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'site.standard.document'

/**
 * Archive a doc, populate the extracted text FTS reads from (the extraction step
 * is the embed worker's job, not synchronous ingest — mirror api.test.ts), and
 * stamp indexed_at (defaultNow otherwise).
 */
async function seedDoc(rkey: string, text: string, hoursAgo: number): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ rkey, record: { title: 'Doc', textContent: text } }))
  const indexedAt = new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  await db.execute(
    sql`UPDATE records SET extracted_title = 'Doc', extracted_text = ${text}, indexed_at = ${indexedAt} WHERE rkey = ${rkey}`,
  )
}

/** searchRecords serializes to `uri` (not `rkey`); pull the rkey off the at-uri. */
function rkeyOf(record: { uri: string }): string {
  return record.uri.split('/').pop()!
}

function search(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/xrpc/${NS}.searchRecords`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
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

describe('validateRankings', () => {
  test('accepts valid profiles and undefined', () => {
    expect(() => validateRankings(undefined)).not.toThrow()
    expect(() => validateRankings(testConfig.rankings)).not.toThrow()
  })

  test('rejects empty signals', () => {
    expect(() => validateRankings({ bad: { signals: [] } })).toThrow(/non-empty signals/)
  })

  test('rejects recency with non-positive half-life', () => {
    expect(() =>
      validateRankings({ bad: { signals: [{ kind: 'recency', weight: 1, field: 'indexedAt', halfLifeHours: 0 }] } }),
    ).toThrow(/halfLifeHours/)
  })

  test('rejects interactions with no links', () => {
    expect(() =>
      validateRankings({ bad: { signals: [{ kind: 'interactions', weight: 1, links: [] }] } }),
    ).toThrow(/non-empty links/)
  })

  test('rejects unknown signal kind', () => {
    expect(() =>
      // @ts-expect-error intentionally malformed
      validateRankings({ bad: { signals: [{ kind: 'nope', weight: 1 }] } }),
    ).toThrow(/unknown signal kind/)
  })
})

describe('compileRanking', () => {
  test('recency-only orders newest first', async () => {
    await seedDoc('a', 'x', 72)
    await seedDoc('b', 'x', 48)
    await seedDoc('c', 'x', 24)

    const compiled = compileRanking(testConfig.rankings!.recent!, { idColumn: sql`records.id` })
    const rows = await db.execute<{ rkey: string; score: number }>(sql`
      SELECT rkey, (${compiled.score}) AS score FROM records ORDER BY ${compiled.orderBy}
    `)
    expect(rows.map((r) => r.rkey)).toEqual(['c', 'b', 'a'])
    // Fresher row scores strictly higher.
    expect(Number(rows[0]!.score)).toBeGreaterThan(Number(rows[2]!.score))
  })

  test('relevance signal with no query context contributes 0 → falls back to id DESC', async () => {
    await seedDoc('a', 'x', 24)
    await seedDoc('b', 'x', 48)

    const compiled = compileRanking({ signals: [{ kind: 'relevance', weight: 1 }] }, { idColumn: sql`records.id` })
    const rows = await db.execute<{ rkey: string; score: number }>(sql`
      SELECT rkey, (${compiled.score}) AS score FROM records ORDER BY ${compiled.orderBy}
    `)
    expect(rows.every((r) => Number(r.score) === 0)).toBe(true)
    // a inserted first (lower id); id DESC tiebreak → b then a.
    expect(rows.map((r) => r.rkey)).toEqual(['b', 'a'])
  })

  test('interactions term is a stubbed 0 (no rollup yet)', async () => {
    await seedDoc('a', 'x', 24)
    const compiled = compileRanking(testConfig.rankings!.engaged!, { idColumn: sql`records.id` })
    const rows = await db.execute<{ score: number }>(sql`
      SELECT (${compiled.score}) AS score FROM records
    `)
    // engaged = interactions(→0) + recency; score equals the recency term alone, in (0,1].
    expect(Number(rows[0]!.score)).toBeGreaterThan(0)
    expect(Number(rows[0]!.score)).toBeLessThanOrEqual(1)
  })
})

describe(`${NS}.searchRecords ranking`, () => {
  test('orders by profile; equal relevance broken by recency (newest first)', async () => {
    await seedDoc('a', 'atproto atproto', 72)
    await seedDoc('b', 'atproto atproto', 48)
    await seedDoc('c', 'atproto atproto', 24)

    const res = await search({ q: 'atproto', ranking: 'relevant-fresh' })
    expect(res.status).toBe(200)
    const { records } = (await res.json()) as { records: { uri: string; score: number }[] }
    expect(records.map(rkeyOf)).toEqual(['c', 'b', 'a'])
    expect(records[0]!.score).toBeGreaterThan(records[2]!.score)
  })

  test('unknown profile → InvalidRequest', async () => {
    await seedDoc('a', 'atproto', 24)
    const res = await search({ q: 'atproto', ranking: 'does-not-exist' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('InvalidRequest')
  })

  test('semantic + ranking → InvalidRequest (not supported yet)', async () => {
    const res = await search({ q: 'atproto', ranking: 'relevant-fresh', semantic: true })
    expect(res.status).toBe(400)
  })

  test('compound cursor pages stably with no dup/skip', async () => {
    await seedDoc('a', 'atproto atproto', 72)
    await seedDoc('b', 'atproto atproto', 48)
    await seedDoc('c', 'atproto atproto', 24)

    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 3; i++) {
      const res = await search({ q: 'atproto', ranking: 'relevant-fresh', limit: 1, cursor })
      const body = (await res.json()) as { records: { uri: string }[]; cursor?: string }
      expect(body.records).toHaveLength(1)
      seen.push(rkeyOf(body.records[0]!))
      cursor = body.cursor
    }
    expect(seen).toEqual(['c', 'b', 'a']) // full ordered set, once each
    expect(new Set(seen).size).toBe(3)
  })

  test('returned cursor decodes to the last row score/id + an anchor', async () => {
    await seedDoc('a', 'atproto', 24)
    const res = await search({ q: 'atproto', ranking: 'relevant-fresh', limit: 1 })
    const body = (await res.json()) as { records: { score: number }[]; cursor?: string }
    expect(typeof body.cursor).toBe('string')
    const decoded = decodeRankingCursor(body.cursor!)
    expect('error' in decoded).toBe(false)
    if ('error' in decoded) return
    expect(decoded.id).toBe(1) // first row after RESTART IDENTITY
    expect(decoded.score).toBe(body.records[0]!.score)
    expect(decoded.anchorMs).toBeGreaterThan(0)
  })
})
