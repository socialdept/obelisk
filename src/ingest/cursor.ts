import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { Tx } from './batch-applier'

/**
 * Ingest position for sources with no ack channel.
 *
 * Kept separate from the driver so the zero case is testable: seq 0 is a real
 * position, and a falsy check would report "never ran" and silently restart
 * from live, skipping everything in between.
 */
export async function loadCursor(db: Db, source: string): Promise<number | null> {
  const rows = (await db.execute(
    sql`SELECT cursor FROM ingest_cursor WHERE source = ${source}`,
  )) as unknown as { cursor: string | number }[]

  const value = rows[0]?.cursor
  return value === undefined || value === null ? null : Number(value)
}

/** Upserts the position. Call inside the batch transaction, never after it. */
export async function saveCursor(tx: Tx, source: string, cursor: number): Promise<void> {
  await tx.execute(
    sql`INSERT INTO ingest_cursor (source, cursor, updated_at)
        VALUES (${source}, ${cursor}, now())
        ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
  )
}
