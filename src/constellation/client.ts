import { eq } from 'drizzle-orm'
import type { ReservoirConfig } from '../config'
import type { Db } from '../db/client'
import { constellationCache } from '../db/schema'

export type ConstellationEndpoint = 'links' | 'links/count' | 'links/all/count'

export interface ConstellationParams {
  target: string
  collection?: string
  path?: string
  cursor?: string
}

export interface ConstellationResult {
  data: unknown
  cached: boolean
  stale: boolean
  fetchedAt: Date
}

/**
 * Cached client for microcosm.blue's Constellation backlink index.
 * Responses are cached for config.constellation.ttlSeconds; on upstream
 * failure a stale cache row is served rather than erroring.
 */
export class ConstellationClient {
  constructor(
    private readonly db: Db,
    private readonly config: ReservoirConfig['constellation'],
  ) {}

  async query(endpoint: ConstellationEndpoint, params: ConstellationParams): Promise<ConstellationResult> {
    const cacheKey = await this.cacheKey(endpoint, params)
    const cached = await this.db
      .select()
      .from(constellationCache)
      .where(eq(constellationCache.cacheKey, cacheKey))
      .then((rows) => rows[0])

    const fresh = cached && Date.now() - cached.fetchedAt.getTime() < this.config.ttlSeconds * 1000
    if (cached && fresh) {
      return { data: cached.response, cached: true, stale: false, fetchedAt: cached.fetchedAt }
    }

    try {
      const data = await this.fetchUpstream(endpoint, params)
      const fetchedAt = new Date()
      await this.db
        .insert(constellationCache)
        .values({
          cacheKey,
          endpoint,
          target: params.target,
          collection: params.collection,
          path: params.path,
          response: data,
          fetchedAt,
        })
        .onConflictDoUpdate({
          target: constellationCache.cacheKey,
          set: { response: data, fetchedAt },
        })
      return { data, cached: false, stale: false, fetchedAt }
    } catch (err) {
      if (!cached) throw err
      return { data: cached.response, cached: true, stale: true, fetchedAt: cached.fetchedAt }
    }
  }

  private async fetchUpstream(endpoint: ConstellationEndpoint, params: ConstellationParams): Promise<unknown> {
    const url = new URL(`/${endpoint}`, this.config.baseUrl)
    url.searchParams.set('target', params.target)
    if (params.collection) url.searchParams.set('collection', params.collection)
    if (params.path) url.searchParams.set('path', params.path)
    if (params.cursor) url.searchParams.set('cursor', params.cursor)

    const response = await fetch(url, { headers: { 'User-Agent': this.config.userAgent } })
    if (!response.ok) {
      throw new Error(`constellation ${endpoint} failed: ${response.status} ${await response.text()}`)
    }

    const text = await response.text()
    // /links/count returns a bare number as plain text; everything else is JSON.
    try {
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === 'number' ? { count: parsed } : parsed
    } catch {
      return { count: Number(text) }
    }
  }

  private async cacheKey(endpoint: string, params: ConstellationParams): Promise<string> {
    const canonical = JSON.stringify([endpoint, params.target, params.collection ?? '', params.path ?? '', params.cursor ?? ''])
    return new Bun.CryptoHasher('sha256').update(canonical).digest('hex')
  }
}
