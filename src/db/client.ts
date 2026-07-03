import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>['db']

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { onnotice: () => {} })
  const db = drizzle(client, { schema })
  return { db, client }
}
