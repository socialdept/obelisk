import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { coldDids, coldPdses, didPds, recordEmbeddings, records, type ColdDidRow, type ColdPdsRow } from '../db/schema'
import { invalid, notFound, type ManageResult } from '../webhooks/manage'
import { globToRegExp } from './pds-blocklist'
import { resolvePds as resolvePdsDefault } from '../lexicon/resolver'

const DEFAULT_TTL_MS = 86_400_000 // 24h

/**
 * Cold-storage DID set (LAB-68). A cold DID is still archived and keyword-
 * searchable — its records just skip embedding (no vector index → no semantic
 * search, and no CPU/$ spent embedding it). Held as one shared instance: the
 * ingester reads it to decide `embed_status`, the management procedures mutate
 * the DB **and** this set so a change takes effect on the next event, no reload.
 */
export class ColdList {
  private dids = new Set<string>()

  has(did: string): boolean {
    return this.dids.has(did)
  }

  get size(): number {
    return this.dids.size
  }

  addLocal(did: string): void {
    this.dids.add(did)
  }

  removeLocal(did: string): void {
    this.dids.delete(did)
  }

  async load(db: Db): Promise<void> {
    const rows = await db.select({ did: coldDids.did }).from(coldDids)
    this.dids = new Set(rows.map((r) => r.did))
  }
}

type ResolveFn = (did: string) => Promise<string>
interface Decision {
  pds: string | null
  expiresAt: number
}

/**
 * Cold-storage PDS deny-list (LAB-68) — the PDS-pattern analogue of {@link ColdList}.
 * Mirrors PdsBlocklist: Tab events carry only the DID, so a cold PDS means
 * resolving each DID's PDS (cached in `did_pds` on a TTL) and matching it against
 * the wildcard patterns. The ingester pre-resolves a batch (`ensureDecided`, async)
 * so the per-event check (`isCold`) stays sync.
 *
 * NOTE: this is forward-only — it cools *new/changed* records from a matching PDS
 * at ingest. Already-archived records from a newly-cooled PDS are not retroactively
 * swept (that would mean resolving every archived DID's PDS). DID-level cooling
 * (`coldDid`) is retroactive; PDS-level is not.
 */
export class ColdPdsList {
  private patterns: RegExp[] = []
  private decisions = new Map<string, Decision>()

