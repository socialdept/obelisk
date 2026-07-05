import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lexiconSchemas } from '../db/schema'
import { resolveLexicon, type ResolverDeps } from './resolver'

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const ERROR_RETRY_MS = 60 * 60 * 1000

export interface LexiconEntry {
  nsid: string
  schema: unknown | null
  error: string | null
  resolvedAt: Date
}

/**
 * Lazy, cached lexicon lookup. Successful resolutions are good for a day;
 * failures (unpublished lexicons are normal) retry hourly at most.
 */
export class LexiconRegistry {
  constructor(
    private readonly db: Db,
    private readonly resolverDeps?: ResolverDeps,
  ) {}

  async get(nsid: string): Promise<LexiconEntry> {
    const cached = await this.db
      .select()
      .from(lexiconSchemas)
      .where(eq(lexiconSchemas.nsid, nsid))
      .then((rows) => rows[0])

    if (cached && !this.isStale(cached)) {
      return { nsid, schema: cached.schema, error: cached.error, resolvedAt: cached.resolvedAt }
    }

    const entry = await this.resolve(nsid)
    await this.db
      .insert(lexiconSchemas)
      .values({ nsid, schema: entry.schema, error: entry.error, resolvedAt: entry.resolvedAt })
      .onConflictDoUpdate({
        target: lexiconSchemas.nsid,
        set: { schema: entry.schema, error: entry.error, resolvedAt: entry.resolvedAt },
      })
    return entry
  }

  private async resolve(nsid: string): Promise<LexiconEntry> {
    try {
      const schema = await resolveLexicon(nsid, this.resolverDeps)
      return { nsid, schema, error: null, resolvedAt: new Date() }
    } catch (err) {
      return { nsid, schema: null, error: err instanceof Error ? err.message : String(err), resolvedAt: new Date() }
    }
  }

  private isStale(row: { error: string | null; resolvedAt: Date }): boolean {
    const age = Date.now() - row.resolvedAt.getTime()
    return row.error ? age > ERROR_RETRY_MS : age > SUCCESS_TTL_MS
  }
}
