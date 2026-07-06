import { fromStream as repoFromStream } from '@atcute/repo'
import { eq, sql } from 'drizzle-orm'
import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { watchedDids } from '../db/schema'
import { resolvePds } from '../lexicon/resolver'
import { globToRegExp } from './pds-blocklist'
import { applyEvent, type ApplyOptions, type RecordEvent } from './upsert'

/**
 * A predicate matching the collections the archive keeps (LAB-68 follow-up):
 * `config.collectionFilters` globs if set, else the explicit `collections` keys.
 * Used to scope a repo backfill so it doesn't import unrelated collections.
 */
export function collectionFilter(config: ObeliskConfig): (nsid: string) => boolean {
  const globs = config.collectionFilters?.length ? config.collectionFilters : Object.keys(config.collections)
  const res = globs.map(globToRegExp)
  return (nsid) => res.some((re) => re.test(nsid))
}

/** One record pulled from a repo CAR — already decoded to atproto-JSON. */
export interface RepoRecord {
  collection: string
  rkey: string
  cid: string
  record: Record<string, unknown>
}

export interface BackfillResult {
  did: string
  /** The repo commit rev (getRepo path), or null when imported via listRecords. */
  rev: string | null
  total: number
  applied: number
  skipped: number
  /** Records dropped by the `collections` filter (not in the wanted set). */
  filtered: number
  byCollection: Record<string, number>
}

export interface BackfillDeps {
  /** DID → PDS endpoint. Defaults to the DID-document resolver. */
  resolvePds?: (did: string) => Promise<string>
  /** DID's current commit rev. Defaults to com.atproto.sync.getLatestCommit. */
  fetchRev?: (pds: string, did: string) => Promise<string>
  /**
   * Stream the repo's records. Defaults to com.atproto.sync.getRepo parsed as a
   * streamed CAR (@atcute/repo `fromStream`) — records are yielded incrementally
   * so memory stays bounded regardless of repo size (LAB-57). Accepts a plain
   * iterable too (tests inject an array).
   */
  openRepo?: (pds: string, did: string) => AsyncIterable<RepoRecord> | Iterable<RepoRecord>
  batchSize?: number
  onProgress?: (done: number, applied: number) => void
  /**
   * Keep only records whose collection matches — records are skipped as they
   * stream, before any DB work. Defaults to importing every collection (whole
   * repo). Pass `collectionFilter(config)` to scope to the wanted set.
   */
  collections?: (nsid: string) => boolean
  /**
   * Forwarded to `applyEvent` per record. Backfill deliberately omits `skipDid`
   * (it recovers even a blocked repo), but should set `coldDid` so a re-imported
   * cold repo isn't embedded.
   */
  applyOptions?: ApplyOptions
  /** Override repo-collection discovery for the listRecords fallback (tests). */
  describeCollections?: (pds: string, did: string) => Promise<string[]>
  /** Override the listRecords fallback source (tests). */
  listRecordsSource?: (pds: string, did: string, collections: string[]) => AsyncIterable<RepoRecord>
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
  const openRepo = deps.openRepo ?? defaultOpenRepo

  // Preferred path: getRepo streams the whole repo in one CAR. But bridge PDSes
  // (atproto.brid.gy) and relays don't implement getRepo/getLatestCommit — they
  // answer 501. Fall back to paging com.atproto.repo.listRecords per collection,
  // which every readable host serves (it's how a single record is fetched).
  try {
    const rev = await (deps.fetchRev ?? fetchLatestRev)(pds, did)
    return await applyStream(db, config, did, rev, openRepo(pds, did), deps)
  } catch (err) {
    if (!isUnsupported(err)) throw err
    const collections = await filteredCollections(pds, did, config, deps)
    const source = deps.listRecordsSource ?? listRecordsSource
    return applyStream(db, config, did, null, source(pds, did, collections), deps)
  }
}

