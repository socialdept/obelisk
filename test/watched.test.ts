import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { TabAdmin } from '../src/ingest/tab-admin'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' }
const ALICE = 'did:plc:alice123'

interface RepoCall {
  path: string
  dids: string[]
}
let repoCalls: RepoCall[] = []

// A configured footprint Tab whose /repos/{add,remove} calls we capture.
const capturingTab = () =>
  new TabAdmin('http://footprint-tab.test', (async (input: string | URL | Request, init?: RequestInit) => {
    repoCalls.push({ path: new URL(String(input)).pathname, dids: JSON.parse(String(init?.body)).dids })
    return new Response('{}', { status: 200 })
  }) as typeof fetch)

function appWith(tab: TabAdmin): Hono {
  return createApp({ db, config: testConfig, ollama: {} as OllamaClient, tabAdmin: tab })
}

beforeAll(async () => {
  const setup = await setupTestDb()
  db = setup.db
  teardown = setup.teardown
})

afterAll(() => teardown())

beforeEach(async () => {
  await truncateAll(db)
  await db.execute(sql`TRUNCATE watched_dids RESTART IDENTITY CASCADE`)
  await db.insert(apiTokens).values({ name: 'test', tokenHash: hashToken(TOKEN) })
  repoCalls = []
})

describe('watched-dids management API', () => {
  test('add enrolls in footprint Tab and lists', async () => {
    const app = appWith(capturingTab())

    const res = await app.request('/api/v1/watched-dids', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ did: ALICE, note: 'public figure' }),
    })
    expect(res.status).toBe(201)
    const { watchedDid } = (await res.json()) as { watchedDid: { did: string; enrolled: boolean; collections: null } }
    expect(watchedDid.did).toBe(ALICE)
    expect(watchedDid.enrolled).toBe(true)
    expect(watchedDid.collections).toBeNull()
    expect(repoCalls).toEqual([{ path: '/repos/add', dids: [ALICE] }])

    const list = await app.request('/api/v1/watched-dids', { headers: AUTH })
    const body = (await list.json()) as { watchedDids: { did: string }[] }
    expect(body.watchedDids).toHaveLength(1)
    expect(body.watchedDids[0]!.did).toBe(ALICE)
  })

  test('add records the DID even when no footprint Tab is configured', async () => {
    const app = appWith(new TabAdmin(undefined))

    const res = await app.request('/api/v1/watched-dids', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ did: ALICE }),
    })
    expect(res.status).toBe(201)
    const { watchedDid } = (await res.json()) as { watchedDid: { enrolled: boolean } }
    expect(watchedDid.enrolled).toBe(false)

    // Still persisted — source of truth for LAB-29 reconcile.
    const get = await app.request(`/api/v1/watched-dids/${ALICE}`, { headers: AUTH })
    expect(get.status).toBe(200)
  })

  test('missing did rejected; duplicate conflicts', async () => {
    const app = appWith(capturingTab())
    const bad = await app.request('/api/v1/watched-dids', { method: 'POST', headers: JSON_AUTH, body: '{}' })
    expect(bad.status).toBe(400)

    const make = () =>
      app.request('/api/v1/watched-dids', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ did: ALICE }) })
    expect((await make()).status).toBe(201)
    expect((await make()).status).toBe(409)
  })

  test('deactivating un-enrolls, reactivating re-enrolls', async () => {
    const app = appWith(capturingTab())
    await app.request('/api/v1/watched-dids', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ did: ALICE }) })
    repoCalls = []

    const off = await app.request(`/api/v1/watched-dids/${ALICE}`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ active: false }),
    })
    expect(((await off.json()) as { watchedDid: { active: boolean; enrolled: boolean } }).watchedDid.active).toBe(false)
    expect(repoCalls).toEqual([{ path: '/repos/remove', dids: [ALICE] }])

    repoCalls = []
    await app.request(`/api/v1/watched-dids/${ALICE}`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ active: true }),
    })
    expect(repoCalls).toEqual([{ path: '/repos/add', dids: [ALICE] }])
  })

  test('patch of note without active change does not touch Tab', async () => {
    const app = appWith(capturingTab())
    await app.request('/api/v1/watched-dids', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ did: ALICE }) })
    repoCalls = []

    await app.request(`/api/v1/watched-dids/${ALICE}`, {
      method: 'PATCH',
      headers: JSON_AUTH,
      body: JSON.stringify({ note: 'renamed' }),
    })
    expect(repoCalls).toHaveLength(0)
  })

  test('delete removes row and un-enrolls', async () => {
    const app = appWith(capturingTab())
    await app.request('/api/v1/watched-dids', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ did: ALICE }) })
    repoCalls = []

    const res = await app.request(`/api/v1/watched-dids/${ALICE}`, { method: 'DELETE', headers: AUTH })
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true)
    expect(repoCalls).toEqual([{ path: '/repos/remove', dids: [ALICE] }])

    const gone = await app.request(`/api/v1/watched-dids/${ALICE}`, { headers: AUTH })
    expect(gone.status).toBe(404)
  })
})

