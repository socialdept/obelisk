export interface CollectionConfig {
  /** Record fields to extract for FTS weighting and embeddings. Omit for non-content collections. */
  textFields?: string[]
}

export interface ReservoirConfig {
  collections: Record<string, CollectionConfig>
  ollama: {
    model: string
    dimensions: number
    chunkChars: number
    chunkOverlap: number
  }
  constellation: {
    baseUrl: string
    ttlSeconds: number
    userAgent: string
  }
}

export interface Env {
  databaseUrl: string
  tabWsUrl: string
  ollamaUrl: string
  port: number
  devMode: boolean
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  return {
    databaseUrl,
    tabWsUrl: process.env.TAB_WS_URL ?? 'ws://localhost:2480',
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    port: Number(process.env.PORT ?? 3000),
    devMode: process.env.RESERVOIR_DEV_MODE === 'true',
  }
}

export async function loadConfig(): Promise<ReservoirConfig> {
  const { default: config } = await import('../reservoir.config')
  validateConfig(config)
  return config
}

function validateConfig(config: ReservoirConfig): void {
  if (Object.keys(config.collections).length === 0) {
    throw new Error('reservoir.config.ts must define at least one collection')
  }
  if (config.ollama.chunkOverlap >= config.ollama.chunkChars) {
    throw new Error('ollama.chunkOverlap must be smaller than ollama.chunkChars')
  }
  if (config.constellation.ttlSeconds < 0) {
    throw new Error('constellation.ttlSeconds must be >= 0')
  }
}
