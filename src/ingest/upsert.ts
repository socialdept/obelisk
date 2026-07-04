import { and, eq } from 'drizzle-orm'
import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { events, recordLinks, recordTypes, records } from '../db/schema'
import { applyInteractionDeltas, contribution, readContribution, trackedPaths } from '../ranking/interactions'
import { extractLinks } from './links'
import { extractTypes } from './types'

/** A record event as delivered by Tap/Tab. Parsed tolerantly — see normalizeEvent. */
export interface RecordEvent {
  type: string
  did: string
  collection: string
  rkey: string
  action: 'create' | 'update' | 'delete'
  record: Record<string, unknown> | null
  cid: string | null
  rev: string | null
  live: boolean
}

export type UpsertResult = 'applied' | 'skipped'

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Idempotently apply a single Tap/Tab record event.
 * Safe under at-least-once redelivery: an event with a rev not newer
 * than the stored row is a no-op.
 */
export async function applyEvent(
  tx: Tx,
  config: ObeliskConfig,
  event: RecordEvent,
): Promise<UpsertResult> {
  if (event.type !== 'record') return 'skipped'

  const existing = await tx
    .select({ id: records.id, rev: records.rev, cid: records.cid, deletedAt: records.deletedAt })
    .from(records)
    .where(
      and(
        eq(records.did, event.did),
        eq(records.collection, event.collection),
        eq(records.rkey, event.rkey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])

  if (existing && existing.rev && event.rev && event.rev <= existing.rev) return 'skipped'

  // Interaction rollup (LAB-39): capture the record's OLD contribution before the
  // links are replaced. Only for collections that appear in a ranking spec.
  const paths = trackedPaths(config, event.collection)
  const oldContribution =
    paths.size > 0 && existing && existing.deletedAt === null
      ? await readContribution(tx, existing.id, event.collection, paths)
      : []

  const result =
    event.action === 'delete'
      ? await applyDelete(tx, event, existing?.id)
      : await applyWrite(tx, config, event, existing)

  if (paths.size > 0) {
    // A deleted record contributes nothing; a written one contributes its links.
    const newContribution =
      event.action === 'delete' ? [] : contribution(event.collection, extractLinks(event.record ?? {}), paths)
    await applyInteractionDeltas(tx, oldContribution, newContribution)
  }

  return result
}

async function applyDelete(tx: Tx, event: RecordEvent, existingId?: number): Promise<UpsertResult> {
  let recordId = existingId
  if (recordId) {
    await tx
      .update(records)
      .set({ deletedAt: new Date(), rev: event.rev })
      .where(eq(records.id, recordId))
  } else {
    // Delete for a record we never saw — store a tombstone so the deletion is remembered.
    const inserted = await tx
      .insert(records)
      .values({
        did: event.did,
        collection: event.collection,
        rkey: event.rkey,
        rev: event.rev,
        deletedAt: new Date(),
      })
      .returning({ id: records.id })
    recordId = inserted[0]!.id
  }

  await logEvent(tx, recordId, event)
  return 'applied'
}

async function applyWrite(
  tx: Tx,
  config: ObeliskConfig,
  event: RecordEvent,
  existing: { id: number; cid: string | null } | undefined,
): Promise<UpsertResult> {
  const contentChanged = !existing || existing.cid !== event.cid

  // Every changed record goes through the extraction worker — whether it has
  // prose is decided there from the collection's lexicon, not config.
  const row = {
    cid: event.cid,
    rev: event.rev,
    record: event.record ?? {},
    deletedAt: null,
    indexedAt: new Date(),
    ...(contentChanged && { embedStatus: 'pending', embedAttempts: 0 }),
  }

  let recordId: number
  if (existing) {
    await tx.update(records).set(row).where(eq(records.id, existing.id))
    recordId = existing.id
  } else {
    const inserted = await tx
      .insert(records)
      .values({ did: event.did, collection: event.collection, rkey: event.rkey, ...row })
      .returning({ id: records.id })
    recordId = inserted[0]!.id
  }

  await replaceLinks(tx, recordId, event.record)
  await replaceTypes(tx, recordId, event.record)
  await logEvent(tx, recordId, event)
  return 'applied'
}

/** Append to the event log — same transaction, so consumers only ever see applied changes. */
async function logEvent(tx: Tx, recordId: number, event: RecordEvent): Promise<void> {
  await tx.insert(events).values({
    recordId,
    did: event.did,
    collection: event.collection,
    rkey: event.rkey,
    action: event.action,
    rev: event.rev,
    live: event.live,
  })
}

async function replaceLinks(tx: Tx, recordId: number, record: Record<string, unknown> | null): Promise<void> {
  await tx.delete(recordLinks).where(eq(recordLinks.recordId, recordId))

  const links = extractLinks(record ?? {})
  if (links.length === 0) return

  await tx.insert(recordLinks).values(links.map((link) => ({ recordId, ...link })))
}

async function replaceTypes(tx: Tx, recordId: number, record: Record<string, unknown> | null): Promise<void> {
  await tx.delete(recordTypes).where(eq(recordTypes.recordId, recordId))

  const types = extractTypes(record ?? {})
  if (types.length === 0) return

  await tx.insert(recordTypes).values(types.map((type) => ({ recordId, ...type })))
}
