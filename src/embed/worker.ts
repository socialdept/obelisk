import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { recordEmbeddings, records } from '../db/schema'
import { chunkText } from './chunk'
import { extractFields } from './extract'
import { extractRichText, type TextKeysResolver } from './rich'
import type { CollectionExtraction } from '../lexicon/collection'
import type { ComponentStatus } from '../health'
import { logger } from '../log'
import type { EmbeddingProvider } from './provider'

const MAX_ATTEMPTS = 3
const EMBED_BACKOFF_BASE_MS = 2000
const EMBED_BACKOFF_MAX_MS = 60_000
const log = logger('embed')

export type ExtractionResolver = (collection: string) => Promise<CollectionExtraction>

export interface EmbedWorkerOptions {
  claimSize?: number
  idleMs?: number
  /** Lexicon-driven text keys for rich content; falls back to defaults when absent. */
  textKeys?: TextKeysResolver
  /** Where each collection's prose lives (lexicon-derived + config overrides). */
  extraction?: ExtractionResolver
}

/**
 * In-process embedding worker: polls for pending records, embeds their text
 * via Ollama, and stores per-chunk vectors. Single-instance by design — the
 * SKIP LOCKED claim only guards concurrent ticks, not multiple processes.
 */
export class EmbedWorker {
  private readonly claimSize: number
  private readonly idleMs: number
  private readonly textKeys: TextKeysResolver
  private readonly extraction: ExtractionResolver
  private stopped = false
  private loopPromise: Promise<void> | null = null
  private lastError: string | null = null
  /** Consecutive Ollama-backend failures — drives backoff and the degraded signal. */
  private embedFailures = 0

  constructor(
    private readonly db: Db,
    private readonly config: ObeliskConfig,
    private readonly embedder: EmbeddingProvider,
    options: EmbedWorkerOptions = {},
  ) {
    this.claimSize = options.claimSize ?? 10
    this.idleMs = options.idleMs ?? 2000
    this.textKeys = options.textKeys ?? (async () => null)
    // Config-only fallback keeps the worker usable without a lexicon registry (tests).
    this.extraction =
      options.extraction ??
      (async (collection) => ({
        titleFields: this.config.collections[collection]?.titleFields ?? [],
        textFields: this.config.collections[collection]?.textFields ?? [],
        richContentFields:
          this.config.collections[collection]?.richContentFields ??
          (this.config.collections[collection]?.textFields ? ['content'] : []),
      }))
  }

  start(): void {
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loopPromise
  }

  /**
   * Health snapshot (LAB-54/56): the worker loop is `up` whenever it's running —
   * an Ollama outage is surfaced by the separate `ollama` component (degraded),
   * not here. `embedFailures` exposes how long it's been backing off.
   */
  status(): ComponentStatus {
    return { status: this.stopped ? 'down' : 'up', embedFailures: this.embedFailures, lastError: this.lastError }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const processed = await this.tick().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        log.error('tick failed', { err })
        return 0
      })

      // Ollama unreachable → exponential backoff so a down backend isn't hammered
      // and CPU isn't burned. Records stay `pending` and drain when it returns.
      if (this.embedFailures > 0) {
        const backoff = Math.min(EMBED_BACKOFF_BASE_MS * 2 ** (this.embedFailures - 1), EMBED_BACKOFF_MAX_MS)
        log.warn('embedding backend unreachable, backing off', { failures: this.embedFailures, backoffMs: backoff })
        await Bun.sleep(backoff)
      } else if (processed === 0) {
        await Bun.sleep(this.idleMs)
      }
    }
  }

  /** Claim and process one batch. Returns how many records were handled. */
  async tick(): Promise<number> {
    const claimed = await this.db.execute<{ id: number }>(sql`
      SELECT id FROM records
      WHERE embed_status = 'pending'
      ORDER BY id
      LIMIT ${this.claimSize}
      FOR UPDATE SKIP LOCKED
    `)
    if (claimed.length === 0) return 0

    // Embed the whole claimed batch concurrently. Sequential round-trips were the
    // throughput ceiling when draining a large backlog — especially via an API
    // provider, where each record is a network call. claimSize bounds the fan-out.
    const results = await Promise.all(claimed.map(({ id }) => this.embedRecord(id)))

    // Failure accounting once per tick (not per record) so a concurrent batch
    // doesn't over-count: a down backend bumps the backoff by one; a real embed
    // clears it.
    if (results.some((r) => r === 'backend-down')) this.embedFailures += 1
    else if (results.some((r) => r === 'ok')) this.embedFailures = 0

    return results.filter((r) => r !== 'backend-down').length
  }

  private async embedRecord(recordId: number): Promise<'ok' | 'skipped' | 'backend-down'> {
    const row = await this.db
      .select({
        id: records.id,
        collection: records.collection,
        record: records.record,
        deletedAt: records.deletedAt,
        attempts: records.embedAttempts,
      })
      .from(records)
      .where(eq(records.id, recordId))
      .then((rows) => rows[0])
    if (!row) return 'skipped'

    if (row.deletedAt) {
      await this.setStatus(recordId, 'skipped')
      return 'skipped'
    }

    const recordJson = row.record as Record<string, unknown>
    const extraction = await this.extraction(row.collection)

    const title = extractFields(recordJson, extraction.titleFields)
    const flat = extractFields(recordJson, extraction.textFields)
    const rich = await extractRichText(recordJson, this.textKeys, extraction.richContentFields)
    const body = [flat, rich].filter((part) => part !== '').join('\n\n')
    const text = [title, body].filter((part) => part !== '').join('\n\n')

    if (text === '') {
      await this.setStatus(recordId, 'skipped')
      return 'skipped'
    }

    const chunks = chunkText(text, this.config.ollama)

    // Embedding is the one call that can fail because the *backend* is down, as
    // opposed to a bad record. Keep it separate: a backend outage must NOT burn
    // the record's attempts (else an outage would permanently fail the archive).
    // Failure accounting (backoff) is done once per tick, not per record, so a
    // concurrent batch doesn't over-count.
    let vectors: number[][]
    try {
      vectors = await this.embedder.embed(chunks)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return 'backend-down' // record stays pending; drains when the backend returns
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(recordEmbeddings).where(eq(recordEmbeddings.recordId, recordId))
        await tx.insert(recordEmbeddings).values(
          chunks.map((chunk, i) => ({
            recordId,
            chunkIndex: i,
            chunkText: chunk,
            embedding: vectors[i]!,
          })),
        )
        await tx
          .update(records)
          .set({
            embedStatus: 'done',
            extractedTitle: title === '' ? null : title,
            extractedText: body === '' ? null : body,
          })
          .where(eq(records.id, recordId))
      })
      return 'ok'
    } catch (err) {
      // A genuine per-record failure (bad data / DB write) — count attempts.
      const attempts = row.attempts + 1
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      log.error('record embed failed', { recordId, attempts, err })
      await this.db
        .update(records)
        .set({ embedStatus: status, embedAttempts: attempts })
        .where(eq(records.id, recordId))
      if (status === 'pending') await Bun.sleep(1000)
      return 'ok'
    }
  }

  private setStatus(recordId: number, status: string): Promise<unknown> {
    return this.db.update(records).set({ embedStatus: status }).where(eq(records.id, recordId))
  }
}
