import postgres from 'postgres'
import { createDb, type Db } from '../src/db/client'
import { migrate } from '../src/db/migrate'
import type { ObeliskConfig } from '../src/config'
import type { RecordEvent } from '../src/ingest/upsert'

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://obelisk:obelisk@localhost:5432/obelisk'
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://obelisk:obelisk@localhost:5432/obelisk_test'

export async function setupTestDb(): Promise<{ db: Db; teardown: () => Promise<void> }> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  const dbName = TEST_DATABASE_URL.split('/').pop()!
  const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
  if (exists.length === 0) await admin.unsafe(`CREATE DATABASE ${dbName}`)
  await admin.end()

  await migrate(TEST_DATABASE_URL)

  const { db, client } = createDb(TEST_DATABASE_URL)
  return { db, teardown: () => client.end() }
}

export async function truncateAll(db: Db): Promise<void> {
  const { sql } = await import('drizzle-orm')
  await db.execute(
    sql.raw(
      'TRUNCATE records, record_embeddings, record_links, interaction_counts, blocked_dids, blocked_pdses, cold_dids, cold_pdses, did_pds, constellation_cache, api_tokens RESTART IDENTITY CASCADE',
    ),
  )
}

export const testConfig: ObeliskConfig = {
  collections: {
    'site.standard.document': { textFields: ['title', 'description', 'textContent'] },
    'site.standard.publication': { textFields: ['name', 'description'] },
    'site.standard.graph.subscription': {},
    'site.standard.graph.recommend': {},
  },
  ollama: { model: 'nomic-embed-text', dimensions: 768, chunkChars: 1800, chunkOverlap: 200 },
  constellation: { baseUrl: 'https://constellation.example', ttlSeconds: 3600, userAgent: 'obelisk-test' },
  feeds: { following: { collection: 'site.standard.graph.subscription', path: 'publication' } },
  rankings: {
    recent: { signals: [{ kind: 'recency', weight: 1, field: 'indexedAt', halfLifeHours: 24 }] },
    'relevant-fresh': {
      signals: [
        { kind: 'relevance', weight: 1 },
        { kind: 'recency', weight: 0.5, field: 'indexedAt', halfLifeHours: 24 },
      ],
    },
    engaged: {
      signals: [
        {
          kind: 'interactions',
          weight: 2,
          transform: 'log1p',
          links: [{ collection: 'site.standard.graph.recommend', path: 'document', weight: 1 }],
        },
        { kind: 'recency', weight: 1, field: 'indexedAt', halfLifeHours: 24 },
      ],
    },
  },
}

let tidCounter = 0

/** Monotonic fake TID — later calls sort lexicographically later, like real revs. */
export function nextRev(): string {
  tidCounter += 1
  return `3zzz${tidCounter.toString(36).padStart(9, '0')}`
}

export function makeEvent(overrides: Partial<RecordEvent> = {}): RecordEvent {
  return {
    type: 'record',
    did: 'did:plc:alice123',
    collection: 'site.standard.document',
    rkey: 'doc-1',
    action: 'create',
    record: { $type: 'site.standard.document', title: 'Hello Atmosphere', textContent: 'A document about atproto.' },
    cid: `cid-${tidCounter}-${Math.floor(Math.random() * 1e9)}`,
    rev: nextRev(),
    live: false,
    ...overrides,
  }
}
