import { createHmac } from 'node:crypto'
import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { audienceFilter, findAudience } from '../audiences/definition'
import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { events, records, webhookSubscriptions, type WebhookSubscription } from '../db/schema'
import { buildFeedFilter } from '../feeds/filter'
import { jsonMatcherFilters } from '../api/routes/records'

const MAX_BACKOFF_MS = 300_000
const FAILING_THRESHOLD = 100

export type FetchFn = typeof fetch

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/**
 * Delivers event-log batches to webhook subscriptions. Push mirror of the
 * pull API: per-subscription cursor, at-least-once, batched (full batch
 * immediately, partial batch at most once per max_wait_ms), HMAC-signed.
 * Failures back off exponentially; the cursor never advances on failure,
 * so nothing is lost — a subscription can be paused for a week and resume.
 */
export class WebhookWorker {
  private stopped = false
  private loopPromise: Promise<void> | null = null

  constructor(
    private readonly db: Db,
    private readonly config: ObeliskConfig,
    private readonly fetchFn: FetchFn = fetch,
    private readonly idleMs = 1000,
  ) {}

  start(): void {
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loopPromise
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick().catch((err) => console.error('webhook worker: tick failed', err))
      await Bun.sleep(this.idleMs)
    }
  }

  /** One pass over all due subscriptions. Returns delivered batch count. */
  async tick(): Promise<number> {
    const due = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.status, 'active'), lte(webhookSubscriptions.nextAttemptAt, new Date())))

    let delivered = 0
    for (const sub of due) {
      if (this.stopped) break
      if (await this.deliverOne(sub)) delivered += 1
    }
    return delivered
  }

  private async deliverOne(sub: WebhookSubscription): Promise<boolean> {
    const batch = await this.pendingBatch(sub)
    if (batch.length === 0) return false

    const full = batch.length >= sub.maxEvents
    const waitedLongEnough = Date.now() - (sub.lastDeliveryAt?.getTime() ?? 0) >= sub.maxWaitMs
    if (!full && !waitedLongEnough) return false

    const lastCursor = batch.at(-1)!.cursor
    const body = JSON.stringify({ subscription: sub.name, cursor: lastCursor, events: batch })

    const result = await this.post(sub, body, lastCursor)
    if (!result.ok) {
      await this.recordFailure(sub, `${result.detail} (${batch.length} events, ${body.length} bytes)`)
      return false
    }

    await this.db
      .update(webhookSubscriptions)
      .set({
        cursor: Number(lastCursor),
        failureCount: 0,
        lastDeliveryAt: new Date(),
        nextAttemptAt: new Date(),
      })
      .where(eq(webhookSubscriptions.id, sub.id))
    return true
  }

  private async pendingBatch(sub: WebhookSubscription) {
    const filters: SQL[] = [gt(events.id, sub.cursor)]
    if (sub.collections.length > 0) filters.push(inArray(events.collection, sub.collections))
    if (sub.actions.length > 0) filters.push(inArray(events.action, sub.actions))
    filters.push(...jsonMatcherFilters(sub.recordMatchers))

    if (sub.audience) {
      const audience = await findAudience(this.db, sub.audience)
      // Unknown audience = deliver nothing rather than everything.
      if (!audience) {
        console.error(`webhook worker: subscription "${sub.name}" references unknown audience "${sub.audience}"`)
        return []
      }
      filters.push(audienceFilter(sql`${events.did}`, audience.definition))
    }

    if (sub.feed) {
      const parsed = await buildFeedFilter(this.db, sub.feed, this.config, sql`${events.recordId}`)
      // Malformed feed = deliver nothing rather than everything.
      if ('error' in parsed) {
        console.error(`webhook worker: subscription "${sub.name}" has invalid feed "${sub.feed}": ${parsed.error}`)
        return []
      }
      filters.push(parsed.filter)
    }

    const rows = await this.db
      .select({ event: events, record: records })
      .from(events)
      .innerJoin(records, eq(records.id, events.recordId))
      .where(and(...filters))
      .orderBy(asc(events.id))
      .limit(sub.maxEvents)

    return rows.map(({ event, record }) => ({
      cursor: String(event.id),
      uri: record.uri,
      did: event.did,
      collection: event.collection,
      rkey: event.rkey,
      action: event.action,
      rev: event.rev,
      live: event.live,
      createdAt: event.createdAt,
      ...(sub.includeRecord && { record: event.action === 'delete' ? null : record.record }),
    }))
  }

  private async post(
    sub: WebhookSubscription,
    body: string,
    cursor: string,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.fetchFn(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Obelisk-Subscription': sub.name,
          'X-Obelisk-Cursor': cursor,
          'X-Obelisk-Signature': signBody(sub.secret, body),
        },
        body,
      })
      return { ok: response.ok, detail: `HTTP ${response.status}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  private async recordFailure(sub: WebhookSubscription, detail: string): Promise<void> {
    const failureCount = sub.failureCount + 1
    const backoff = Math.min(1000 * 2 ** failureCount, MAX_BACKOFF_MS)
    const status = failureCount >= FAILING_THRESHOLD ? 'failing' : sub.status

    console.error(`webhook worker: delivery to "${sub.name}" failed (${failureCount}): ${detail}, retry in ${backoff}ms`)
    await this.db
      .update(webhookSubscriptions)
      .set({ failureCount, status, nextAttemptAt: new Date(Date.now() + backoff) })
      .where(eq(webhookSubscriptions.id, sub.id))
  }
}

/** Starting cursor for new subscriptions: the log's current head (deliver only what happens next). */
export async function currentEventHead(db: Db): Promise<number> {
  const rows = await db.execute<{ max: number | null }>(sql`SELECT max(id) AS max FROM events`)
  return Number(rows[0]?.max ?? 0)
}
