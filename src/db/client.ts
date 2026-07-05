import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>['db']

export interface DbOptions {
  /**
   * Per-connection `statement_timeout` in ms — bounds a pathological query so it
   * can't pin a connection (LAB-52). Scoped to the caller: the runtime API/ingest
   * client sets it; migrations and maintenance scripts create their own untimed
   * client so long index builds / bulk sweeps aren't cut off.
   */
  statementTimeoutMs?: number
}

export function createDb(databaseUrl: string, options: DbOptions = {}) {
  const connection =
    options.statementTimeoutMs && options.statementTimeoutMs > 0
      ? { statement_timeout: options.statementTimeoutMs }
      : undefined
  const client = postgres(databaseUrl, { onnotice: () => {}, connection })
  const db = drizzle(client, { schema })
  return { db, client }
}
