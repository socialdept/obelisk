import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'

const DEFAULT_WINDOW_SECONDS = 60
const MAX_WINDOW_SECONDS = 3600

export interface BackfillStatus {
  collection: string
  /** Live records (deleted excluded) archived for this collection. */
  recordsArchived: number
  /** Including soft-deleted — the archive keeps what the network dropped. */
  recordsIncludingDeleted: number
  /** Distinct DIDs we've received any event for in this collection. */
  reposSeen: number
  /**
   * Distinct DIDs we've seen a live (real-time) event for — i.e. their backfill
   * reached the live cutover. Undercounts repos with no post-backfill activity
   * (a quiet repo may never emit a live event), so it's a floor, not a total.
   */
  reposCaughtUp: number
  /**
   * Network-wide repo total for this collection. Always null: no atproto service
   * exposes a per-collection record/repo count, and Tab's tracked-repo count
   * isn't wired yet (needs the Tab metrics contract — deferred, see LAB-34).
   * Present so a true network `%` can slot in without a shape change.
   */
  reposTotal: number | null
  /** Historical (live:false) events ingested per second over the window — the backfill firehose rate. */
  backfillRatePerSec: number
  /** Live (live:true) events per second over the window — steady-state ingest. */
  liveRatePerSec: number
  lastHistoricalEventAt: string | null
  lastEventAt: string | null
  windowSeconds: number
  /** Historical import is actively flowing (backfillRatePerSec > 0). */
  backfilling: boolean
  /**
   * Backfill has drained: we've seen ≥1 repo and no historical (live:false)
   * event landed in the window. Inferred from the stream draining, which is
   * robust to quiet repos (unlike reposCaughtUp). A stalled ingester (Tab down)
   * also reads as drained — pair with `lastHistoricalEventAt` to disambiguate.
   */
  complete: boolean
}

interface EventAgg {
  [key: string]: unknown
  collection: string
  repos_seen: string
  repos_caught_up: string
  hist_window: string
  live_window: string
  last_historical: string | Date | null
  last_event: string | Date | null
}

interface RecordAgg {
  [key: string]: unknown
  collection: string
  archived: string
  total: string
}

/**
 * Backfill progress, computed on read from the event log + records (no stored
 * job state). One entry per collection; pass `collection` to scope to one.
 *
 * The `live` flag Tab sets at the historical→live cutover is the oracle here:
 * a high `backfillRatePerSec` means history is still importing; when it drains
 * to zero the backfill is done. See LAB-34 for why the network-wide denominator
 * (`reposTotal`) can't be sourced today.
 */
export async function backfillStatus(
  db: Db,
  opts: { collection?: string; windowSeconds?: number } = {},
): Promise<BackfillStatus[]> {
  const win = clampWindow(opts.windowSeconds)
  const filter = opts.collection ? sql`WHERE collection = ${opts.collection}` : sql``
  const windowStart = sql`now() - (${win} * interval '1 second')`

  const events = await db.execute<EventAgg>(sql`
    SELECT collection,
      count(DISTINCT did) AS repos_seen,
      count(DISTINCT did) FILTER (WHERE live) AS repos_caught_up,
      count(*) FILTER (WHERE NOT live AND created_at > ${windowStart}) AS hist_window,
      count(*) FILTER (WHERE live AND created_at > ${windowStart}) AS live_window,
      max(created_at) FILTER (WHERE NOT live) AS last_historical,
      max(created_at) AS last_event
    FROM events
    ${filter}
    GROUP BY collection
  `)

  const records = await db.execute<RecordAgg>(sql`
    SELECT collection,
      count(*) FILTER (WHERE deleted_at IS NULL) AS archived,
      count(*) AS total
    FROM records
    ${filter}
    GROUP BY collection
  `)

  const recordsByCollection = new Map(records.map((r) => [r.collection, r]))
  const collections = new Set<string>([...events.map((e) => e.collection), ...records.map((r) => r.collection)])
  if (opts.collection) collections.add(opts.collection) // always return the asked-for collection, even if empty

  const eventsByCollection = new Map(events.map((e) => [e.collection, e]))

  return [...collections].sort().map((collection) => {
    const e = eventsByCollection.get(collection)
    const r = recordsByCollection.get(collection)
    const reposSeen = num(e?.repos_seen)
    const backfillRatePerSec = round(num(e?.hist_window) / win)

    return {
      collection,
      recordsArchived: num(r?.archived),
      recordsIncludingDeleted: num(r?.total),
      reposSeen,
      reposCaughtUp: num(e?.repos_caught_up),
      reposTotal: null,
      backfillRatePerSec,
      liveRatePerSec: round(num(e?.live_window) / win),
      lastHistoricalEventAt: iso(e?.last_historical),
      lastEventAt: iso(e?.last_event),
      windowSeconds: win,
      backfilling: backfillRatePerSec > 0,
      complete: reposSeen > 0 && backfillRatePerSec === 0,
    }
  })
}

function clampWindow(raw: number | undefined): number {
  const n = Number(raw ?? DEFAULT_WINDOW_SECONDS)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WINDOW_SECONDS
  return Math.min(Math.floor(n), MAX_WINDOW_SECONDS)
}

function num(raw: string | undefined | null): number {
  return raw == null ? 0 : Number(raw)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}
