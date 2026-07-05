import type { ComponentStatus } from '../health'
import type { EmbeddingProvider } from './provider'

export class OllamaClient implements EmbeddingProvider {
  readonly name = 'ollama'

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    readonly dimensions: number = 768,
  ) {}

  /**
   * Reachability probe for /readyz (LAB-54). Ollama-down is `degraded`, not
   * `down`: semantic search is unavailable but the archive keeps serving and
   * embeddings drain once it returns. Short timeout so a hung backend can't
   * stall the readiness check.
   */
  async health(): Promise<ComponentStatus> {
    try {
      const res = await fetch(this.baseUrl, { signal: AbortSignal.timeout(2000) })
      return res.ok
        ? { status: 'up', provider: this.name, model: this.model }
        : { status: 'degraded', provider: this.name, code: res.status }
    } catch (err) {
      return { status: 'degraded', provider: this.name, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Embed one or more inputs in a single request. Returns one vector per input. */
  async embed(inputs: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: inputs }),
    })

    if (!response.ok) {
      throw new Error(`ollama embed failed: ${response.status} ${await response.text()}`)
    }

    const body = (await response.json()) as { embeddings: number[][] }
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length) {
      throw new Error(`ollama returned ${body.embeddings?.length ?? 0} embeddings for ${inputs.length} inputs`)
    }

    return body.embeddings
  }
}
