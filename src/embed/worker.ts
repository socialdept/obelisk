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
import type { OllamaClient } from './ollama'

const MAX_ATTEMPTS = 3
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

  constructor(
    private readonly db: Db,
    private readonly config: ObeliskConfig,
    private readonly ollama: OllamaClient,
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

  /** Health snapshot (LAB-54): `down` once stopped, else `up`. */
  status(): ComponentStatus {
    return { status: this.stopped ? 'down' : 'up', lastError: this.lastError }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const processed = await this.tick().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        log.error('tick failed', { err })
        return 0
      })
      if (processed === 0) await Bun.sleep(this.idleMs)
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

    for (const { id } of claimed) {
      await this.embedRecord(id)
    }
    return claimed.length
  }

  private async embedRecord(recordId: number): Promise<void> {
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
    if (!row) return

    if (row.deletedAt) {
      await this.setStatus(recordId, 'skipped')
      return
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
      return
    }

    const chunks = chunkText(text, this.config.ollama)

    try {
      const vectors = await this.ollama.embed(chunks)

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
    } catch (err) {
      const attempts = row.attempts + 1
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      log.error('record embed failed', { recordId, attempts, err })
      await this.db
        .update(records)
        .set({ embedStatus: status, embedAttempts: attempts })
        .where(eq(records.id, recordId))
      if (status === 'pending') await Bun.sleep(1000)
    }
  }

  private setStatus(recordId: number, status: string): Promise<unknown> {
    return this.db.update(records).set({ embedStatus: status }).where(eq(records.id, recordId))
  }
}
