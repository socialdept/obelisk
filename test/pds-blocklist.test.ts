import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { globToRegExp, PdsBlocklist } from '../src/ingest/pds-blocklist'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono
let pdsBlocklist: PdsBlocklist

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'social.dept.obelisk'

// Fake DID → PDS map; a DID not present throws (resolution failure → allow).
const PDS_OF: Record<string, string> = {
  'did:plc:bridged': 'https://atproto.pds.host',
  'did:plc:bridged2': 'https://atproto2.pds.host',
  'did:plc:real': 'https://bsky.social',
}
let resolveCalls = 0
async function fakeResolve(did: string): Promise<string> {
  resolveCalls += 1
  const pds = PDS_OF[did]
  if (!pds) throw new Error(`no PDS for ${did}`)
  return pds
}

async function countRecords(did: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM records WHERE did = ${did}`)
  return Number(rows[0]!.n)
}
function post(verb: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(`/xrpc/${NS}.${verb}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }))
}
/** Emulate the ingester: pre-resolve then apply with the sync skip check. */
async function ingest(did: string, rkey: string): Promise<void> {
  await pdsBlocklist.ensureDecided([did])
  await applyEvent(db, testConfig, makeEvent({ did, rkey }), { skipDid: (d) => pdsBlocklist.isBlocked(d) })
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
  resolveCalls = 0
  pdsBlocklist = new PdsBlocklist(db, fakeResolve, 60_000)
  app = createApp({ db, config: testConfig, ollama: {} as OllamaClient, pdsBlocklist })
})

describe('globToRegExp', () => {
  test('wildcard matches sub-hosts; anchored; case-insensitive; slash-normalized', () => {
    const re = globToRegExp('https://*.pds.host')
    expect(re.test('https://atproto.pds.host')).toBe(true)
    expect(re.test('https://atproto2.pds.host')).toBe(true)
    expect(re.test('https://PDS.host'.toLowerCase())).toBe(false) // needs a sub-host label
    expect(re.test('https://evil.example')).toBe(false)
    expect(re.test('https://atproto.pds.host.evil.com')).toBe(false) // anchored end
  })
})

describe('PdsBlocklist enforcement', () => {
  test('a DID on a blocked PDS is not archived; others are', async () => {
    await post('addBlockedPds', { pattern: 'https://*.pds.host' })

    await ingest('did:plc:bridged', 'a')
    await ingest('did:plc:real', 'b')

    expect(await countRecords('did:plc:bridged')).toBe(0)
    expect(await countRecords('did:plc:real')).toBe(1)
  })

  test('wildcard covers a newly-added sub-host', async () => {
    await post('addBlockedPds', { pattern: 'https://*.pds.host' })
    await ingest('did:plc:bridged2', 'a') // atproto2.pds.host
    expect(await countRecords('did:plc:bridged2')).toBe(0)
  })

  test('resolution failure → allowed (archived)', async () => {
    await post('addBlockedPds', { pattern: 'https://*.pds.host' })
    await ingest('did:plc:unknown', 'a') // fakeResolve throws
    expect(await countRecords('did:plc:unknown')).toBe(1)
  })

  test('no patterns → ensureDecided is a no-op (no resolution)', async () => {
    await ingest('did:plc:bridged', 'a')
    expect(resolveCalls).toBe(0)
    expect(await countRecords('did:plc:bridged')).toBe(1)
  })

  test('did_pds cache avoids re-resolving within TTL', async () => {
    await post('addBlockedPds', { pattern: 'https://*.pds.host' })
    await ingest('did:plc:bridged', 'a')
    const after1 = resolveCalls

    // A fresh instance (cold in-memory decisions) still hits the did_pds row, no network.
    const fresh = new PdsBlocklist(db, fakeResolve, 60_000)
    await fresh.loadPatterns()
    await fresh.ensureDecided(['did:plc:bridged'])
    expect(resolveCalls).toBe(after1) // no new network call
    expect(fresh.isBlocked('did:plc:bridged')).toBe(true)

    const row = await db.execute<{ pds: string }>(sql`SELECT pds FROM did_pds WHERE did = 'did:plc:bridged'`)
    expect(row[0]!.pds).toBe('https://atproto.pds.host')
  })

  test('removing the pattern stops the block', async () => {
    await post('addBlockedPds', { pattern: 'https://*.pds.host' })
    const res = await post('removeBlockedPds', { pattern: 'https://*.pds.host' })
    expect(res.status).toBe(200)

    await ingest('did:plc:bridged', 'a')
    expect(await countRecords('did:plc:bridged')).toBe(1)
  })
})

describe(`${NS}.getBlockedPdses / errors / auth`, () => {
  test('lists blocked patterns', async () => {
    await post('addBlockedPds', { pattern: 'https://*.pds.host', note: 'bridge noise' })
    const body = (await (await app.request(`/xrpc/${NS}.getBlockedPdses`, { headers: AUTH })).json()) as {
      blockedPdses: { pattern: string }[]
    }
    expect(body.blockedPdses.map((p) => p.pattern)).toEqual(['https://*.pds.host'])
  })

  test('missing pattern → InvalidRequest; unblock-unknown → NotFound', async () => {
    expect((await post('addBlockedPds', {})).status).toBe(400)
    expect((await post('removeBlockedPds', { pattern: 'https://nope' })).status).toBe(404)
  })

  test('addBlockedPds requires auth', async () => {
    const res = await app.request(`/xrpc/${NS}.addBlockedPds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'https://*.pds.host' }),
    })
    expect(res.status).toBe(401)
  })
})
