import { sql } from 'drizzle-orm'
import { loadEnv } from '../src/config'
import { createDb } from '../src/db/client'

const env = loadEnv()
const { db, client } = createDb(env.databaseUrl)

const result = await db.execute(sql`
  UPDATE records SET embed_status = 'pending', embed_attempts = 0
  WHERE embed_status = 'failed'
`)

console.log(`reset ${result.count ?? 0} failed records to pending`)
await client.end()
