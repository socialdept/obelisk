import type { Env, ObeliskConfig } from '../config'
import type { ComponentStatus } from '../health'
import { OllamaClient } from './ollama'
import { OpenAIEmbeddingProvider } from './openai'

/**
 * Pluggable embedding backend (LAB-9). The archive is CPU-bound on a small box
 * because local Ollama inference saturates the single vCPU; swapping to an API
 * provider removes that load entirely (idle CPU, freed RAM, parallel throughput)
 * so a $6/1 GB box is comfortable. Ollama stays the default for local/offline use.
 *
 * A provider must emit vectors of exactly `dimensions` (the `record_embeddings`
 * column width) so both drivers write into the same table/index.
 */
export interface EmbeddingProvider {
  /** Embed one or more inputs; returns one vector per input, in input order. */
  embed(inputs: string[]): Promise<number[][]>
  /** Reachability probe for /readyz (degraded, not down — the archive still serves). */
  health(): Promise<ComponentStatus>
  /** Output vector dimension — must match the record_embeddings column. */
  readonly dimensions: number
  /** Short label for logs/metrics (e.g. "ollama", "openai"). */
  readonly name: string
}

/** Select the embedding driver from env (default: ollama). Validated in loadEnv. */
export function createEmbeddingProvider(env: Env, config: ObeliskConfig): EmbeddingProvider {
  const dimensions = config.ollama.dimensions
  if (env.embedding.provider === 'openai') {
    return new OpenAIEmbeddingProvider({
      apiKey: env.embedding.openaiApiKey!, // presence enforced by loadEnv
      model: env.embedding.openaiModel,
      baseUrl: env.embedding.openaiBaseUrl,
      dimensions,
    })
  }
  return new OllamaClient(env.ollamaUrl, config.ollama.model, dimensions)
}
