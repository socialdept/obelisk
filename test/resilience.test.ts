import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createApp } from '../src/api/app'
import type { Db } from '../src/db/client'
import type { OllamaClient } from '../src/embed/ollama'
import { EmbedWorker } from '../src/embed/worker'
import { applyEvent } from '../src/ingest/upsert'
import { makeEvent, setupTestDb, testConfig, truncateAll } from './helpers'

let db: Db
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ db, teardown } = await setupTestDb())
})
afterAll(() => teardown())
beforeEach(() => truncateAll(db))

async function status(id: number) {
  const rows = await db.execute<{ embed_status: string; embed_attempts: number }>(
    sql`SELECT embed_status, embed_attempts FROM records WHERE id = ${id}`,
  )
  return rows[0]!
}

describe('embed worker — Ollama outage', () => {
  test('leaves records pending (no burned attempts) and backs off, then drains when it returns', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:a', rkey: 'r1' }))
    const { id } = (await db.execute<{ id: number }>(sql`SELECT id FROM records LIMIT 1`))[0]!

    let down = true
    const ollama = {
      embed: async (inputs: string[]) => {
        if (down) throw new Error('ECONNREFUSED')
        return inputs.map(() => new Array(768).fill(0))
      },
    } as unknown as OllamaClient
    const worker = new EmbedWorker(db, testConfig, ollama)

    await worker.tick()
    let s = await status(id)
    expect(s.embed_status).toBe('pending') // still pending — drains later
    expect(s.embed_attempts).toBe(0) // outage must NOT burn attempts
    expect(worker.status().embedFailures).toBeGreaterThan(0)

    down = false
    await worker.tick()
    s = await status(id)
    expect(s.embed_status).toBe('done')
    expect(worker.status().embedFailures).toBe(0) // success clears backoff
  })
})

describe('embed worker — concurrency', () => {
  test('embeds a claimed batch concurrently in one tick', async () => {
    for (let i = 0; i < 6; i++) {
      await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:b', rkey: `c${i}` }))
    }

    let inFlight = 0
    let peak = 0
    const embedder = {
      embed: async (inputs: string[]) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight -= 1
        return inputs.map(() => new Array(768).fill(0))
      },
    } as unknown as OllamaClient
    const worker = new EmbedWorker(db, testConfig, embedder, { claimSize: 6 })

    const processed = await worker.tick()
    expect(processed).toBe(6)
    expect(peak).toBeGreaterThan(1) // ran in parallel, not one-at-a-time
    const done = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM records WHERE did = 'did:plc:b' AND embed_status = 'done'`,
    )
    expect(Number(done[0]!.n)).toBe(6)
  })

  test('an isolated failure in a batch does not stall the rest or trigger backoff', async () => {
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:d', rkey: 'ok1' }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:d', rkey: 'ok2' }))
    await applyEvent(db, testConfig, makeEvent({
      did: 'did:plc:d',
      rkey: 'boom',
      record: { $type: 'site.standard.document', title: 'BOOM', textContent: 'BOOM' },
    }))
    await applyEvent(db, testConfig, makeEvent({ did: 'did:plc:d', rkey: 'ok3' }))

    // One record's text blows up the backend; the rest embed fine.
    const embedder = {
      embed: async (inputs: string[]) => {
        if (inputs.some((c) => c.includes('BOOM'))) throw new Error('connection reset')
        return inputs.map(() => new Array(768).fill(0))
      },
    } as unknown as OllamaClient
    const worker = new EmbedWorker(db, testConfig, embedder, { claimSize: 10 })

    const processed = await worker.tick()
    expect(processed).toBe(3) // 3 embedded, 1 failed
    expect(worker.status().embedFailures).toBe(0) // no backoff — the batch mostly succeeded

    const rows = await db.execute<{ rkey: string; embed_status: string }>(
      sql`SELECT rkey, embed_status FROM records WHERE did = 'did:plc:d'`,
    )
    expect(rows.find((r) => r.rkey === 'boom')!.embed_status).toBe('pending') // stays queued for retry
    expect(rows.filter((r) => r.embed_status === 'done')).toHaveLength(3)
  })
})

describe('semantic search — Ollama down', () => {
  test('returns a clean 503, not a 500 stack trace', async () => {
    const ollama = {
      embed: async () => {
        throw new Error('ECONNREFUSED')
      },
    } as unknown as OllamaClient
    const app = createApp({ db, config: testConfig, ollama, devMode: true })

    const res = await app.request('/xrpc/site.standard.document.searchRecords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'atproto', semantic: true }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('ServiceUnavailable')
  })
})
