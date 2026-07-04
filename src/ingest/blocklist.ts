import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { blockedDids, records, type BlockedDidRow } from '../db/schema'
import type { ManageResult } from '../webhooks/manage'

/**
 * In-memory deny-list of DIDs whose records are never archived (LAB-47). Held as
 * one shared instance across the process: the ingester reads it (skips a blocked
 * DID's events at apply time), the management procedures mutate the DB **and**
 * this set so a block takes effect on the next event with no reload lag.
 */
export class Blocklist {
  private dids = new Set<string>()

  has(did: string): boolean {
    return this.dids.has(did)
  }

  /** The live set — pass to `applyEvent` for the per-event skip check. */
  snapshot(): Set<string> {
    return this.dids
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

  /** (Re)load from the table — called once at boot. */
  async load(db: Db): Promise<void> {
    const rows = await db.select({ did: blockedDids.did }).from(blockedDids)
    this.dids = new Set(rows.map((r) => r.did))
  }
}

interface BlockInput {
  did?: string
  note?: string | null
  /** Also remove the DID's already-archived records. */
  purge?: boolean
  /** With purge: hard-DELETE (cascades) instead of soft-delete. Irreversible. */
  force?: boolean
}

export function serializeBlocked(row: BlockedDidRow) {
  return { did: row.did, note: row.note, addedAt: row.addedAt }
}

export async function listBlocked(db: Db) {
  const rows = await db.select().from(blockedDids).orderBy(desc(blockedDids.addedAt))
  return rows.map(serializeBlocked)
}

/**
 * Block a DID from future archiving (+ optional purge of existing records). Adds
 * to the table and the in-memory set. `purge` soft-deletes the DID's records
 * (recoverable); `purge + force` hard-deletes them (cascades to events/links/
 * embeddings/types). Returns how many were removed.
 *
 * Note: a bulk purge bypasses the app-level interaction_counts maintenance — run
 * scripts/rebuild-interactions.ts afterward if ranking uses this DID's links.
 */
export async function blockDid(db: Db, blocklist: Blocklist, input: BlockInput): Promise<ManageResult<object>> {
  if (!input.did) return invalid('did is required')

  await db
    .insert(blockedDids)
    .values({ did: input.did, note: input.note ?? null })
    .onConflictDoUpdate({ target: blockedDids.did, set: { note: input.note ?? null } })
  blocklist.addLocal(input.did)

  let purged = 0
  if (input.purge && input.force) {
    const deleted = await db.delete(records).where(eq(records.did, input.did)).returning({ id: records.id })
    purged = deleted.length
  } else if (input.purge) {
    const updated = await db
      .update(records)
      .set({ deletedAt: new Date() })
      .where(and(eq(records.did, input.did), isNull(records.deletedAt)))
      .returning({ id: records.id })
    purged = updated.length
  }

  const mode = input.purge ? (input.force ? 'hard-delete' : 'soft-delete') : 'block-only'
  return { data: { blocked: input.did, purged, mode } }
}

export async function unblockDid(
  db: Db,
  blocklist: Blocklist,
  did: string | undefined,
): Promise<ManageResult<{ unblocked: string }>> {
  if (!did) return invalid('did is required')
  const deleted = await db.delete(blockedDids).where(eq(blockedDids.did, did)).returning()
  if (deleted.length === 0) return notFound()
  blocklist.removeLocal(did)
  return { data: { unblocked: did } }
}

const invalid = (message: string) => ({ error: 'InvalidRequest', message, status: 400 as const })
const notFound = () => ({ error: 'NotFound', message: 'did is not blocked', status: 404 as const })
