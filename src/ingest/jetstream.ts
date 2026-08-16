import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import type { ComponentStatus } from '../health'
import { logger } from '../log'
import { BatchApplier, type BatchApplierDeps, type BatchApplierOptions } from './batch-applier'
import { loadCursor, saveCursor } from './cursor'
import type { IngestDriver } from './driver'
import type { RecordEvent } from './upsert'

const log = logger('jetstream')

const SOURCE = 'jetstream'
const SUBSCRIBE_PATH = '/xrpc/network.bsky.jetstream.subscribeEvents'

export interface JetstreamOptions extends BatchApplierOptions {
  /** Instance base, e.g. wss://jetstream.us-west.bsky.network */
  url: string
  /**
   * NSIDs or wildcards (`site.standard.*`), max 100. Empty subscribes to every
   * collection, which is the whole network — deliberate opt-in, never a default.
   */
  collections?: string[]
  maxReconnectMs?: number
}

/**
 * Consumes Jetstream v2 and applies events through the shared BatchApplier.
 *
 * Unlike Tab there is no ack channel: durability comes from persisting the
 * last committed `seq` in the same transaction as the batch it describes, so
 * the cursor can never lead the data. Jetstream cursors are inclusive, so the
 * resumed event is redelivered and absorbed by the idempotent upsert.
 *
 * The trade against Tab is the replay window: Tab redelivers unacked events
 * indefinitely, whereas a Jetstream outage longer than the instance's retention
 * leaves a gap that only a per-DID backfill can repair.
 */
export class JetstreamIngester implements IngestDriver {
  private readonly maxReconnectMs: number
  private readonly applier: BatchApplier<number>

  private ws: WebSocket | null = null
  private stopped = false
  private reconnectAttempt = 0
  /** Last durable seq. Drives reconnects, so it must reflect commits, not receipts. */
  private cursor: number | null = null
  private readonly kinds = { commit: 0, identity: 0, account: 0, sync: 0, unknown: 0 }

  constructor(
    private readonly db: Db,
    config: ObeliskConfig,
    private readonly options: JetstreamOptions,
    deps: BatchApplierDeps = {},
  ) {
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000
    this.applier = new BatchApplier<number>(
      db,
      config,
      {
        inTransaction: async (tx, seqs) => {
          const highest = Math.max(...seqs)
          await saveCursor(tx, SOURCE, highest)
          this.cursor = highest
        },
      },
      deps,
      options,
    )
  }

  start(): void {
    if (!this.options.collections?.length) {
      log.warn('no collections configured; subscribing to every collection on the network')
    }
    void this.resume()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ws?.close()
    await this.applier.stop()
  }

  /**
   * `up` when connected, `degraded` while reconnecting (the archive still
   * serves; live ingest is paused), `down` once stopped.
   */
  status(): ComponentStatus {
    const connected = this.ws?.readyState === WebSocket.OPEN
    return {
      status: this.stopped ? 'down' : connected ? 'up' : 'degraded',
      source: SOURCE,
      connected,
      applied: this.applier.stats.applied,
      skipped: this.applier.stats.skipped,
      pending: this.applier.pendingCount,
      reconnectAttempt: this.reconnectAttempt,
      cursor: this.cursor,
      kinds: { ...this.kinds },
    }
  }

  /** Load the stored position once, then connect. */
  private async resume(): Promise<void> {
    try {
      this.cursor = await loadCursor(this.db, SOURCE)
    } catch (err) {
      // Starting from live on a DB hiccup would silently skip the backlog, so
      // fail loudly rather than quietly losing the gap.
      log.error('could not read stored cursor; refusing to start from live', { err })
      throw err
    }
    log.info('resuming', { cursor: this.cursor })
    this.connect()
  }

  private buildUrl(): string {
    const url = new URL(SUBSCRIBE_PATH, this.options.url)
    for (const collection of this.options.collections ?? []) {
      url.searchParams.append('collections', collection)
    }
    // Record events only; identity/account/sync are counted but not archived.
    url.searchParams.append('kinds', 'commit')
    if (this.cursor !== null) url.searchParams.set('cursor', String(this.cursor))
    return url.toString()
  }

  private connect(): void {
    if (this.stopped) return

    // Rebuilt per attempt so a reconnect resumes from the newest committed
    // cursor rather than the one we booted with.
    const url = this.buildUrl()
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
      setTimeout(() => this.connect(), delay)
    }

    ws.onerror = (err) => log.error('socket error', { err })
  }

  private handleMessage(data: string): void {
    let envelope: JetstreamEnvelope
    try {
      envelope = JSON.parse(data) as JetstreamEnvelope
    } catch (err) {
      log.error('unparseable message', { err })
      return
    }

    const payload = envelope.payload
    if (!payload) return

    const kind = kindOf(payload.$type)
    this.kinds[kind] += 1
    if (kind !== 'commit') return

    const event = normalizeEvent(payload)
    if (!event || typeof payload.seq !== 'number') {
      log.warn('commit missing required fields', { seq: payload.seq, did: payload.did })
      return
    }

    this.applier.push(event, payload.seq)
  }

}

type Kind = 'commit' | 'identity' | 'account' | 'sync' | 'unknown'

/** Payload `$type` is `network.bsky.jetstream.subscribeEvents#commit` etc. */
function kindOf(type: string | undefined): Kind {
  const fragment = type?.split('#')[1]
  if (fragment === 'commit' || fragment === 'identity' || fragment === 'account' || fragment === 'sync') {
    return fragment
  }
  return 'unknown'
}

interface JetstreamEnvelope {
  $type?: string
  payload?: JetstreamPayload
}

interface JetstreamPayload {
  $type?: string
  did?: string
  seq?: number
  time?: string
  operation?: string
  collection?: string
  rkey?: string
  rev?: string
  cid?: string
  record?: Record<string, unknown>
}

/** null when the payload lacks the fields an archive row needs. */
export function normalizeEvent(payload: JetstreamPayload): RecordEvent | null {
  const { did, collection, rkey, operation } = payload
  if (!did || !collection || !rkey) return null
  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') return null

  return {
    type: 'record',
    did,
    collection,
    rkey,
    action: operation,
    // Deletes carry neither record nor cid.
    record: payload.record ?? null,
    cid: payload.cid ?? null,
    rev: payload.rev ?? null,
    live: true,
  }
}
