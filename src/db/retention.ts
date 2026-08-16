import { sql } from 'drizzle-orm'
import { logger } from '../log'
import type { Db } from './client'

const log = logger('retention')

export interface PruneEventsOptions {
  /** Events younger than this are always kept, whatever the cursors say. */
  retentionDays: number
  /** Count what would go without deleting it. */
  dryRun?: boolean
  /** Rows per statement, so a large backlog never becomes one huge lock. */
  batchSize?: number
}

export interface PruneEventsResult {
  /** Rows matching the policy, deleted or not. */
  eligible: number
  deleted: number
  /** Highest id the policy allows removing, or null when nothing qualifies. */
  cutoffId: number | null
  /** The furthest-behind subscription, which is what bounds the cutoff. */
  heldBy: { name: string; cursor: number } | null
}

/**
 * Trims the delivered tail of the event log.
 *
 * OFF by default and meant to stay off on an archive. The log backs getEvents,
 * which is queryable by since/until/collection/did/action, so it is history in
 * its own right rather than a delivery buffer — it also holds the trail of
 * records later updated or deleted, and bounds how far rewindWebhook can go.
 * This exists for deployments using Obelisk as a pure delivery relay, where the
 * log is transient and unbounded growth is unwanted.
 *
 * A row is removable only when BOTH hold:
 *
 *   1. every webhook subscription has already been delivered past it, and
 *   2. it is older than `retentionDays`.
 *
 * The cursor check alone is not enough. `getEvents` pull consumers keep their
 * cursors in their own database, so Obelisk cannot see how far behind they are;
 * the age floor is what protects them. The status of a subscription is
 * deliberately ignored — a paused or failing one must still be able to resume
 * from where it stopped, which is the guarantee the webhook worker advertises.
 */
export async function pruneEvents(db: Db, options: PruneEventsOptions): Promise<PruneEventsResult> {
  const { retentionDays, dryRun = false, batchSize = 10_000 } = options
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`retentionDays must be a positive number, got: ${retentionDays}`)
  }

  const slowest = (await db.execute(
    sql`SELECT name, cursor FROM webhook_subscriptions ORDER BY cursor ASC LIMIT 1`,
  )) as unknown as { name: string; cursor: string | number }[]

  const heldBy = slowest[0] ? { name: slowest[0].name, cursor: Number(slowest[0].cursor) } : null
  // No subscriptions at all means no cursor to respect; the age floor is then
  // the only guard, which is why it is not optional.
  const cursorLimit = heldBy?.cursor ?? null

  const eligibleWhere = sql`created_at < now() - make_interval(days => ${retentionDays})
    ${cursorLimit === null ? sql`` : sql`AND id <= ${cursorLimit}`}`

  const summary = (await db.execute(
    sql`SELECT count(*)::bigint AS eligible, max(id) AS cutoff FROM events WHERE ${eligibleWhere}`,
  )) as unknown as { eligible: string | number; cutoff: string | number | null }[]

  const eligible = Number(summary[0]?.eligible ?? 0)
  const cutoffId = summary[0]?.cutoff === null || summary[0]?.cutoff === undefined ? null : Number(summary[0].cutoff)

  if (dryRun || eligible === 0) {
    log.info(dryRun ? 'dry run' : 'nothing to prune', { eligible, cutoffId, heldBy })
    return { eligible, deleted: 0, cutoffId, heldBy }
  }

  let deleted = 0
  for (;;) {
    const result = (await db.execute(
      sql`DELETE FROM events WHERE id IN (
            SELECT id FROM events WHERE ${eligibleWhere} ORDER BY id LIMIT ${batchSize}
          )`,
    )) as unknown as { count?: number }

    const removed = Number(result?.count ?? 0)
    deleted += removed
    if (removed < batchSize) break
  }

  log.info('pruned event log', { deleted, cutoffId, heldBy, retentionDays })
  return { eligible, deleted, cutoffId, heldBy }
}
