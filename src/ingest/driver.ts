import type { ComponentStatus } from '../health'

/**
 * A live ingest transport. Obelisk runs exactly one, chosen by INGEST_SOURCE.
 * Both drivers feed the same BatchApplier, so they differ only in where events
 * come from and how a durable batch is recorded.
 */
export interface IngestDriver {
  start(): void
  stop(): Promise<void>
  status(): ComponentStatus
}
