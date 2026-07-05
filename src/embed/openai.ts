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

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: inputs, dimensions: this.dimensions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`openai embed failed: ${response.status} ${await response.text()}`)
    }

    const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] }
    if (!Array.isArray(body.data) || body.data.length !== inputs.length) {
      throw new Error(`openai returned ${body.data?.length ?? 0} embeddings for ${inputs.length} inputs`)
    }

    // The API may return items out of order — sort by `index` to realign with inputs.
    return body.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding)
  }

  async health(): Promise<ComponentStatus> {
    try {
      // GET /models is a cheap, no-cost auth+reachability probe.
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(4000),
      })
      return res.ok ? { status: 'up' } : { status: 'degraded', code: res.status }
    } catch (err) {
      return { status: 'degraded', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
