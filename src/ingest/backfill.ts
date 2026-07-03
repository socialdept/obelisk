import { fromUint8Array as carRead } from '@atcute/car'
import { decode as cborDecode } from '@atcute/cbor'
import { toString as cidToString } from '@atcute/cid'
import { fromUint8Array as repoRead } from '@atcute/repo'
import { eq, sql } from 'drizzle-orm'
import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { watchedDids } from '../db/schema'
import { resolvePds } from '../lexicon/resolver'
import { applyEvent, type RecordEvent } from './upsert'

/** One record pulled from a repo CAR — already decoded to atproto-JSON. */
export interface RepoRecord {
  collection: string
  rkey: string
  cid: string
  record: Record<string, unknown>
}

export interface BackfillResult {
  did: string
  rev: string
  total: number
  applied: number
  skipped: number
  byCollection: Record<string, number>
}

export interface BackfillDeps {
  /** DID → PDS endpoint. Defaults to the DID-document resolver. */
  resolvePds?: (did: string) => Promise<string>
  /** PDS + DID → repo CAR bytes. Defaults to com.atproto.sync.getRepo. */
  fetchCar?: (pds: string, did: string) => Promise<Uint8Array>
  /** CAR bytes → commit rev. Defaults to reading the CAR root commit block. */
  readRev?: (bytes: Uint8Array) => string
  /** CAR bytes → record entries. Defaults to @atcute/repo. */
  readEntries?: (bytes: Uint8Array) => Iterable<RepoRecord>
  batchSize?: number
  onProgress?: (done: number, applied: number) => void
}

const USER_AGENT = 'obelisk (miguel)'

/**
 * One-shot full-repo import for a DID: fetch the current repo as a CAR and upsert
 * every record across *every* collection through the existing `applyEvent` path —
 * so a snapshot lands in the archive exactly as if the firehose had delivered it
 * (same links/types extraction, same `embed_status='pending'`).
 *
 * Idempotent by construction: every record is stamped with the repo's commit
 * `rev`, so a re-run is a no-op (rev-compare) and a *newer* live event always
 * wins over the snapshot — a forward delete is never resurrected. Independent of
 * the network-wide collection filter: works for any DID, any collection.
 *
 * If the DID is in `watched_dids`, `snapshot_at` is stamped on success (this is
 * the "deleted coverage starts here" bound surfaced by getFootprint).
 */
export async function backfillRepo(
  db: Db,
  config: ObeliskConfig,
  did: string,
  deps: BackfillDeps = {},
): Promise<BackfillResult> {
  const pds = await (deps.resolvePds ?? resolvePds)(did)
  const bytes = await (deps.fetchCar ?? defaultFetchCar)(pds, did)
  const rev = (deps.readRev ?? readCommitRev)(bytes)
  const entries = (deps.readEntries ?? defaultReadEntries)(bytes)

  const batchSize = deps.batchSize ?? 200
  const byCollection: Record<string, number> = {}
  let total = 0
  let applied = 0
  let skipped = 0
  let batch: RecordEvent[] = []

  const flush = async () => {
    if (batch.length === 0) return
    const events = batch
    batch = []
    await db.transaction(async (tx) => {
      for (const event of events) {
        const result = await applyEvent(tx, config, event)
        if (result === 'applied') applied += 1
        else skipped += 1
      }
    })
    deps.onProgress?.(total, applied)
  }

  for (const entry of entries) {
    total += 1
    byCollection[entry.collection] = (byCollection[entry.collection] ?? 0) + 1
    batch.push({
      type: 'record',
      did,
      collection: entry.collection,
      rkey: entry.rkey,
      action: 'create',
      record: entry.record,
      cid: entry.cid,
      rev,
      live: false,
    })
    if (batch.length >= batchSize) await flush()
  }
  await flush()

  // Mark the snapshot time for a watched DID (no-op if not watched).
  await db.update(watchedDids).set({ snapshotAt: sql`now()` }).where(eq(watchedDids.did, did))

  return { did, rev, total, applied, skipped, byCollection }
}

async function defaultFetchCar(pds: string, did: string): Promise<Uint8Array> {
  const url = `${pds}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`getRepo ${did} → ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Commit rev = the `rev` on the CAR's root commit block. */
export function readCommitRev(bytes: Uint8Array): string {
  const car = carRead(bytes)
  const rootLink = car.roots[0]?.$link
  if (!rootLink) throw new Error('CAR has no root')
  for (const entry of car) {
    if (cidToString(entry.cid) !== rootLink) continue
    const commit = cborDecode(entry.bytes) as { rev?: string }
    if (typeof commit.rev === 'string') return commit.rev
    break
  }
  throw new Error('no commit rev in CAR root')
}

function* defaultReadEntries(bytes: Uint8Array): Iterable<RepoRecord> {
  for (const entry of repoRead(bytes)) {
    yield {
      collection: entry.collection,
      rkey: entry.rkey,
      cid: entry.cid.$link,
      record: entry.record as Record<string, unknown>,
    }
  }
}
