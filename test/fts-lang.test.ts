import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import { hashToken } from '../src/api/auth'
import type { Db } from '../src/db/client'
import { apiTokens, records } from '../src/db/schema'
import type { OllamaClient } from '../src/embed/ollama'
import { detectLanguage } from '../src/ingest/lang'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>
let app: Hono

const TOKEN = 'rsv_test_token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const NS = 'site.standard.document'

/** Archive a doc, then set lang + extracted text (what FTS is built from). */
async function seedLang(rkey: string, lang: string | null, text: string): Promise<void> {
  await applyEvent(db, testConfig, makeEvent({ rkey, record: { title: 'Doc' } }))
  await db.execute(
    sql`UPDATE records SET lang = ${lang}, extracted_title = '', extracted_text = ${text} WHERE rkey = ${rkey}`,
  )
}

async function searchableOf(rkey: string): Promise<string> {
  const rows = await db.execute<{ s: string }>(sql`SELECT searchable::text AS s FROM records WHERE rkey = ${rkey}`)
  return rows[0]!.s
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

describe('detectLanguage', () => {
  test('reads langs / lang, normalizes, null when absent', () => {
    expect(detectLanguage({ langs: ['ES'] })).toBe('es')
    expect(detectLanguage({ lang: 'pt-BR' })).toBe('pt')
    expect(detectLanguage({ title: 'x' })).toBeNull()
    expect(detectLanguage(null)).toBeNull()
  })
})

describe('per-language FTS tokenization', () => {
  test('null lang → english default (stems), existing behavior preserved', async () => {
    await seedLang('a', null, 'running')
    expect(await searchableOf('a')).toContain("'run'") // english stem
  })

  test('explicit english stems', async () => {
    await seedLang('a', 'en', 'running')
    expect(await searchableOf('a')).toContain("'run'")
  })

  test('unknown language → simple (no mis-stemming)', async () => {
    await seedLang('a', 'xx', 'running')
    const s = await searchableOf('a')
    expect(s).toContain("'running'") // unstemmed
    expect(s).not.toContain("'run':")
  })

  test('spanish config stems spanish', async () => {
    await seedLang('a', 'es', 'corriendo')
    expect(await searchableOf('a')).toContain("'corr'")
  })
})

describe('lang storage + ingest detection', () => {
  test('ingest sets lang from the record langs field', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'a', record: { title: 'Doc', langs: ['fr'] } }))
    const row = await db.select({ lang: records.lang }).from(records).where(eq(records.rkey, 'a')).then((r) => r[0]!)
    expect(row.lang).toBe('fr')
  })

  test('lang is filterable via the where DSL', async () => {
    await seedLang('es-doc', 'es', 'hola')
    await seedLang('en-doc', 'en', 'hello')

    const res = await app.request(`/xrpc/${NS}.getRecords`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ where: { lang: { eq: 'es' } } }),
    })
    const body = (await res.json()) as { records: { uri: string }[] }
    expect(body.records).toHaveLength(1)
    expect(body.records[0]!.uri).toContain('/es-doc')
  })
})
