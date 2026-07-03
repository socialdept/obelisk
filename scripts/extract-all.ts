// Populate extracted_title / extracted_text for every record without touching
// embeddings — keeps FTS complete after the generic-FTS migration (0009) or
// any change to extraction rules. Safe to re-run.
import { asc, eq, gt } from 'drizzle-orm'
import { loadConfig, loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { records } from '../src/db/schema'
import { extractFields } from '../src/embed/extract'
import { extractRichText } from '../src/embed/rich'
import { createExtractionResolver } from '../src/lexicon/collection'
import { LexiconRegistry } from '../src/lexicon/registry'
import { createTextKeysResolver } from '../src/lexicon/textkeys'

const env = loadEnv()
const config = await loadConfig()
const { db, client } = createDb(env.databaseUrl)
const lexicons = new LexiconRegistry(db)
const extraction = createExtractionResolver(lexicons, config.collections)
const textKeys = createTextKeysResolver(lexicons)

let lastId = 0
let processed = 0
let withText = 0

for (;;) {
  const batch = await db
    .select({ id: records.id, collection: records.collection, record: records.record })
    .from(records)
    .where(gt(records.id, lastId))
    .orderBy(asc(records.id))
    .limit(500)
  if (batch.length === 0) break

  for (const row of batch) {
    const fields = await extraction(row.collection)
    const recordJson = row.record as Record<string, unknown>

    const title = extractFields(recordJson, fields.titleFields)
    const flat = extractFields(recordJson, fields.textFields)
    const rich = await extractRichText(recordJson, textKeys, fields.richContentFields)
    const body = [flat, rich].filter((part) => part !== '').join('\n\n')

    if (title === '' && body === '') continue
    withText += 1
    await db
      .update(records)
      .set({ extractedTitle: title === '' ? null : title, extractedText: body === '' ? null : body })
      .where(eq(records.id, row.id))
  }

  lastId = batch.at(-1)!.id
  processed += batch.length
  if (processed % 5000 < 500) console.log(`extracted ${withText}/${processed}`)
}

console.log(`done: ${withText} of ${processed} records carry text`)
await client.end()
