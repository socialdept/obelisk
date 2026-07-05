import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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
const NS = 'social.dept.obelisk'

interface Frame {
  event: string
  id?: string
  data: string
}

function sub(qs: string): Promise<Response> {
  return Promise.resolve(app.request(`/xrpc/${NS}.subscribeEvents?${qs}`, { headers: AUTH }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Read SSE frames off a streaming response until `stop(frames)` is satisfied or
 * the timeout elapses, then cancel the stream (which aborts the server loop).
 */
async function readUntil(res: Response, stop: (frames: Frame[]) => boolean, timeoutMs = 3000): Promise<Frame[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (!stop(frames) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const event = /^event: (.+)$/m.exec(raw)?.[1] ?? 'message'
        const data = /^data: ?(.*)$/m.exec(raw)?.[1] ?? ''
        const id = /^id: (.+)$/m.exec(raw)?.[1]
        frames.push({ event, id, data })
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return frames
}

const events = (frames: Frame[]) => frames.filter((f) => f.event === 'event')

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

describe(`${NS}.subscribeEvents`, () => {
  test('replays history from cursor 0, with id: cursors', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'a' }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'b' }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'c' }))

    const res = await sub('cursor=0&poll=40')
    const got = events(await readUntil(res, (f) => events(f).length >= 3))
    expect(got.map((f) => (JSON.parse(f.data) as { rkey: string }).rkey)).toEqual(['a', 'b', 'c'])
    expect(got[0]!.id).toBeDefined()
  })

  test('delivers a live event that arrives after connect', async () => {
    const res = await sub('cursor=0&poll=40')
    const reading = readUntil(res, (f) => events(f).length >= 1)
    await sleep(120) // let it connect + drain the (empty) backlog
    await applyEvent(db, testConfig, makeEvent({ rkey: 'live' }))

    const got = events(await reading)
    expect(got).toHaveLength(1)
    expect((JSON.parse(got[0]!.data) as { rkey: string }).rkey).toBe('live')
  })

  test('honors the collection filter', async () => {
    await applyEvent(db, testConfig, makeEvent({ rkey: 'doc', collection: 'site.standard.document' }))
    await applyEvent(db, testConfig, makeEvent({ rkey: 'sub', collection: 'site.standard.graph.subscription', record: { publication: 'at://x/y/z' } }))

    const res = await sub('cursor=0&poll=40&collection=site.standard.graph.subscription')
    // Wait for a ping (caught up) so we know the full backlog was scanned.
    const frames = await readUntil(res, (f) => f.some((x) => x.event === 'ping'))
    const got = events(frames)
    expect(got).toHaveLength(1)
    expect((JSON.parse(got[0]!.data) as { collection: string }).collection).toBe('site.standard.graph.subscription')
  })

  test('bad cursor → error frame, not a hang', async () => {
    const res = await sub('cursor=nope&poll=40')
    const frames = await readUntil(res, (f) => f.some((x) => x.event === 'error'))
    const err = frames.find((f) => f.event === 'error')!
    expect((JSON.parse(err.data) as { error: string }).error).toContain('cursor')
  })

  test('requires auth', async () => {
    const res = await app.request(`/xrpc/${NS}.subscribeEvents?cursor=0`)
    expect(res.status).toBe(401)
    await res.body?.cancel().catch(() => {})
  })
})
