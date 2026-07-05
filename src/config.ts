import type { Limits } from './api/ratelimit'
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
  /** Identity resolution (LAB-48). Optional. */
  identity?: {
    /** TTL for the DID→PDS cache used by the PDS blocklist (default 86400 = 24h). */
    didPdsCacheTtlSeconds?: number
  }
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
    /** Upstream request timeout in ms (LAB-56). Default 8000. */
    timeoutMs?: number
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
  /** Interface the HTTP server binds. Default 0.0.0.0; set 127.0.0.1 for loopback-only. */
  host: string
  devMode: boolean
  /** API abuse guards (LAB-52). */
  limits: Limits
  /** Cancels a slow query at the DB (LAB-52). 0 = no timeout. */
  dbStatementTimeoutMs: number
  /** Embedding backend selection (LAB-9). */
  embedding: {
    provider: 'ollama' | 'openai'
    /** Required when provider is 'openai'. */
    openaiApiKey?: string
    openaiModel: string
    openaiBaseUrl: string
  }
}

/** Loopback interfaces — dev-mode (auth off) is only safe when bound to one of these. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])

/** Reject a URL env var that isn't a parseable absolute URL. */
function urlEnv(name: string, value: string): string {
  try {
    new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL, got: ${value}`)
  }
  return value
}

/** Parse an env var as a non-negative integer; `fallback` when unset/invalid. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got: ${raw}`)
  return n
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl?.trim()) throw new Error('DATABASE_URL is required')

  const host = process.env.OBELISK_HOST ?? '0.0.0.0'
  const devMode = process.env.OBELISK_DEV_MODE === 'true'

  const provider = process.env.EMBEDDING_PROVIDER ?? 'ollama'
  if (provider !== 'ollama' && provider !== 'openai') {
    throw new Error(`EMBEDDING_PROVIDER must be 'ollama' or 'openai', got: ${provider}`)
  }
  const openaiApiKey = process.env.OPENAI_API_KEY
  if (provider === 'openai' && !openaiApiKey?.trim()) {
    throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai')
  }

  // Fail-fast: dev-mode disables auth entirely, so refuse to boot with it on
  // while bound to a non-loopback interface (i.e. potentially reachable) unless
  // the operator explicitly acknowledges the risk. A public box with auth
  // silently off is the worst failure mode.
  if (devMode && !LOOPBACK_HOSTS.has(host) && process.env.OBELISK_ALLOW_INSECURE !== 'true') {
    throw new Error(
      `OBELISK_DEV_MODE is on (auth disabled) but the server binds ${host}, not loopback. ` +
        `Bind OBELISK_HOST=127.0.0.1, or set OBELISK_ALLOW_INSECURE=true to override.`,
    )
  }

  return {
    databaseUrl,
    tabWsUrl: urlEnv('TAB_WS_URL', process.env.TAB_WS_URL ?? 'ws://localhost:2480'),
    tabFootprintAdminUrl: process.env.TAB_FOOTPRINT_ADMIN_URL,
    ollamaUrl: urlEnv('OLLAMA_URL', process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'),
    port: intEnv('PORT', 6060),
    host,
    devMode,
    limits: {
      rateLimitPerMin: intEnv('OBELISK_RATE_LIMIT_PER_MIN', 120),
      rateLimitExpensivePerMin: intEnv('OBELISK_RATE_LIMIT_EXPENSIVE_PER_MIN', 30),
      maxBodyBytes: intEnv('OBELISK_MAX_BODY_BYTES', 1_048_576),
      requestTimeoutMs: intEnv('OBELISK_REQUEST_TIMEOUT_MS', 30_000),
      maxSseConnections: intEnv('OBELISK_MAX_SSE_CONNECTIONS', 5),
    },
    dbStatementTimeoutMs: intEnv('OBELISK_DB_STATEMENT_TIMEOUT_MS', 30_000),
    embedding: {
      provider,
      openaiApiKey,
      openaiModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      openaiBaseUrl: urlEnv('OPENAI_BASE_URL', process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'),
    },
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
