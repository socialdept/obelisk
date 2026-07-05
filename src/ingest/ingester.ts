import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import type { ComponentStatus } from '../health'
import { logger } from '../log'
import type { Blocklist } from './blocklist'
import type { PdsBlocklist } from './pds-blocklist'
import { applyEvent, type RecordEvent } from './upsert'

const log = logger('ingester')

export interface IngesterOptions {
  batchSize?: number
  flushMs?: number
  maxReconnectMs?: number
}

interface PendingEvent {
  event: RecordEvent
  eventId: number
}

/**
 * Consumes a Tab websocket (ws://host:2480/channel) with acks and applies
 * events in micro-batched transactions. Acks are sent only after the batch
 * commits, so a crash never loses events — Tab redelivers anything unacked
 * (TAB_RETRY_TIMEOUT) and the idempotent upsert absorbs duplicates.
 *
 * Uses Bun's native WebSocket: @atproto/tap's channel depends on ws streams
 * Bun doesn't implement. Wire protocol is plain JSON events in,
 * `{"type":"ack","id":n}` back.
 */
export class Ingester {
  private readonly batchSize: number
  private readonly flushMs: number
  private readonly maxReconnectMs: number

  private ws: WebSocket | null = null
  private pending: PendingEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  private stopped = false
  private reconnectAttempt = 0

  private stats = { applied: 0, skipped: 0, lastLogged: 0 }

  constructor(
    private readonly db: Db,
    private readonly config: ObeliskConfig,
    options: IngesterOptions = {},
    /** Shared deny-list (LAB-47); blocked DIDs' events are skipped at apply time. */
    private readonly blocklist?: Blocklist,
    /** Shared PDS deny-list (LAB-48); pre-resolved per batch, skipped at apply time. */
    private readonly pdsBlocklist?: PdsBlocklist,
  ) {
    this.batchSize = options.batchSize ?? 200
    this.flushMs = options.flushMs ?? 500
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000
  }

  start(tabWsUrl: string): void {
    const url = new URL(tabWsUrl)
    url.protocol = url.protocol === 'wss:' ? 'wss:' : 'ws:'
    url.pathname = '/channel'
    this.connect(url.toString())
  }

  /**
   * Fast shutdown: finish the in-flight batch only. Everything still buffered
   * stays unacked, so Tab redelivers it on next boot and the idempotent
   * upsert absorbs it — draining a large backlog here would block exit.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.ws?.close()
    await this.flushPromise
  }

  /**
   * Health snapshot (LAB-54). `up` when connected to Tab, `degraded` while
   * reconnecting (the archive still serves; live ingest is just paused),
   * `down` once stopped.
   */
  status(): ComponentStatus {
    const connected = this.ws?.readyState === WebSocket.OPEN
    return {
      status: this.stopped ? 'down' : connected ? 'up' : 'degraded',
      connected,
      applied: this.stats.applied,
      skipped: this.stats.skipped,
      pending: this.pending.length,
      reconnectAttempt: this.reconnectAttempt,
    }
  }

  private connect(url: string): void {
    if (this.stopped) return
    log.info('connecting', { url })

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      log.info('connected')
    }

    ws.onmessage = (msg) => this.handleMessage(String(msg.data))

    ws.onclose = () => {
      if (this.stopped) return
      this.reconnectAttempt += 1
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectMs)
      log.warn('disconnected, reconnecting', { delayMs: delay, attempt: this.reconnectAttempt })
      setTimeout(() => this.connect(url), delay)
    }

    ws.onerror = (err) => log.error('socket error', { err })
  }

  private handleMessage(data: string): void {
    let parsed: TapWireEvent
    try {
      parsed = JSON.parse(data) as TapWireEvent
    } catch (err) {
      log.error('unparseable message', { err })
      return
    }

    if (parsed.type !== 'record' || !parsed.record) {
      this.ack(parsed.id)
      return
    }

    this.pending.push({ event: normalizeEvent(parsed.record), eventId: parsed.id })

    if (this.pending.length >= this.batchSize) {
      this.triggerFlush()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.triggerFlush(), this.flushMs)
    }
  }

  private triggerFlush(): void {
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
      for (const { eventId } of batch) this.ack(eventId)
      this.logProgress()
    }
  }

  private async commitWithRetry(batch: PendingEvent[]): Promise<void> {
    // Pre-resolve the batch's DIDs against the PDS deny-list (network) OUTSIDE the
    // transaction, so the per-event skip check stays synchronous. No-op when no
    // PDS patterns are configured.
    await this.pdsBlocklist?.ensureDecided(new Set(batch.map((b) => b.event.did)))

    const skipDid = (did: string) =>
      (this.blocklist?.has(did) ?? false) || (this.pdsBlocklist?.isBlocked(did) ?? false)

    let attempt = 0
    for (;;) {
      try {
        await this.db.transaction(async (tx) => {
          for (const { event } of batch) {
            const result = await applyEvent(tx, this.config, event, { skipDid })
            if (result === 'applied') this.stats.applied += 1
            else this.stats.skipped += 1
          }
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

  /** Best-effort: if the socket is down, Tab redelivers and the upsert dedupes. */
  private ack(eventId: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'ack', id: eventId }))
  }

  private logProgress(): void {
    const total = this.stats.applied + this.stats.skipped
    if (total - this.stats.lastLogged < 1000) return
    this.stats.lastLogged = total
    log.info('progress', { applied: this.stats.applied, skipped: this.stats.skipped })
  }
}

interface TapWireEvent {
  id: number
  type: string
  record?: {
    did: string
    rev: string
    collection: string
    rkey: string
    action: 'create' | 'update' | 'delete'
    record?: Record<string, unknown>
    cid?: string
    live: boolean
  }
}

function normalizeEvent(data: NonNullable<TapWireEvent['record']>): RecordEvent {
  return {
    type: 'record',
    did: data.did,
    collection: data.collection,
    rkey: data.rkey,
    action: data.action,
    record: data.record ?? null,
    cid: data.cid ?? null,
    rev: data.rev ?? null,
    live: data.live,
  }
}
