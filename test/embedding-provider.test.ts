import { afterEach, describe, expect, test } from 'bun:test'
import { loadEnv } from '../src/config'
import { OllamaClient } from '../src/embed/ollama'
import { OpenAIEmbeddingProvider } from '../src/embed/openai'
import { createEmbeddingProvider } from '../src/embed/provider'
import { testConfig } from './helpers'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stub global fetch with a handler returning a Response. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}

describe('OpenAIEmbeddingProvider', () => {
  const provider = new OpenAIEmbeddingProvider({
    apiKey: 'sk-test',
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    dimensions: 768,
  })

  test('name and dimensions', () => {
    expect(provider.name).toBe('openai')
    expect(provider.dimensions).toBe(768)
  })

  test('empty input short-circuits without a request', async () => {
    let called = false
    stubFetch(() => {
      called = true
      return new Response('{}')
    })
    expect(await provider.embed([])).toEqual([])
    expect(called).toBe(false)
  })

  test('requests the configured dimensions and realigns out-of-order results', async () => {
    let sentBody: Record<string, unknown> = {}
    stubFetch((url, init) => {
      sentBody = JSON.parse(String(init?.body))
      // Return items deliberately out of order to prove we sort by index.
      return new Response(
        JSON.stringify({ data: [
          { index: 1, embedding: [2, 2] },
          { index: 0, embedding: [1, 1] },
        ] }),
        { status: 200 },
      )
    })

    const vecs = await provider.embed(['first', 'second'])
    expect(vecs).toEqual([[1, 1], [2, 2]]) // reordered to match inputs
    expect(sentBody.dimensions).toBe(768)
    expect(sentBody.model).toBe('text-embedding-3-small')
  })

  test('throws on a non-2xx response', async () => {
    stubFetch(() => new Response('nope', { status: 401 }))
    await expect(provider.embed(['x'])).rejects.toThrow(/openai embed failed: 401/)
  })

  test('throws when the count does not match the inputs', async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 }))
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/returned 1 embeddings for 2 inputs/)
  })

  test('health probes /models', async () => {
    stubFetch((url) => new Response(url.endsWith('/models') ? '{}' : 'bad', { status: 200 }))
    expect((await provider.health()).status).toBe('up')

    stubFetch(() => new Response('down', { status: 503 }))
    expect((await provider.health()).status).toBe('degraded')
  })
})

describe('createEmbeddingProvider', () => {
  // Clear the dev-mode/host keys too — a local .env (bun auto-loads it) can set
  // OBELISK_DEV_MODE and trip loadEnv's non-loopback guard.
  const KEYS = ['EMBEDDING_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_EMBEDDING_MODEL', 'OBELISK_DEV_MODE', 'OBELISK_HOST']
  let saved: Record<string, string | undefined>

  function withEnv(overrides: Record<string, string>) {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    for (const k of KEYS) delete process.env[k]
    process.env.DATABASE_URL = 'postgres://obelisk:obelisk@localhost:5432/obelisk'
    Object.assign(process.env, overrides)
  }
  afterEach(() => {
    for (const k of KEYS) {
      if (saved?.[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test('defaults to the Ollama driver', () => {
    withEnv({})
    const p = createEmbeddingProvider(loadEnv(), testConfig)
    expect(p).toBeInstanceOf(OllamaClient)
    expect(p.name).toBe('ollama')
    expect(p.dimensions).toBe(testConfig.ollama.dimensions)
  })

  test('selects the OpenAI driver when configured', () => {
    withEnv({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' })
    const p = createEmbeddingProvider(loadEnv(), testConfig)
    expect(p).toBeInstanceOf(OpenAIEmbeddingProvider)
    expect(p.name).toBe('openai')
    expect(p.dimensions).toBe(testConfig.ollama.dimensions) // matches the column width
  })
})