/** Apply a stream of repo records in batched transactions, honoring the collection filter. */
async function applyStream(
  db: Db,
  config: ObeliskConfig,
  did: string,
  rev: string | null,
  entries: AsyncIterable<RepoRecord> | Iterable<RepoRecord>,
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const batchSize = deps.batchSize ?? 200
  const byCollection: Record<string, number> = {}
  let total = 0
  let applied = 0
  let skipped = 0
  let filtered = 0
  let batch: RecordEvent[] = []

  const flush = async () => {
    if (batch.length === 0) return
    const events = batch
    batch = []
    await db.transaction(async (tx) => {
      for (const event of events) {
        const result = await applyEvent(tx, config, event, deps.applyOptions)
        if (result === 'applied') applied += 1
        else skipped += 1
      }
    })
    deps.onProgress?.(total, applied)
  }

  for await (const entry of entries) {
    if (deps.collections && !deps.collections(entry.collection)) {
      filtered += 1
      continue
    }
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

  return { did, rev, total, applied, skipped, filtered, byCollection }
}

/** A 501 (Not Implemented) from getRepo/getLatestCommit — the host can't serve a repo export. */
function isUnsupported(err: unknown): boolean {
  return err instanceof Error && err.message.includes('→ 501')
}

/** The repo's collections (describeRepo → configured-keys fallback), filtered to the wanted set. */
async function filteredCollections(
  pds: string,
  did: string,
  config: ObeliskConfig,
  deps: BackfillDeps,
): Promise<string[]> {
  const discover = deps.describeCollections ?? describeRepoCollections
  const found = await discover(pds, did).catch(() => [] as string[])
  const all = found.length ? found : Object.keys(config.collections)
  return deps.collections ? all.filter(deps.collections) : all
}

async function describeRepoCollections(pds: string, did: string): Promise<string[]> {
  const url = `${pds.replace(/\/+$/, '')}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`describeRepo ${did} → ${res.status}`)
  const body = (await res.json()) as { collections?: string[] }
  return body.collections ?? []
}

/** Page com.atproto.repo.listRecords for each collection — the getRepo-less fetch path. */
async function* listRecordsSource(pds: string, did: string, collections: string[]): AsyncIterable<RepoRecord> {
  const base = pds.replace(/\/+$/, '')
  for (const collection of collections) {
    let cursor: string | undefined
    do {
      const url = new URL(`${base}/xrpc/com.atproto.repo.listRecords`)
      url.searchParams.set('repo', did)
      url.searchParams.set('collection', collection)
      url.searchParams.set('limit', '100')
      if (cursor) url.searchParams.set('cursor', cursor)
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!res.ok) throw new Error(`listRecords ${did} ${collection} → ${res.status}`)
      const body = (await res.json()) as {
        records?: { uri: string; cid: string; value: Record<string, unknown> }[]
        cursor?: string
      }
      for (const rec of body.records ?? []) {
        yield { collection, rkey: rec.uri.split('/').pop() ?? '', cid: rec.cid, record: rec.value }
      }
      cursor = body.cursor
    } while (cursor)
  }
}

/**
 * The DID's current commit rev, via com.atproto.sync.getLatestCommit — a tiny
 * JSON call, so we don't have to buffer the whole CAR just to read the rev. The
 * streamed repo reader discards the commit block, and getRepo and getLatestCommit
 * report the same head; a write racing between them just yields a newer rev,
 * which the rev-compare upsert handles safely.
 */
async function fetchLatestRev(pds: string, did: string): Promise<string> {
  const url = `${pds}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`getLatestCommit ${did} → ${res.status}`)
  const body = (await res.json()) as { rev?: string }
  if (typeof body.rev !== 'string') throw new Error(`no rev in getLatestCommit for ${did}`)
  return body.rev
}

/**
 * Stream the repo from com.atproto.sync.getRepo and yield records one at a time.
 * `@atcute/repo`'s streamed reader parses the CAR off the HTTP body incrementally,
 * so we never hold the whole repo in memory — a large DID no longer risks OOM on
 * a small box (LAB-57).
 */
async function* defaultOpenRepo(pds: string, did: string): AsyncIterable<RepoRecord> {
  const url = `${pds}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok || !res.body) throw new Error(`getRepo ${did} → ${res.status}`)

  const reader = repoFromStream(res.body)
  try {
    for await (const entry of reader) {
      yield {
        collection: entry.collection,
        rkey: entry.rkey,
        cid: entry.cid.$link,
        record: entry.record as Record<string, unknown>,
      }
    }
  } finally {
    await reader.dispose()
  }
}