describe('per-DID footprint rollup', () => {
  async function seedAlice() {
    await applyEvent(db, testConfig, makeEvent({ did: ALICE, collection: 'site.standard.document', rkey: 'd1' }))
    await applyEvent(db, testConfig, makeEvent({ did: ALICE, collection: 'site.standard.document', rkey: 'd2' }))
    await applyEvent(db, testConfig, makeEvent({ did: ALICE, collection: 'site.standard.publication', rkey: 'p1', record: { name: 'Pub' } }))
    // Soft-delete d2 — the archive remembers it.
    await applyEvent(db, testConfig, makeEvent({ did: ALICE, collection: 'site.standard.document', rkey: 'd2', action: 'delete' }))
  }

  test('counts always report the deleted breakdown; timeline respects include_deleted', async () => {
    const app = appWith(new TabAdmin(undefined))
    await seedAlice()

    const res = await app.request(`/api/v1/footprint/${ALICE}`, { headers: AUTH })
    const body = (await res.json()) as {
      watched: boolean
      totals: { records: number; deleted: number }
      collections: { collection: string; count: number; deleted: number }[]
      records: { rkey: string }[]
      cursor: string | null
    }

    expect(body.watched).toBe(false)
    expect(body.totals).toEqual({ records: 3, deleted: 1 })
    const doc = body.collections.find((r) => r.collection === 'site.standard.document')!
    expect(doc).toEqual({ collection: 'site.standard.document', count: 2, deleted: 1 })

    // Default timeline hides the soft-deleted record.
    expect(body.records.map((r) => r.rkey).sort()).toEqual(['d1', 'p1'])

    const withDeleted = await app.request(`/api/v1/footprint/${ALICE}?include_deleted=1`, { headers: AUTH })
    const full = (await withDeleted.json()) as { records: { rkey: string }[] }
    expect(full.records.map((r) => r.rkey).sort()).toEqual(['d1', 'd2', 'p1'])
  })

  test('watched DID is annotated on the footprint', async () => {
    const app = appWith(capturingTab())
    await seedAlice()
    await app.request('/api/v1/watched-dids', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ did: ALICE }) })

    const res = await app.request(`/api/v1/watched-dids/${ALICE}/footprint`, { headers: AUTH })
    const body = (await res.json()) as { watched: boolean; active?: boolean; snapshotAt: string | null }
    expect(body.watched).toBe(true)
    expect(body.active).toBe(true)
    expect(body.snapshotAt).toBeNull() // no getRepo backfill yet — bounds deletion coverage
  })

  test('service-plane getFootprint returns the same shape', async () => {
    const app = appWith(new TabAdmin(undefined))
    await seedAlice()

    const res = await app.request(`/xrpc/social.dept.obelisk.getFootprint?did=${ALICE}`, { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totals: { records: number; deleted: number } }
    expect(body.totals).toEqual({ records: 3, deleted: 1 })

    const missing = await app.request('/xrpc/social.dept.obelisk.getFootprint', { headers: AUTH })
    expect(missing.status).toBe(400)
  })
})
