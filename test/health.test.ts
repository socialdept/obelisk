import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createApp } from '../src/api/app'
import type { Db } from '../src/db/client'
import type { OllamaClient } from '../src/embed/ollama'
import { metricsText, readyReport, type HealthProviders } from '../src/health'
import { setupTestDb, testConfig } from './helpers'

let db: Db
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ db, teardown } = await setupTestDb())
})
afterAll(() => teardown())

const providers: HealthProviders = {
  ingester: () => ({ status: 'up', connected: true, applied: 5, skipped: 1, pending: 0 }),
  embedWorker: () => ({ status: 'up', embedFailures: 0, completed: 1234, skipped: 56, lastError: null }),
  webhookWorker: () => ({ status: 'up' }),
  embedder: () => ({ status: 'degraded', error: 'connection refused' }),
}

describe('readyReport', () => {
  test('db up + a degraded dependency → ready but flagged degraded', async () => {
    const report = await readyReport(db, providers)
    expect(report.components.db?.status).toBe('up')
    expect(report.components.embedder?.status).toBe('degraded')
    expect(report.ok).toBe(true) // degraded still serves
    expect(report.degraded).toBe(true)
    expect(report.components.embedQueue?.status).toBe('up')
  })

  test('a down critical dependency → not ready', async () => {
    const report = await readyReport(db, {
      ingester: () => ({ status: 'down' }),
    })
    expect(report.ok).toBe(false)
  })

  test('works with no providers (db only)', async () => {
    const report = await readyReport(db)
    expect(report.ok).toBe(true)
    expect(report.degraded).toBe(false)
  })
})

describe('metricsText', () => {
  test('emits Prometheus gauges from a report', async () => {
    const text = metricsText(await readyReport(db, providers))
    expect(text).toContain('obelisk_ready 1')
    expect(text).toContain('obelisk_degraded 1')
    expect(text).toContain('obelisk_db_up 1')
    expect(text).toContain('obelisk_ingester_connected 1')
    expect(text).toContain('obelisk_embedder_up 0')
    expect(text).toContain('obelisk_embeds_completed_total 1234')
    expect(text).toContain('obelisk_embeds_skipped_total 56')
    expect(text).toMatch(/# TYPE obelisk_embeds_completed_total counter/)
    expect(text).toMatch(/# TYPE obelisk_ready gauge/)
  })
})

describe('health endpoints', () => {
  let app: Hono
  beforeAll(() => {
    app = createApp({ db, config: testConfig, ollama: {} as OllamaClient, devMode: true, health: providers })
  })

  test('/healthz is always 200 when up', async () => {
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
  })

  test('/readyz returns the component report', async () => {
    const res = await app.request('/readyz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; components: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.components.db).toBeDefined()
  })

  test('/metrics serves Prometheus text (open in devMode)', async () => {
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
    expect(await res.text()).toContain('obelisk_ready')
  })
})
