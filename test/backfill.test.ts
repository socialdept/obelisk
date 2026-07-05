import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
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
const DOC = 'site.standard.document'

interface Status {
  collection: string
  recordsArchived: number
  recordsIncludingDeleted: number
  reposSeen: number
  reposCaughtUp: number
  reposTotal: number | null
  backfillRatePerSec: number
  liveRatePerSec: number
  lastHistoricalEventAt: string | null
  windowSeconds: number
  backfilling: boolean
  complete: boolean
}

async function status(qs = ''): Promise<Status> {
  const res = await app.request(`/xrpc/social.dept.obelisk.getBackfillStatus${qs}`, { headers: AUTH })
  expect(res.status).toBe(200)
  return (await res.json()) as Status
}

/** Push events' created_at into the past so they fall outside the rate window. */
async function ageAllEvents(): Promise<void> {
  await db.execute(sql`UPDATE events SET created_at = now() - interval '1 hour'`)
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
  await db.execute(sql`TRUNCATE events RESTART IDENTITY CASCADE`)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
})

describe('getBackfillStatus', () => {
  test('active backfill: historical events in the window read as backfilling, not complete', async () => {
    // Two repos, historical (live:false) records still flowing.
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'd1', live: false }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'd2', live: false }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:b', rkey: 'd3', live: false }))

    const s = await status(`?collection=${DOC}`)
    expect(s.collection).toBe(DOC)
    expect(s.recordsArchived).toBe(3)
    expect(s.reposSeen).toBe(2)
    expect(s.reposCaughtUp).toBe(0) // no live event yet
    expect(s.backfillRatePerSec).toBeGreaterThan(0)
    expect(s.backfilling).toBe(true)
    expect(s.complete).toBe(false)
    expect(s.reposTotal).toBeNull() // no network denominator — documented gap
  })

  test('drained backfill reads as complete once historical events age out of the window', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'd1', live: false }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:b', rkey: 'd2', live: false }))
    await ageAllEvents()

    const s = await status(`?collection=${DOC}`)
    expect(s.reposSeen).toBe(2)
    expect(s.backfillRatePerSec).toBe(0)
    expect(s.backfilling).toBe(false)
    expect(s.complete).toBe(true)
    expect(s.lastHistoricalEventAt).not.toBeNull()
  })

  test('live events count toward reposCaughtUp and the live rate', async () => {
    // Repo a finished backfill (has a live event); repo b is still historical-only.
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'h1', live: false }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'l1', live: true }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:b', rkey: 'h2', live: false }))

    const s = await status(`?collection=${DOC}`)
    expect(s.reposSeen).toBe(2)
    expect(s.reposCaughtUp).toBe(1)
    expect(s.liveRatePerSec).toBeGreaterThan(0)
  })

  test('unknown collection returns a zeroed status, not an error', async () => {
    const s = await status('?collection=does.not.exist')
    expect(s.collection).toBe('does.not.exist')
    expect(s.reposSeen).toBe(0)
    expect(s.recordsArchived).toBe(0)
    expect(s.backfilling).toBe(false)
    expect(s.complete).toBe(false) // reposSeen == 0 → not "complete"
  })

  test('no collection arg returns every collection seen', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'd1', live: false }))
    await applyEvent(
      db,
      testConfig,
      makeEvent({ did: 'did:plc:a', collection: 'site.standard.publication', rkey: 'p1', record: { name: 'P' }, live: false }),
    )

    const res = await app.request('/xrpc/social.dept.obelisk.getBackfillStatus', { headers: AUTH })
    const body = (await res.json()) as { collections: Status[] }
    const names = body.collections.map((s) => s.collection).sort()
    expect(names).toEqual(['site.standard.document', 'site.standard.publication'])
  })

  test('deleted records still count in the archive total but drop from recordsArchived', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'keep', live: false }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'gone', live: false }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'gone', action: 'delete', record: null, live: false }))

    const s = await status(`?collection=${DOC}`)
    expect(s.recordsArchived).toBe(1)
    expect(s.recordsIncludingDeleted).toBe(2)
  })

  test('requires auth', async () => {
    const res = await app.request(`/xrpc/social.dept.obelisk.getBackfillStatus?collection=${DOC}`)
    expect(res.status).toBe(401)
  })
})
