import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { blockedPdses, didPds, type BlockedPdsRow } from '../db/schema'
import { resolvePds as resolvePdsDefault } from '../lexicon/resolver'
import type { ManageResult } from '../webhooks/manage'

const DEFAULT_TTL_MS = 86_400_000 // 24h

/** Strip a trailing slash so `https://x/` and `https://x` compare equal. */
function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * A `*`-glob pattern (e.g. `https://*.pds.host`) → an anchored, case-insensitive
 * RegExp over the (slash-normalized) PDS URL. All other regex metacharacters are
 * escaped, so `*` is the only wildcard.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = stripSlash(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

type ResolveFn = (did: string) => Promise<string>
interface Decision {
  pds: string | null
  expiresAt: number
}

/**
 * Ingest-time PDS deny-list (LAB-48). Tab events carry only the DID, so blocking
 * a PDS means resolving each DID's PDS (via the DID doc, cached in `did_pds` on a
 * TTL) and matching it against the wildcard patterns.
 *
 * The ingester pre-resolves a batch's DIDs (`ensureDecided`, async) so the
 * per-event check (`isBlocked`) stays sync. `isBlocked` recomputes the pattern
 * match from the cached PDS, so adding/removing a pattern needs only a
 * `loadPatterns` — no decision-cache clear. Resolution failure caches `null`
 * (→ allow), retried after the TTL.
 */
export class PdsBlocklist {
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
    const normalized = stripSlash(pds)
    return this.patterns.some((re) => re.test(normalized))
  }

  /** Sync per-event check — valid once `ensureDecided` has pre-resolved the DID. */
  isBlocked(did: string): boolean {
    const decision = this.decisions.get(did)
    return decision ? this.matchesPds(decision.pds) : false
  }

  /** (Re)load + compile patterns from the table. */
  async loadPatterns(): Promise<void> {
    const rows = await this.db.select({ pattern: blockedPdses.pattern }).from(blockedPdses)
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

  /** DID → PDS via the `did_pds` cache (within TTL) then network; failure → null. */
  private async resolveCached(did: string): Promise<string | null> {
    const rows = await this.db.select().from(didPds).where(eq(didPds.did, did)).limit(1)
    const cached = rows[0]
    if (cached && Date.now() - cached.resolvedAt.getTime() < this.ttlMs) return cached.pds

    let pds: string | null = null
    try {
      pds = await this.resolve(did)
    } catch {
      pds = null // allow on resolution failure; retried after the TTL
    }
    await this.db
      .insert(didPds)
      .values({ did, pds })
      .onConflictDoUpdate({ target: didPds.did, set: { pds, resolvedAt: new Date() } })
    return pds
  }
}

interface BlockPdsInput {
  pattern?: string
  note?: string | null
}

export function serializeBlockedPds(row: BlockedPdsRow) {
  return { pattern: row.pattern, note: row.note, addedAt: row.addedAt }
}

export async function listBlockedPds(db: Db) {
  const rows = await db.select().from(blockedPdses).orderBy(desc(blockedPdses.addedAt))
  return rows.map(serializeBlockedPds)
}

/** Block a PDS pattern from future archiving. Reloads patterns on the shared instance. */
export async function blockPds(db: Db, blocklist: PdsBlocklist, input: BlockPdsInput): Promise<ManageResult<object>> {
  if (!input.pattern) return invalid('pattern is required')

  await db
    .insert(blockedPdses)
    .values({ pattern: input.pattern, note: input.note ?? null })
    .onConflictDoUpdate({ target: blockedPdses.pattern, set: { note: input.note ?? null } })
  await blocklist.loadPatterns()
  return { data: { blockedPds: input.pattern } }
}

export async function unblockPds(
  db: Db,
  blocklist: PdsBlocklist,
  pattern: string | undefined,
): Promise<ManageResult<{ unblocked: string }>> {
  if (!pattern) return invalid('pattern is required')
  const deleted = await db.delete(blockedPdses).where(eq(blockedPdses.pattern, pattern)).returning()
  if (deleted.length === 0) return notFound()
  await blocklist.loadPatterns()
  return { data: { unblocked: pattern } }
}

const invalid = (message: string) => ({ error: 'InvalidRequest', message, status: 400 as const })
const notFound = () => ({ error: 'NotFound', message: 'pds pattern is not blocked', status: 404 as const })
