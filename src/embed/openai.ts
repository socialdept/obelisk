import type { ComponentStatus } from '../health'
import type { EmbeddingProvider } from './provider'

export interface OpenAIOptions {
  apiKey: string
  model: string
  baseUrl: string
  /** Requested output dimension — `text-embedding-3-*` honor this, matching our column. */
  dimensions: number
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

/** Transient HTTP statuses worth a quick retry (rate limit / upstream blips). */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * OpenAI-compatible embeddings driver (LAB-9). Offloads inference off the box,
 * so a small VPS isn't CPU-bound on local Ollama. `dimensions` is passed through
 * — `text-embedding-3-small`/`-large` produce vectors of the requested width, so
 * the archive keeps its existing `vector(N)` column. Works against any
 * OpenAI-compatible endpoint via `baseUrl`.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai'
  readonly dimensions: number
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string

  constructor(opts: OpenAIOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.dimensions = opts.dimensions
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return []

    const body = JSON.stringify({ model: this.model, input: inputs, dimensions: this.dimensions })

    // Retry transient failures once (429 / 5xx / connection resets — common at
    // concurrency), so a blip re-tries in place instead of bouncing the record
    // back to the queue.
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        if (!response.ok) {
          const text = await response.text()
          if (attempt < MAX_ATTEMPTS - 1 && isTransient(response.status)) {
            await Bun.sleep(RETRY_DELAY_MS)
            continue
          }
          throw new Error(`openai embed failed: ${response.status} ${text}`)
        }

        const parsed = (await response.json()) as { data?: { index: number; embedding: number[] }[] }
        if (!Array.isArray(parsed.data) || parsed.data.length !== inputs.length) {
          throw new Error(`openai returned ${parsed.data?.length ?? 0} embeddings for ${inputs.length} inputs`)
        }
        // The API may return items out of order — sort by `index` to realign with inputs.
        return parsed.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding)
      } catch (err) {
        // Network-level errors (reset/timeout) — retry once, then give up.
        lastError = err
        if (attempt < MAX_ATTEMPTS - 1 && !(err instanceof Error && err.message.startsWith('openai embed failed'))) {
          await Bun.sleep(RETRY_DELAY_MS)
          continue
        }
        throw err
      }
    }
    throw lastError
  }

  async health(): Promise<ComponentStatus> {
    try {
      // GET /models is a cheap, no-cost auth+reachability probe.
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(4000),
      })
      return res.ok
        ? { status: 'up', provider: this.name, model: this.model }
        : { status: 'degraded', provider: this.name, code: res.status }
    } catch (err) {
      return { status: 'degraded', provider: this.name, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