  constructor(
    private readonly db: Db,
    private readonly resolve: ResolveFn = (did) => resolvePdsDefault(did),
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  hasPatterns(): boolean {
    return this.patterns.length > 0
  }

  matchesPds(pds: string | null): boolean {
    if (!pds) return false
    const normalized = pds.replace(/\/+$/, '')
    return this.patterns.some((re) => re.test(normalized))
  }

  /** Sync per-event check — valid once `ensureDecided` has pre-resolved the DID. */
  isCold(did: string): boolean {
    const decision = this.decisions.get(did)
    return decision ? this.matchesPds(decision.pds) : false
  }

  async loadPatterns(): Promise<void> {
    const rows = await this.db.select({ pattern: coldPdses.pattern }).from(coldPdses)
    this.patterns = rows.map((r) => globToRegExp(r.pattern))
  }

  /** Pre-resolve a batch's DIDs before the ingest tx. No-op when no patterns exist. */
  async ensureDecided(dids: Iterable<string>): Promise<void> {
    if (!this.hasPatterns()) return
    for (const did of dids) {
      const existing = this.decisions.get(did)
      if (existing && existing.expiresAt > Date.now()) continue
      const pds = await this.resolveCached(did)
      this.decisions.set(did, { pds, expiresAt: Date.now() + this.ttlMs })
    }
  }

  private async resolveCached(did: string): Promise<string | null> {
    const rows = await this.db.select().from(didPds).where(eq(didPds.did, did)).limit(1)
    const cached = rows[0]
    if (cached && Date.now() - cached.resolvedAt.getTime() < this.ttlMs) return cached.pds

    let pds: string | null = null
    try {
      pds = await this.resolve(did)
    } catch {
      pds = null
    }
    await this.db
      .insert(didPds)
      .values({ did, pds })
      .onConflictDoUpdate({ target: didPds.did, set: { pds, resolvedAt: new Date() } })
    return pds
  }
}

// ── DID management ──────────────────────────────────────────────────────────

interface ColdDidInput {
  did?: string
  note?: string | null
}

export function serializeColdDid(row: ColdDidRow) {
  return { did: row.did, note: row.note, addedAt: row.addedAt }
}

export async function listColdDids(db: Db) {
  const rows = await db.select().from(coldDids).orderBy(desc(coldDids.addedAt))
  return rows.map(serializeColdDid)
}

/**
 * Cool a DID: future records skip embedding, and existing records are marked cold
 * + their embeddings purged to reclaim vector storage. Adds to the table and the
 * in-memory set. Returns how many records were cooled and embeddings dropped.
 */
export async function coldDid(db: Db, cold: ColdList, input: ColdDidInput): Promise<ManageResult<object>> {
  if (!input.did) return invalid('did is required')

  await db
    .insert(coldDids)
    .values({ did: input.did, note: input.note ?? null })
    .onConflictDoUpdate({ target: coldDids.did, set: { note: input.note ?? null } })
  cold.addLocal(input.did)

  // Reclaim embeddings for records we already have, then flag them cold + skipped.
  const purged = await db
    .delete(recordEmbeddings)
    .where(inArray(recordEmbeddings.recordId, db.select({ id: records.id }).from(records).where(eq(records.did, input.did))))
    .returning({ id: recordEmbeddings.id })
  const cooled = await db
    .update(records)
    .set({ cold: true, embedStatus: 'skipped', embedAttempts: 0 })
    .where(and(eq(records.did, input.did), eq(records.cold, false)))
    .returning({ id: records.id })

  return { data: { cold: input.did, cooled: cooled.length, embeddingsPurged: purged.length } }
}

/**
 * Un-cool a DID: existing records clear the cold flag and are re-queued for
 * embedding (the worker re-embeds those with prose, marks the rest skipped).
 */
export async function unColdDid(db: Db, cold: ColdList, did: string | undefined): Promise<ManageResult<object>> {
  if (!did) return invalid('did is required')
  const deleted = await db.delete(coldDids).where(eq(coldDids.did, did)).returning()
  if (deleted.length === 0) return notFound('did is not cold')
  cold.removeLocal(did)

  const requeued = await db
    .update(records)
    .set({ cold: false, embedStatus: 'pending', embedAttempts: 0 })
    .where(and(eq(records.did, did), isNull(records.deletedAt)))
    .returning({ id: records.id })

  return { data: { warmed: did, requeued: requeued.length } }
}

// ── PDS management ──────────────────────────────────────────────────────────

interface ColdPdsInput {
  pattern?: string
  note?: string | null
}

export function serializeColdPds(row: ColdPdsRow) {
  return { pattern: row.pattern, note: row.note, addedAt: row.addedAt }
}

export async function listColdPdses(db: Db) {
  const rows = await db.select().from(coldPdses).orderBy(desc(coldPdses.addedAt))
  return rows.map(serializeColdPds)
}

/** Cool a PDS pattern (forward-only). Reloads patterns on the shared instance. */
export async function coldPds(db: Db, cold: ColdPdsList, input: ColdPdsInput): Promise<ManageResult<object>> {
  if (!input.pattern) return invalid('pattern is required')

  await db
    .insert(coldPdses)
    .values({ pattern: input.pattern, note: input.note ?? null })
    .onConflictDoUpdate({ target: coldPdses.pattern, set: { note: input.note ?? null } })
  await cold.loadPatterns()
  return { data: { coldPds: input.pattern } }
}

export async function unColdPds(
  db: Db,
  cold: ColdPdsList,
  pattern: string | undefined,
): Promise<ManageResult<{ warmed: string }>> {
  if (!pattern) return invalid('pattern is required')
  const deleted = await db.delete(coldPdses).where(eq(coldPdses.pattern, pattern)).returning()
  if (deleted.length === 0) return notFound('pds pattern is not cold')
  await cold.loadPatterns()
  return { data: { warmed: pattern } }
}
