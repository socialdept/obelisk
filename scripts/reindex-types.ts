import { asc, eq, gt } from 'drizzle-orm'
import { loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { recordTypes, records } from '../src/db/schema'
import { extractTypes } from '../src/ingest/types'

const env = loadEnv()
const { db, client } = createDb(env.databaseUrl)

let lastId = 0
let processed = 0

for (;;) {
  const batch = await db
    .select({ id: records.id, record: records.record })
    .from(records)
    .where(gt(records.id, lastId))
    .orderBy(asc(records.id))
    .limit(500)
  if (batch.length === 0) break

  await db.transaction(async (tx) => {
    for (const row of batch) {
      await tx.delete(recordTypes).where(eq(recordTypes.recordId, row.id))
      const types = extractTypes(row.record)
      if (types.length > 0) {
        await tx.insert(recordTypes).values(types.map((type) => ({ recordId: row.id, ...type })))
      }
    }
  })

  lastId = batch.at(-1)!.id
  processed += batch.length
  console.log(`reindexed ${processed} records`)
}

console.log('done')
await client.end()
