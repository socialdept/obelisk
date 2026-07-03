import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import type { ReservoirConfig } from '../config'
import type { Db } from '../db/client'
import { recordEmbeddings, records } from '../db/schema'
import { chunkText } from './chunk'
import { extractText } from './extract'
import { extractRichText, type TextKeysResolver } from './rich'
import type { OllamaClient } from './ollama'

const MAX_ATTEMPTS = 3

export interface EmbedWorkerOptions {
  claimSize?: number
  idleMs?: number
  /** Lexicon-driven text keys for rich content; falls back to defaults when absent. */
  textKeys?: TextKeysResolver
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
  private stopped = false
  private loopPromise: Promise<void> | null = null

  constructor(
    private readonly db: Db,
    private readonly config: ReservoirConfig,
    private readonly ollama: OllamaClient,
    options: EmbedWorkerOptions = {},
  ) {
    this.claimSize = options.claimSize ?? 10
    this.idleMs = options.idleMs ?? 2000
    this.textKeys = options.textKeys ?? (async () => null)
  }

  start(): void {
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loopPromise
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const processed = await this.tick().catch((err) => {
        console.error('embed worker: tick failed', err)
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
    const flat = extractText(this.config, row.collection, recordJson)
    const rich = await extractRichText(recordJson, this.textKeys)
    const text = [flat, rich].filter((part) => part !== '').join('\n\n')

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
          .set({ embedStatus: 'done', extractedText: rich === '' ? null : rich })
          .where(eq(records.id, recordId))
      })
    } catch (err) {
      const attempts = row.attempts + 1
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      console.error(`embed worker: record ${recordId} attempt ${attempts} failed`, err)
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
