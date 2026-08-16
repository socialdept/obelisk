import type { ComponentStatus } from '../health'
import { logger } from '../log'
import type { Db } from './client'
import { pruneEvents } from './retention'

const log = logger('retention-worker')

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Periodic event-log trim. Off unless EVENTS_RETENTION_DAYS is set: deleting
 * history is not something an upgrade should start doing on its own.
 */
export class RetentionWorker {
  private stopped = false
  private loopPromise: Promise<void> | null = null
  private lastResult: { deleted: number; at: string } | null = null

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number,
    private readonly intervalMs = DAY_MS,
  ) {}

  start(): void {
    if (this.retentionDays <= 0) return
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loopPromise
  }

  status(): ComponentStatus {
    return {
      status: this.stopped ? 'down' : 'up',
      enabled: this.retentionDays > 0,
      retentionDays: this.retentionDays,
      lastRun: this.lastResult,
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick().catch((err) => log.error('prune failed', { err }))
      // Slept in slices so shutdown does not wait out a full day.
      for (let waited = 0; waited < this.intervalMs && !this.stopped; waited += 1000) {
        await Bun.sleep(1000)
      }
    }
  }

  async tick(): Promise<number> {
    const result = await pruneEvents(this.db, { retentionDays: this.retentionDays })
    this.lastResult = { deleted: result.deleted, at: new Date().toISOString() }
    return result.deleted
  }
}
