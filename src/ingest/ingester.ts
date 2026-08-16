import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import type { ComponentStatus } from '../health'
import { logger } from '../log'
import { BatchApplier, type BatchApplierDeps, type BatchApplierOptions } from './batch-applier'
import type { IngestDriver } from './driver'
import type { RecordEvent } from './upsert'

const log = logger('ingester')

export interface IngesterOptions extends BatchApplierOptions {
  /** Tab channel base, e.g. ws://tab:2480. The /channel path is appended. */
  wsUrl: string
  maxReconnectMs?: number
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
export class Ingester implements IngestDriver {
  private readonly wsUrl: string
  private readonly maxReconnectMs: number
  private readonly applier: BatchApplier<number>

  private ws: WebSocket | null = null
  private stopped = false
  private reconnectAttempt = 0

  constructor(db: Db, config: ObeliskConfig, options: IngesterOptions, deps: BatchApplierDeps = {}) {
    this.wsUrl = options.wsUrl
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000
    this.applier = new BatchApplier<number>(
      db,
      config,
      // Ack only once the batch is durable; before that Tab must keep it.
      { afterCommit: (eventIds) => eventIds.forEach((id) => this.ack(id)) },
      deps,
      options,
    )
  }

  start(): void {
    const url = new URL(this.wsUrl)
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
    this.ws?.close()
    await this.applier.stop()
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
      source: 'tab',
      connected,
      applied: this.applier.stats.applied,
      skipped: this.applier.stats.skipped,
      pending: this.applier.pendingCount,
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

    this.applier.push(normalizeEvent(parsed.record), parsed.id)
  }

  /** Best-effort: if the socket is down, Tab redelivers and the upsert dedupes. */
  private ack(eventId: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'ack', id: eventId }))
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
