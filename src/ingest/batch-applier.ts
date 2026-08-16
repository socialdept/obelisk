import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { logger } from '../log'
import type { Blocklist } from './blocklist'
import type { ColdList, ColdPdsList } from './cold'
import type { PdsBlocklist } from './pds-blocklist'
import { applyEvent, type RecordEvent } from './upsert'

const log = logger('batch-applier')

/** A transaction handle, or the pool when applying outside one. */
export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface BatchApplierOptions {
  batchSize?: number
  flushMs?: number
}

/** Shared deny/cold lists. Absent lists mean "nothing is blocked or cold". */
export interface BatchApplierDeps {
  blocklist?: Blocklist
  pdsBlocklist?: PdsBlocklist
  coldList?: ColdList
  coldPdsList?: ColdPdsList
}

/**
 * How a transport records that a batch is durable. Transports differ only here:
 * Tab acks each event id after the commit, Jetstream persists a cursor and must
 * do so *inside* the transaction so the position cannot outrun the data.
 */
export interface BatchHooks<TMeta> {
  /** Runs inside the batch transaction, after every event is applied. */
  inTransaction?: (tx: Tx, metas: TMeta[]) => Promise<void>
  /** Runs after the transaction commits. Best-effort; must not throw. */
  afterCommit?: (metas: TMeta[]) => void
}

/**
 * Micro-batches record events into transactions, with the deny/cold lists
 * pre-resolved per batch and an unbounded commit retry.
 *
 * Extracted from the Tab ingester so the Jetstream driver reuses it verbatim:
 * the batching, the blocklist pre-resolution, and the retry are the subtle
 * parts, and two copies of them would drift.
 */
export class BatchApplier<TMeta> {
  private readonly batchSize: number
  private readonly flushMs: number

  private pending: { event: RecordEvent; meta: TMeta }[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  private stopped = false

  readonly stats = { applied: 0, skipped: 0, lastLogged: 0 }

  constructor(
    private readonly db: Db,
    private readonly config: ObeliskConfig,
    private readonly hooks: BatchHooks<TMeta> = {},
    private readonly deps: BatchApplierDeps = {},
    options: BatchApplierOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 200
    this.flushMs = options.flushMs ?? 500
  }

  get pendingCount(): number {
    return this.pending.length
  }

  /** Buffer an event, flushing once the batch is full or the timer fires. */
  push(event: RecordEvent, meta: TMeta): void {
    this.pending.push({ event, meta })

    if (this.pending.length >= this.batchSize) {
      this.triggerFlush()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.triggerFlush(), this.flushMs)
    }
  }

  /**
   * Finish the in-flight batch only. Anything still buffered is left for the
   * transport to recover (Tab redelivers unacked, Jetstream resumes from the
   * cursor) — draining a deep backlog here would block shutdown.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushPromise
  }

  triggerFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushPromise) return

    this.flushPromise = this.flush().finally(() => {
      this.flushPromise = null
      if (this.pending.length >= this.batchSize && !this.stopped) this.triggerFlush()
    })
  }

  private async flush(): Promise<void> {
    while (this.pending.length > 0 && !this.stopped) {
      const batch = this.pending.splice(0, this.batchSize)
      await this.commitWithRetry(batch)
      this.hooks.afterCommit?.(batch.map((b) => b.meta))
      this.logProgress()
    }
  }

  private async commitWithRetry(batch: { event: RecordEvent; meta: TMeta }[]): Promise<void> {
    // Pre-resolve the batch's DIDs against the PDS deny-list (network) OUTSIDE the
    // transaction, so the per-event skip check stays synchronous. No-op when no
    // PDS patterns are configured.
    const batchDids = new Set(batch.map((b) => b.event.did))
    await this.deps.pdsBlocklist?.ensureDecided(batchDids)
    await this.deps.coldPdsList?.ensureDecided(batchDids)

    const skipDid = (did: string) =>
      (this.deps.blocklist?.has(did) ?? false) || (this.deps.pdsBlocklist?.isBlocked(did) ?? false)
    const coldDid = (did: string) =>
      (this.deps.coldList?.has(did) ?? false) || (this.deps.coldPdsList?.isCold(did) ?? false)

    let attempt = 0
    for (;;) {
      try {
        await this.db.transaction(async (tx) => {
          for (const { event } of batch) {
            const result = await applyEvent(tx, this.config, event, { skipDid, coldDid })
            if (result === 'applied') this.stats.applied += 1
            else this.stats.skipped += 1
          }
          await this.hooks.inTransaction?.(
            tx,
            batch.map((b) => b.meta),
          )
        })
        return
      } catch (err) {
        attempt += 1
        const delay = Math.min(1000 * 2 ** attempt, 30_000)
        log.error('batch commit failed, retrying', { attempt, delayMs: delay, err })
        await Bun.sleep(delay)
      }
    }
  }

  private logProgress(): void {
    const total = this.stats.applied + this.stats.skipped
    if (total - this.stats.lastLogged < 1000) return
    this.stats.lastLogged = total
    log.info('progress', { applied: this.stats.applied, skipped: this.stats.skipped })
  }
}
