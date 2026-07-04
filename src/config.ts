import { validateRankings, type RankingConfig } from './ranking/config'
import type { InteractionSourceConfig } from './ranking/source'

/**
 * Per-collection overrides. Everything here is OPTIONAL — when omitted, field
 * locations are derived from the collection's own published lexicon.
 */
export interface CollectionConfig {
  /** Heading-like fields (FTS weight A). */
  titleFields?: string[]
  /** Flat prose fields (FTS weight C + embeddings). */
  textFields?: string[]
  /** Fields holding rich/nested content (block trees, typed unions); prose extracted via lexicon-derived text keys. */
  richContentFields?: string[]
}

export interface ObeliskConfig {
  collections: Record<string, CollectionConfig>
  /** Named ranking profiles (LAB-37) consumed by search + feed skeleton. Optional. */
  rankings?: RankingConfig
  /** Where the `interactions` signal sources counts per collection (LAB-40). Optional. */
  interactionSources?: InteractionSourceConfig
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
  /** Semantics for feed=following:<did> — which records express "following" and via which link path. */
  feeds: {
    following: {
      collection: string
      path: string
    }
  }
}

export interface Env {
  databaseUrl: string
  tabWsUrl: string
  /** HTTP admin API of the footprint Tab (dynamic mode). Unset until LAB-29 lands. */
  tabFootprintAdminUrl?: string
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
    tabFootprintAdminUrl: process.env.TAB_FOOTPRINT_ADMIN_URL,
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    port: Number(process.env.PORT ?? 6060),
    devMode: process.env.OBELISK_DEV_MODE === 'true',
  }
}

export async function loadConfig(): Promise<ObeliskConfig> {
  const { default: config } = await import('../obelisk.config')
  validateConfig(config)
  return config
}

function validateConfig(config: ObeliskConfig): void {
  if (Object.keys(config.collections).length === 0) {
    throw new Error('obelisk.config.ts must define at least one collection')
  }
  if (config.ollama.chunkOverlap >= config.ollama.chunkChars) {
    throw new Error('ollama.chunkOverlap must be smaller than ollama.chunkChars')
  }
  if (config.constellation.ttlSeconds < 0) {
    throw new Error('constellation.ttlSeconds must be >= 0')
  }
  validateRankings(config.rankings)
}
