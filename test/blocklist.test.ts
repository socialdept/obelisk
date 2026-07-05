import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { Blocklist } from '../src/ingest/blocklist'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono
let blocklist: Blocklist

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'social.dept.obelisk'

const SPAM = 'did:plc:spammer'

function post(verb: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(`/xrpc/${NS}.${verb}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }))
}
async function countRecords(did: string, includeDeleted = false): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    includeDeleted
      ? sql`SELECT count(*) AS n FROM records WHERE did = ${did}`
      : sql`SELECT count(*) AS n FROM records WHERE did = ${did} AND deleted_at IS NULL`,
  )
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
  blocklist = new Blocklist()
  app = createApp({ db, config: testConfig, ollama: {} as OllamaClient, blocklist })
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
  blocklist = new Blocklist()
  app = createApp({ db, config: testConfig, ollama: {} as OllamaClient, blocklist })
})

describe('applyEvent blocklist skip', () => {
  test('an event from a blocked DID is not archived; others are', async () => {
    const blocked = new Set([SPAM])
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'a' }), { skipDid: (d) => blocked.has(d) })
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:ok', rkey: 'b' }), { skipDid: (d) => blocked.has(d) })

    expect(await countRecords(SPAM)).toBe(0)
    expect(await countRecords('did:plc:ok')).toBe(1)
  })
})

describe(`${NS}.addBlockedDid`, () => {
  test('blocks a DID immediately (in-memory set updated) and lists it', async () => {
    const res = await post('addBlockedDid', { did: SPAM, note: '80% of the corpus' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { blocked: string; mode: string }).mode).toBe('block-only')

    // The shared set is live — a subsequent ingest is skipped with no reload.
    expect(blocklist.has(SPAM)).toBe(true)
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'x' }), { skipDid: (d) => blocklist.has(d) })
    expect(await countRecords(SPAM)).toBe(0)

    const list = (await (await app.request(`/xrpc/${NS}.getBlockedDids`, { headers: AUTH })).json()) as {
      blockedDids: { did: string }[]
    }
    expect(list.blockedDids.map((b) => b.did)).toEqual([SPAM])
  })

  test('purge soft-deletes existing records', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'a' }))
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'b' }))

    const res = await post('addBlockedDid', { did: SPAM, purge: true })
    const body = (await res.json()) as { purged: number; mode: string }
    expect(body).toMatchObject({ purged: 2, mode: 'soft-delete' })
    expect(await countRecords(SPAM)).toBe(0) // hidden
    expect(await countRecords(SPAM, true)).toBe(2) // still on disk (recoverable)
  })

  test('purge + force hard-deletes existing records', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'a' }))
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'b' }))

    const res = await post('addBlockedDid', { did: SPAM, purge: true, force: true })
    expect((await res.json()) as { purged: number; mode: string }).toMatchObject({ purged: 2, mode: 'hard-delete' })
    expect(await countRecords(SPAM, true)).toBe(0) // gone from disk
  })

  test('re-block updates the note without erroring (idempotent)', async () => {
    await post('addBlockedDid', { did: SPAM, note: 'first' })
    const res = await post('addBlockedDid', { did: SPAM, note: 'second' })
    expect(res.status).toBe(200)
    const rows = await db.execute<{ note: string }>(sql`SELECT note FROM blocked_dids WHERE did = ${SPAM}`)
    expect(rows[0]!.note).toBe('second')
  })

  test('missing did → InvalidRequest', async () => {
    const res = await post('addBlockedDid', {})
    expect(res.status).toBe(400)
  })
})

describe(`${NS}.removeBlockedDid`, () => {
  test('unblocks a DID and clears the in-memory set', async () => {
    await post('addBlockedDid', { did: SPAM })
    expect(blocklist.has(SPAM)).toBe(true)

    const res = await post('removeBlockedDid', { did: SPAM })
    expect(res.status).toBe(200)
    expect(blocklist.has(SPAM)).toBe(false)

    // No longer skipped.
    await applyEvent(db, testConfig, makeEvent({ did: SPAM, rkey: 'y' }), { skipDid: (d) => blocklist.has(d) })
    expect(await countRecords(SPAM)).toBe(1)
  })

  test('unblocking a DID that is not blocked → NotFound', async () => {
    const res = await post('removeBlockedDid', { did: 'did:plc:nope' })
    expect(res.status).toBe(404)
  })
})

describe('Blocklist.load', () => {
  test('loads DIDs from the table', async () => {
    await db.execute(sql`INSERT INTO blocked_dids (did) VALUES (${SPAM}), ('did:plc:two')`)
    const fresh = new Blocklist()
    await fresh.load(db)
    expect(fresh.has(SPAM)).toBe(true)
    expect(fresh.size).toBe(2)
  })
})

describe('auth', () => {
  test('addBlockedDid requires a token', async () => {
    const res = await app.request(`/xrpc/${NS}.addBlockedDid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did: SPAM }),
    })
    expect(res.status).toBe(401)
  })
})
